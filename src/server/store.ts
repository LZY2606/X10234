import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  EntityEnvelope,
  EntityView,
  EventRecord,
  VersionRef
} from "../shared/types";
import { contentHash } from "../shared/hash";

export interface StoredEvent extends EventRecord {}

export class VersionConflictError extends Error {
  conflict: { expectedBase: number; actualHead: number; otherEvent: StoredEvent };
  constructor(detail: { expectedBase: number; actualHead: number; otherEvent: StoredEvent }) {
    super("VERSION_CONFLICT");
    this.name = "VersionConflictError";
    this.conflict = detail;
  }
}

export class CorruptionError extends Error {
  missing: { fromEntityId: string; ref: VersionRef }[];
  constructor(missing: { fromEntityId: string; ref: VersionRef }[]) {
    super("CORRUPTED_REFERENCES");
    this.name = "CorruptionError";
    this.missing = missing;
  }
}

export class Store {
  readonly db: DatabaseSync;
  private static SCHEMA_VERSION = 1;

  constructor(dbPath: string) {
    if (dirname(dbPath) !== "." && !existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  migrate(): void {
    const current = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    if (current >= Store.SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      -- 不可变字节内容，按 sha256 去重；最小/组合片段共享原始帧时只存一份
      CREATE TABLE IF NOT EXISTS blobs (
        sha TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_event_id TEXT NOT NULL
      );

      -- 仅追加事件日志（历史不可变）
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        branch_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        base_seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        fragment_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_seq ON events(seq);

      -- 实体版本表（每个版本不可变）
      CREATE TABLE IF NOT EXISTS entity_versions (
        entity_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        doc TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        refs TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_ev_kind ON entity_versions(kind);

      -- 分支可见性：事件在某分支创建的实体版本
      CREATE TABLE IF NOT EXISTS branch_events (
        branch_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (branch_id, seq)
      );

      -- 反例片段：最小/组合输入 + 诊断 + 人工决定（解释独立）
      CREATE TABLE IF NOT EXISTS fragments (
        fragment_id TEXT PRIMARY KEY,
        scenario TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_event_id TEXT NOT NULL,
        input TEXT NOT NULL,
        diagnosis TEXT NOT NULL,
        decision TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fragment_blobs (
        fragment_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (fragment_id, sha, role)
      );
    `);
    this.db.prepare(`PRAGMA user_version = ${Store.SCHEMA_VERSION}`).run();
  }

  headSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number | null };
    return row.s ?? 0;
  }

  branchHeadSeq(branchId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS s FROM branch_events WHERE branch_id = ?")
      .get(branchId) as { s: number | null };
    return row.s ?? 0;
  }

  /** 引用完整性校验：所有 refs 必须指向已存在的具体版本；缺失 => CorruptionError（不回退最新版）。 */
  private verifyRefs(upserts: EntityEnvelope[]): { fromEntityId: string; ref: VersionRef }[] {
    const missing: { fromEntityId: string; ref: VersionRef }[] = [];
    const pending = new Set(upserts.map((u) => `${u.entityId}@${u.version}`));
    const stmt = this.db.prepare(
      "SELECT 1 FROM entity_versions WHERE entity_id = ? AND version = ?"
    );
    for (const u of upserts) {
      for (const ref of u.refs ?? []) {
        if (pending.has(`${ref.entityId}@${ref.version}`)) continue;
        const found = stmt.get(ref.entityId, ref.version);
        if (!found) missing.push({ fromEntityId: u.entityId, ref });
      }
    }
    return missing;
  }

  /**
   * 原子追加事件。
   *  - baseSeq 乐观并发：若分支头已前进，则抛 VersionConflictError（后提交者看到冲突）。
   *  - 任一引用缺失 => CorruptionError，整批回滚（不留半份记录）。
   *  - 新实体版本号必须严格递增（由服务层保证）。
   */
  appendEvent(
    event: Omit<EventRecord, "seq" | "id"> & { id?: string },
    options: { expectedBaseSeq?: number; freeze?: boolean } = {}
  ): StoredEvent {
    const tx = this.db.prepare("BEGIN IMMEDIATE");
    try {
      tx.run();
      const head = this.headSeq();
      const branchHead = this.branchHeadSeq(event.branchId);
      const expected = options.expectedBaseSeq ?? event.baseSeq;
      if (options.freeze && branchHead !== expected) {
        const other = this.eventAfterOnBranch(event.branchId, expected);
        throw new VersionConflictError({ expectedBase: expected, actualHead: branchHead, otherEvent: other! });
      }
      const missing = this.verifyRefs(event.upserts ?? []);
      if (missing.length) throw new CorruptionError(missing);
      const seq = head + 1;
      const id = event.id ?? `evt:${String(seq).padStart(4, "0")}:${event.type}`;
      const full: StoredEvent = { ...(event as EventRecord), id, seq };
      const now = full.at;
      this.db
        .prepare(
          `INSERT INTO events (id, seq, branch_id, series_id, type, at, actor, base_seq, payload, fragment_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          seq,
          full.branchId,
          full.seriesId,
          full.type,
          now,
          full.actor,
          full.baseSeq,
          JSON.stringify(full),
          full.fragmentId ?? null
        );
      const insertVersion = this.db.prepare(
        `INSERT INTO entity_versions (entity_id, version, kind, doc, content_hash, refs, event_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      for (const u of full.upserts ?? []) {
        insertVersion.run(
          u.entityId,
          u.version,
          u.kind,
          JSON.stringify(u.doc),
          u.contentHash,
          JSON.stringify(u.refs ?? []),
          id,
          now
        );
      }
      this.db
        .prepare("INSERT INTO branch_events (branch_id, seq, event_id) VALUES (?,?,?)")
        .run(full.branchId, seq, id);
      this.db.prepare("COMMIT").run();
      return full;
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  eventAfterOnBranch(branchId: string, afterSeq: number): StoredEvent | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM events WHERE branch_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1`
      )
      .get(branchId, afterSeq) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as StoredEvent) : null;
  }

  eventAtSeq(seq: number): StoredEvent | null {
    const row = this.db.prepare("SELECT payload FROM events WHERE seq = ?").get(seq) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as StoredEvent) : null;
  }

  getEvent(id: string): StoredEvent | null {
    const row = this.db.prepare("SELECT payload FROM events WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as StoredEvent) : null;
  }

  allEvents(): StoredEvent[] {
    const rows = this.db.prepare("SELECT payload FROM events ORDER BY seq ASC").all() as {
      payload: string;
    }[];
    return rows.map((r) => JSON.parse(r.payload) as StoredEvent);
  }

  /* ---------------- 不可变 blob（内容寻址、去重） ---------------- */

  putBlob(sha: string, bytes: Buffer, mediaType: string, eventId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO blobs (sha, bytes, media_type, byte_length, created_event_id)
         VALUES (?,?,?,?,?)`
      )
      .run(sha, bytes, mediaType, bytes.length, eventId);
  }

  getBlob(sha: string): { bytes: Buffer; mediaType: string } | null {
    const row = this.db.prepare("SELECT bytes, media_type FROM blobs WHERE sha = ?").get(sha) as
      | { bytes: Uint8Array; media_type: string }
      | undefined;
    if (!row) return null;
    return { bytes: Buffer.from(row.bytes), mediaType: row.media_type };
  }

  allBlobMeta(): { sha: string; mediaType: string; byteLength: number }[] {
    return this.db
      .prepare("SELECT sha, media_type, byte_length FROM blobs ORDER BY sha")
      .all() as { sha: string; mediaType: string; byteLength: number }[];
  }

  /* ---------------- 片段（反例档案） ---------------- */

  putFragment(fragment: {
    fragmentId: string;
    scenario: string;
    scope: "minimal" | "composite";
    createdEventId: string;
    input: unknown;
    diagnosis: unknown;
    decision: unknown;
    blobs: { sha: string; role: string }[];
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO fragments (fragment_id, scenario, scope, created_event_id, input, diagnosis, decision)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        fragment.fragmentId,
        fragment.scenario,
        fragment.scope,
        fragment.createdEventId,
        JSON.stringify(fragment.input),
        JSON.stringify(fragment.diagnosis),
        JSON.stringify(fragment.decision)
      );
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO fragment_blobs (fragment_id, sha, role) VALUES (?,?,?)"
    );
    for (const b of fragment.blobs) ins.run(fragment.fragmentId, b.sha, b.role);
  }

  getFragment(fragmentId: string) {
    const row = this.db.prepare("SELECT * FROM fragments WHERE fragment_id = ?").get(fragmentId) as
      | any
      | undefined;
    if (!row) return null;
    const blobs = this.db
      .prepare("SELECT sha, role FROM fragment_blobs WHERE fragment_id = ?")
      .all(fragmentId) as { sha: string; role: string }[];
    return {
      fragmentId: row.fragment_id,
      scenario: row.scenario,
      scope: row.scope,
      createdEventId: row.created_event_id,
      input: JSON.parse(row.input),
      diagnosis: JSON.parse(row.diagnosis),
      decision: JSON.parse(row.decision),
      blobs
    };
  }

  allFragments() {
    const rows = this.db.prepare("SELECT fragment_id FROM fragments ORDER BY fragment_id").all() as {
      fragment_id: string;
    }[];
    return rows.map((r) => this.getFragment(r.fragment_id)!);
  }

  /* ---------------- 实体版本查询（必须显式版本） ---------------- */

  getEntityVersion(entityId: string, version: number): EntityView | null {
    const row = this.db
      .prepare("SELECT * FROM entity_versions WHERE entity_id = ? AND version = ?")
      .get(entityId, version) as any;
    if (!row) return null;
    const refs = JSON.parse(row.refs) as VersionRef[];
    const missingRefs = refs.filter(
      (r) => !this.db.prepare("SELECT 1 FROM entity_versions WHERE entity_id = ? AND version = ?").get(r.entityId, r.version)
    );
    return {
      entityId: row.entity_id,
      version: row.version,
      kind: row.kind,
      contentHash: row.content_hash,
      doc: JSON.parse(row.doc),
      refs,
      integrity: missingRefs.length ? "corrupted" : "ok",
      missingRefs: missingRefs.length ? missingRefs : undefined,
      createdAt: row.created_at,
      eventId: row.event_id
    };
  }

  latestVersion(entityId: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM entity_versions WHERE entity_id = ?")
      .get(entityId) as { v: number | null };
    return row.v;
  }

  /** 某分支可见事件序列（沿父分支链回溯），可按 asOfSeq（全局 seq）回放历史。 */
  visibleEvents(branchId: string, asOfSeq?: number): StoredEvent[] {
    const events: StoredEvent[] = [];
    const seen = new Set<number>();
    let current: string | undefined = branchId;
    const guard = new Set<string>();
    while (current && !guard.has(current)) {
      guard.add(current);
      const rows = this.db
        .prepare("SELECT payload FROM events WHERE branch_id = ? ORDER BY seq ASC")
        .all(current) as { payload: string }[];
      for (const r of rows) {
        const ev = JSON.parse(r.payload) as StoredEvent;
        if (asOfSeq !== undefined && ev.seq > asOfSeq) continue;
        if (!seen.has(ev.seq)) {
          seen.add(ev.seq);
          events.push(ev);
        }
      }
      current = this.parentBranchOf(current);
    }
    return events.sort((a, b) => a.seq - b.seq);
  }

  private parentBranchOf(branchId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT doc FROM entity_versions WHERE kind = 'branch' AND json_extract(doc, '$.branchId') = ?
         ORDER BY version DESC LIMIT 1`
      )
      .get(branchId) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc).parentBranchId as string | undefined) : undefined;
  }

  /**
   * 分支状态物化：回放可见事件，实体取“该分支当时可见的最新版本”。
   * 回到任意旧 seq 时恢复当时结论，不用最新结果覆盖历史。
   */
  branchState(branchId: string, asOfSeq?: number) {
    const events = this.visibleEvents(branchId, asOfSeq);
    const latest = new Map<string, { version: number; eventId: string }>();
    const invalidated = new Map<string, { reason: string; dependencyKey: string; atSeq: number }>();
    for (const ev of events) {
      for (const u of ev.upserts ?? []) latest.set(u.entityId, { version: u.version, eventId: ev.id });
      for (const inv of ev.invalidates ?? []) invalidated.set(inv.candidateId, { ...inv, atSeq: ev.seq });
    }
    const current: Record<string, EntityView> = {};
    for (const [entityId, pos] of latest) {
      const view = this.getEntityVersion(entityId, pos.version)!;
      current[entityId] = view;
    }
    return { events, current, invalidated };
  }

  listBranches(): { branchId: string; parentBranchId?: string; label: string }[] {
    const rows = this.db
      .prepare(
        `SELECT doc FROM entity_versions
         WHERE kind = 'branch' AND version = (
           SELECT MAX(version) FROM entity_versions e2 WHERE e2.entity_id = entity_versions.entity_id
         )
         ORDER BY entity_id`
      )
      .all() as { doc: string }[];
    return rows.map((r) => {
      const d = JSON.parse(r.doc);
      return { branchId: d.branchId, parentBranchId: d.parentBranchId, label: d.label };
    });
  }

  /* ---------------- 导出 / 导入（删除本地库后身份、顺序、来源关系保持） ---------------- */

  exportArchive(): unknown {
    const blobRows = this.db.prepare("SELECT sha, bytes, media_type, byte_length FROM blobs").all() as {
      sha: string;
      bytes: Uint8Array;
      media_type: string;
      byte_length: number;
    }[];
    const events = this.allEvents().map((e) => ({ ...e }));
    const fragments = this.allFragments();
    return {
      format: "tilt-room-archive/v1",
      exportedAt: new Date().toISOString(),
      schemaVersion: Store.SCHEMA_VERSION,
      events,
      blobs: blobRows.map((b) => ({
        sha: b.sha,
        mediaType: b.media_type,
        byteLength: b.byte_length,
        base64: Buffer.from(b.bytes).toString("base64")
      })),
      fragments: fragments.map((f) => ({
        fragmentId: f.fragmentId,
        scenario: f.scenario,
        scope: f.scope,
        createdEventId: f.createdEventId,
        input: f.input,
        diagnosis: f.diagnosis,
        decision: f.decision,
        blobs: f.blobs
      }))
    };
  }

  /**
   * 导入档案：先清空，再严格按 seq 顺序重放；全部完成后做引用完整性扫描，
   * 任一失败则回滚整库导入（不留半份记录）。
   */
  importArchive(archive: any): { events: number; blobs: number } {
    if (!archive || archive.format !== "tilt-room-archive/v1") {
      throw new Error("BAD_ARCHIVE_FORMAT");
    }
    const tx = this.db.prepare("BEGIN");
    try {
      tx.run();
      this.db.exec(
        "DELETE FROM fragment_blobs; DELETE FROM fragments; DELETE FROM branch_events; DELETE FROM entity_versions; DELETE FROM events; DELETE FROM blobs;"
      );
      const events = [...(archive.events ?? [])].sort(
        (a: StoredEvent, b: StoredEvent) => a.seq - b.seq
      );
      const insBlob = this.db.prepare(
        "INSERT INTO blobs (sha, bytes, media_type, byte_length, created_event_id) VALUES (?,?,?,?,?)"
      );
      for (const b of archive.blobs ?? []) {
        insBlob.run(b.sha, Buffer.from(b.base64, "base64"), b.mediaType, b.byteLength, "import");
      }
      const insEvent = this.db.prepare(
        "INSERT INTO events (id, seq, branch_id, series_id, type, at, actor, base_seq, payload, fragment_id) VALUES (?,?,?,?,?,?,?,?,?,?)"
      );
      const insVersion = this.db.prepare(
        "INSERT INTO entity_versions (entity_id, version, kind, doc, content_hash, refs, event_id, created_at) VALUES (?,?,?,?,?,?,?,?)"
      );
      const insBranch = this.db.prepare(
        "INSERT INTO branch_events (branch_id, seq, event_id) VALUES (?,?,?)"
      );
      for (const ev of events as StoredEvent[]) {
        insEvent.run(
          ev.id,
          ev.seq,
          ev.branchId,
          ev.seriesId,
          ev.type,
          ev.at,
          ev.actor,
          ev.baseSeq,
          JSON.stringify(ev),
          ev.fragmentId ?? null
        );
        for (const u of ev.upserts ?? []) {
          const hash = u.contentHash ?? contentHash(u.doc);
          insVersion.run(u.entityId, u.version, u.kind, JSON.stringify(u.doc), hash, JSON.stringify(u.refs ?? []), ev.id, ev.at);
        }
        insBranch.run(ev.branchId, ev.seq, ev.id);
      }
      for (const f of archive.fragments ?? []) {
        this.db
          .prepare(
            "INSERT INTO fragments (fragment_id, scenario, scope, created_event_id, input, diagnosis, decision) VALUES (?,?,?,?,?,?,?)"
          )
          .run(f.fragmentId, f.scenario, f.scope, f.createdEventId, JSON.stringify(f.input), JSON.stringify(f.diagnosis), JSON.stringify(f.decision));
        for (const b of f.blobs ?? []) {
          this.db
            .prepare("INSERT INTO fragment_blobs (fragment_id, sha, role) VALUES (?,?,?)")
            .run(f.fragmentId, b.sha, b.role);
        }
      }
      // 完整引用扫描
      const broken = this.db
        .prepare(
          `SELECT ev.entity_id AS entity_id, ev.version AS version, ev.refs AS refs
           FROM entity_versions ev`
        )
        .all() as { entity_id: string; version: number; refs: string }[];
      const allKeys = new Set(
        (this.db.prepare("SELECT entity_id, version FROM entity_versions").all() as {
          entity_id: string;
          version: number;
        }[]).map((r) => `${r.entity_id}@${r.version}`)
      );
      const missing: string[] = [];
      for (const r of broken) {
        for (const ref of JSON.parse(r.refs) as VersionRef[]) {
          if (!allKeys.has(`${ref.entityId}@${ref.version}`)) {
            missing.push(`${r.entity_id}@${r.version} -> ${ref.entityId}@${ref.version}`);
          }
        }
      }
      if (missing.length) throw new CorruptionError(missing.map((m) => ({ fromEntityId: m, ref: { entityId: m, version: 0, kind: "rawFrame" } })));
      this.db.prepare("COMMIT").run();
      return { events: events.length, blobs: (archive.blobs ?? []).length };
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    this.db.exec(
      "DELETE FROM fragment_blobs; DELETE FROM fragments; DELETE FROM branch_events; DELETE FROM entity_versions; DELETE FROM events; DELETE FROM blobs;"
    );
  }
}
