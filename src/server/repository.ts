import type { DatabaseSync } from "node:sqlite";
import { sha256Hex, stableId, canonicalJson } from "../core/hashing.ts";
import type {
  AlignmentCandidate,
  BranchRecord,
  CommitRecord,
  DecisionRecord,
  LedgerEvent,
  LockedAlignment,
  SourceBatch,
  SourceEntity,
  SourceKind,
} from "../core/types.ts";

export interface StoredEntity {
  entityId: string;
  kind: SourceKind;
  version: number;
  batchId: string;
  frameId: string | null;
  trackId: string | null;
  payload: SourceEntity;
  contentSha256: string;
  supersedesEntityId: string | null;
  createdAt: string;
  scopeKey: string;
}

export class VersionConflictError extends Error {
  code = "version-conflict";
  constructor(
    public serverParent: string | null,
    public clientParent: string | null,
  ) {
    super(`VERSION_CONFLICT: expected ${clientParent ?? "null"} but head is ${serverParent ?? "null"}`);
  }
}

export class CorruptArchiveError extends Error {
  code = "corrupt-archive";
}

function scopeKeyOf(e: SourceEntity): string {
  switch (e.kind) {
    case "TiltFrame":
      return stableId("scope", "frame", e.frameId);
    case "TiltAngle":
    case "PixelScale":
    case "ExposureDose":
    case "ManualExclusion":
      return stableId("scope", e.kind, e.frameId);
    case "MarkerObservation":
      return stableId("scope", "marker", e.frameId, e.trackId);
    case "TrackingGap":
      return stableId("scope", "gap", e.gapId);
  }
}

export class Repository {
  constructor(private db: DatabaseSync) {}

  // ---------- 原子导入：失败只回滚本次变更，不留半份记录 ----------
  importBatch(batch: SourceBatch): { stored: StoredEntity[]; diagnostics: string[] } {
    const diagnostics: string[] = [];
    this.db.exec("BEGIN");
    try {
      const existing = this.db.prepare("SELECT batch_id FROM import_batches WHERE batch_id = ?").get(batch.batchId);
      if (existing) throw new Error(`batch-already-imported: ${batch.batchId}`);

      for (const blob of batch.blobs ?? []) {
        const actual = sha256Hex(blob.bytes);
        if (actual !== blob.sha256) throw new Error(`blob-checksum-mismatch: declared ${blob.sha256} actual ${actual}`);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO source_blobs(sha256, bytes, media_type, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(blob.sha256, Buffer.from(blob.bytes), "image/png", batch.importedAt);
      }

      const stored: StoredEntity[] = [];
      for (const e of batch.entities) {
        const frame = "frameId" in e ? e.frameId : null;
        const track = "trackId" in e ? e.trackId : null;
        if (frame) {
          const hasFrame = batch.entities.some((x) => x.kind === "TiltFrame" && x.frameId === frame);
          const frameExists = this.db.prepare("SELECT 1 FROM source_entities WHERE entity_id = ? AND kind = 'TiltFrame'").get(
            stableId("scope", "frame", frame),
          );
          if (!hasFrame && !frameExists) {
            throw new Error(`dangling-reference: ${e.kind} 引用了不存在的帧 ${frame}`);
          }
        }
        if (e.kind === "TrackingGap") {
          for (const f of [e.fromFrameId, e.toFrameId]) {
            const existsBatch = batch.entities.some((x) => x.kind === "TiltFrame" && x.frameId === f);
            const existsDb = this.db.prepare("SELECT 1 FROM source_entities WHERE entity_id = ? AND kind = 'TiltFrame'").get(
              stableId("scope", "frame", f),
            );
            if (!existsBatch && !existsDb) throw new Error(`dangling-reference: 跟踪缺口引用不存在帧 ${f}`);
          }
        }

        const scopeKey = scopeKeyOf(e);
        const latest = this.db
          .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM source_entities WHERE scope_key = ?")
          .get(scopeKey) as { v: number };
        const version = latest.v + 1;
        const contentSha = sha256Hex(canonicalJson(e));
        const supersedes =
          version > 1
            ? (
                this.db
                  .prepare("SELECT entity_id FROM source_entities WHERE scope_key = ? ORDER BY version DESC LIMIT 1")
                  .get(scopeKey) as { entity_id: string } | undefined
              )?.entityId ?? null
            : null;
        this.db
          .prepare(
            `INSERT INTO source_entities(entity_id, kind, version, batch_id, frame_id, track_id, payload_json,
               content_sha256, supersedes_entity_id, created_at, scope_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            scopeKey,
            e.kind,
            version,
            batch.batchId,
            frame,
            track,
            JSON.stringify(e),
            contentSha,
            supersedes,
            batch.importedAt,
            scopeKey,
          );
        const row: StoredEntity = {
          entityId: scopeKey,
          kind: e.kind,
          version,
          batchId: batch.batchId,
          frameId: frame,
          trackId: track,
          payload: e,
          contentSha256: contentSha,
          supersedesEntityId: supersedes,
          createdAt: batch.importedAt,
          scopeKey,
        };
        stored.push(row);
      }

      this.db
        .prepare("INSERT INTO import_batches(batch_id, label, imported_at, entity_count, status) VALUES (?, ?, ?, ?, ?)")
        .run(batch.batchId, batch.label, batch.importedAt, batch.entities.length, "committed");
      this.db.exec("COMMIT");
      return { stored, diagnostics };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getBlob(sha256: string): Uint8Array | null {
    const row = this.db.prepare("SELECT bytes FROM source_blobs WHERE sha256 = ?").get(sha256) as
      | { bytes: Uint8Array }
      | undefined;
    return row?.bytes ?? null;
  }

  /** 查询实体：返回引用版本号与内容摘要；缺少引用报损坏，不退回最新版 */
  getEntity(scopeKey: string, version?: number): StoredEntity {
    const row =
      version === undefined
        ? (this.db
            .prepare("SELECT * FROM source_entities WHERE scope_key = ? ORDER BY version DESC LIMIT 1")
            .get(scopeKey) as EntityRow | undefined)
        : (this.db.prepare("SELECT * FROM source_entities WHERE scope_key = ? AND version = ?").get(scopeKey, version) as
            | EntityRow
            | undefined);
    if (!row) throw new CorruptArchiveError(`missing-reference: ${scopeKey}${version ? `@v${version}` : ""}`);
    return rowToStored(row);
  }

  latestEntities(kind?: SourceKind): StoredEntity[] {
    const rows = (
      kind
        ? (this.db
            .prepare(
              `SELECT * FROM source_entities se WHERE version = (SELECT MAX(version) FROM source_entities WHERE scope_key = se.scope_key)
               AND kind = ? ORDER BY created_at, entity_id`,
            )
            .all(kind) as EntityRow[])
        : (this.db
            .prepare(
              `SELECT * FROM source_entities se WHERE version = (SELECT MAX(version) FROM source_entities WHERE scope_key = se.scope_key)
               ORDER BY created_at, entity_id`,
            )
            .all() as EntityRow[])
    );
    return rows.map(rowToStored);
  }

  allEntityVersions(scopeKey: string): StoredEntity[] {
    const rows = this.db
      .prepare("SELECT * FROM source_entities WHERE scope_key = ? ORDER BY version")
      .all(scopeKey) as EntityRow[];
    return rows.map(rowToStored);
  }

  // ---------- 分支与提交 ----------
  createBranch(branch: BranchRecord): void {
    this.db
      .prepare(
        "INSERT INTO branches(branch_id, parent_branch_id, label, note, rule_set_version, head_commit_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        branch.branchId,
        branch.parentBranchId,
        branch.label,
        branch.note,
        branch.basisRuleSetVersion,
        null,
        branch.createdAt,
      );
  }

  listBranches(): BranchRecord[] {
    const rows = this.db.prepare("SELECT * FROM branches ORDER BY created_at").all() as BranchRow[];
    return rows.map((r) => ({
      branchId: r.branch_id,
      parentBranchId: r.parent_branch_id,
      label: r.label,
      createdAt: r.created_at,
      basisRuleSetVersion: r.rule_set_version,
      note: r.note,
    }));
  }

  commit(input: Omit<CommitRecord, "createdAt"> & { createdAt?: string }): CommitRecord {
    const expected = input.expectedParentCommitId;
    const head = this.db.prepare("SELECT head_commit_id FROM branches WHERE branch_id = ?").get(input.branchId) as
      | { head_commit_id: string | null }
      | undefined;
    if (!head) throw new Error(`unknown-branch: ${input.branchId}`);
    if (head.head_commit_id !== expected) {
      throw new VersionConflictError(head.head_commit_id, expected);
    }
    const commit: CommitRecord = {
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO commits(commit_id, branch_id, parent_commit_id, kind, author, message, rule_set_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        commit.commitId,
        commit.branchId,
        commit.parentCommitId,
        commit.kind,
        commit.author,
        commit.message,
        commit.ruleSetVersion,
        commit.createdAt,
      );
    this.db.prepare("UPDATE branches SET head_commit_id = ? WHERE branch_id = ?").run(
      commit.commitId,
      commit.branchId,
    );
    return commit;
  }

  listCommits(branchId: string): CommitRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM commits WHERE branch_id = ? ORDER BY created_at, rowid")
      .all(branchId) as CommitRow[];
    return rows.map((r) => ({
      commitId: r.commit_id,
      branchId: r.branch_id,
      parentCommitId: r.parent_commit_id,
      kind: r.kind as CommitRecord["kind"],
      createdAt: r.created_at,
      author: r.author,
      message: r.message,
      ruleSetVersion: r.rule_set_version,
      expectedParentCommitId: r.parent_commit_id,
    }));
  }

  headCommit(branchId: string): string | null {
    const row = this.db.prepare("SELECT head_commit_id FROM branches WHERE branch_id = ?").get(branchId) as
      | { head_commit_id: string | null }
      | undefined;
    return row?.head_commit_id ?? null;
  }

  // ---------- 事件 ----------
  appendEvent(event: LedgerEvent): void {
    this.db
      .prepare(
        "INSERT INTO ledger_events(event_id, branch_id, commit_id, semantic_kind, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventId,
        event.branchId,
        event.commitId,
        event.semanticKind,
        event.subjectId,
        JSON.stringify(event.payload),
        event.createdAt,
      );
  }

  listEvents(branchId?: string, atCommitId?: string): LedgerEvent[] {
    let rows: EventRow[];
    if (branchId && atCommitId) {
      // 回到任意旧事件：只返回该提交及其祖先链上的事件
      const chain = this.ancestorChain(branchId, atCommitId);
      const placeholders = chain.map(() => "?").join(",");
      rows = this.db
          .prepare(`SELECT * FROM ledger_events WHERE commit_id IN (${placeholders}) ORDER BY created_at, rowid`)
          .all(...chain) as EventRow[];
    } else if (branchId) {
      rows = this.db
          .prepare("SELECT * FROM ledger_events WHERE branch_id = ? ORDER BY created_at, rowid")
          .all(branchId) as EventRow[];
    } else {
      rows = this.db.prepare("SELECT * FROM ledger_events ORDER BY created_at, rowid").all() as EventRow[];
    }
    return rows.map((r) => ({
      eventId: r.event_id,
      branchId: r.branch_id,
      commitId: r.commit_id,
      semanticKind: r.semantic_kind as LedgerEvent["semanticKind"],
      subjectId: r.subject_id,
      payload: JSON.parse(r.payload_json),
      createdAt: r.created_at,
    }));
  }

  ancestorChain(branchId: string, commitId: string): string[] {
    const chain: string[] = [];
    let current: string | null = commitId;
    while (current) {
      const row = this.db
        .prepare("SELECT commit_id, parent_commit_id FROM commits WHERE commit_id = ? AND branch_id = ?")
        .get(current, branchId) as { commit_id: string; parent_commit_id: string | null } | undefined;
      if (!row) throw new CorruptArchiveError(`commit-not-on-branch: ${current}`);
      chain.push(row.commit_id);
      current = row.parent_commit_id;
    }
    return chain;
  }
}

interface EntityRow {
  entity_id: string;
  kind: SourceKind;
  version: number;
  batch_id: string;
  frame_id: string | null;
  track_id: string | null;
  payload_json: string;
  content_sha256: string;
  supersedes_entity_id: string | null;
  created_at: string;
  scope_key: string;
}

function rowToStored(r: EntityRow): StoredEntity {
  return {
    entityId: r.entity_id,
    kind: r.kind,
    version: r.version,
    batchId: r.batch_id,
    frameId: r.frame_id,
    trackId: r.track_id,
    payload: JSON.parse(r.payload_json),
    contentSha256: r.content_sha256,
    supersedesEntityId: r.supersedes_entity_id,
    createdAt: r.created_at,
    scopeKey: r.scope_key,
  };
}

interface BranchRow {
  branch_id: string;
  parent_branch_id: string | null;
  label: string;
  note: string;
  rule_set_version: string;
  created_at: string;
}
interface CommitRow {
  commit_id: string;
  branch_id: string;
  parent_commit_id: string | null;
  kind: string;
  author: string;
  message: string;
  rule_set_version: string;
  created_at: string;
}
interface EventRow {
  event_id: string;
  branch_id: string;
  commit_id: string;
  semantic_kind: string;
  subject_id: string;
  payload_json: string;
  created_at: string;
}
