import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../core/hashing.ts";

/**
 * 档案导出：完整快照（来源版本、blob、分支、提交、候选、裁定、锁定、事件、依赖）。
 * 身份使用语义稳定 ID，删除本地数据库再导入后身份、顺序与来源关系保持。
 */
export function exportArchive(db: DatabaseSync): { manifest: ArchiveManifest; bytes: Uint8Array } {
  const tables = [
    "source_blobs",
    "source_entities",
    "import_batches",
    "branches",
    "commits",
    "candidates",
    "decisions",
    "locked_alignments",
    "ledger_events",
    "dependency_edges",
    "schema_migrations",
    "review_view_states",
    "export_log",
  ];
  const data: Record<string, unknown> = {};
  for (const t of tables) {
    data[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  }
  const payload = JSON.stringify({ format: "tilt-review-archive", formatVersion: 1, data });
  const bytes = new TextEncoder().encode(payload);
  const fingerprint = sha256Hex(bytes);
  const manifest: ArchiveManifest = {
    format: "tilt-review-archive",
    formatVersion: 1,
    fingerprintSha256: fingerprint,
    exportedAt: new Date().toISOString(),
    tableCounts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as unknown[]).length])),
  };
  return { manifest, bytes };
}

export interface ArchiveManifest {
  format: string;
  formatVersion: number;
  fingerprintSha256: string;
  exportedAt: string;
  tableCounts: Record<string, number>;
}

export interface ImportResult { manifest: ArchiveManifest; inserted: Record<string, number> }

/** 导入快照：先验证指纹与悬挂引用，再整体写入（失败回滚，不改半份） */
export function importArchive(db: DatabaseSync, bytes: Uint8Array): ImportResult {
  const fingerprint = sha256Hex(bytes);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    format: string;
    formatVersion: number;
    data: Record<string, any[]>;
  };
  if (parsed.format !== "tilt-review-archive") throw new Error("bad-archive-format");
  const existingCount = db.prepare("SELECT COUNT(*) AS c FROM source_entities").get() as { c: number };
  if (existingCount.c > 0) throw new Error("import-into-nonempty-database");

  db.exec("BEGIN");
  const inserted: Record<string, number> = {};
  try {
    for (const [table, rows] of Object.entries(parsed.data)) {
      if (!rows.length) {
        inserted[table] = 0;
        continue;
      }
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => "?").join(",");
      const stmt = db.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${placeholders})`);
      for (const row of rows) {
        const values = cols.map((c) => {
          const v = (row as Record<string, unknown>)[c];
          return v;
        });
        stmt.run(...values);
      }
      inserted[table] = rows.length;
    }
    assertReferentialIntegrity(db);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return {
    manifest: {
      format: parsed.format,
      formatVersion: parsed.formatVersion,
      fingerprintSha256: fingerprint,
      exportedAt: new Date().toISOString(),
      tableCounts: inserted,
    },
    inserted,
  };
}

/** 引用完整性：候选 -> 提交 -> 来源版本；缺引用即损坏 */
export function assertReferentialIntegrity(db: DatabaseSync): string[] {
  const danglingCandidates = db
    .prepare(
      `SELECT c.candidate_id FROM candidates c
       LEFT JOIN commits cm ON cm.commit_id = c.commit_id WHERE cm.commit_id IS NULL`,
    )
    .all() as { candidate_id: string }[];
  if (danglingCandidates.length) throw new Error(`corrupt-archive: 候选引用缺失提交 ${danglingCandidates[0]!.candidate_id}`);

  const danglingDecisions = db
    .prepare(
      `SELECT d.decision_id FROM decisions d
       LEFT JOIN candidates c ON c.candidate_id = d.candidate_id
       WHERE d.candidate_id IS NOT NULL AND c.candidate_id IS NULL`,
    )
    .all() as { decision_id: string }[];
  if (danglingDecisions.length) throw new Error(`corrupt-archive: 裁定引用缺失候选 ${danglingDecisions[0]!.decision_id}`);

  const danglingLocks = db
    .prepare(
      `SELECT l.lock_id FROM locked_alignments l
       LEFT JOIN candidates c ON c.candidate_id = l.candidate_id WHERE c.candidate_id IS NULL`,
    )
    .all() as { lock_id: string }[];
  if (danglingLocks.length) throw new Error(`corrupt-archive: 锁定引用缺失候选 ${danglingLocks[0]!.lock_id}`);

  const danglingEvents = db
    .prepare(
      `SELECT e.event_id FROM ledger_events e
       LEFT JOIN commits c ON c.commit_id = e.commit_id WHERE c.commit_id IS NULL`,
    )
    .all() as { event_id: string }[];
  if (danglingEvents.length) throw new Error(`corrupt-archive: 事件引用缺失提交 ${danglingEvents[0]!.event_id}`);
}
