import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../shared/ids.ts';
import { ConflictError, ReferenceCorruptionError, type EventRecord, type EventRef } from '../shared/types.ts';

export interface StoreOptions {
  filename?: string;
  readonly?: boolean;
}

const MIGRATIONS: { version: number; name: string; up: string }[] = [
  {
    version: 1,
    name: '001-initial-event-sourced-schema',
    up: `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE content_blobs (
  content_hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  original_relpath TEXT
);
CREATE TABLE cases (
  case_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  casepack_version TEXT NOT NULL
);
CREATE TABLE branches (
  branch_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  parent_branch_id TEXT,
  name TEXT NOT NULL,
  head_event_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  branch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_event_id TEXT,
  base_branch_head TEXT,
  timestamp TEXT NOT NULL,
  code TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  UNIQUE(branch_id, seq)
);
CREATE TABLE entity_versions (
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_summary TEXT NOT NULL,
  created_by_event_id TEXT NOT NULL,
  superseded_by_event_id TEXT,
  data_json TEXT NOT NULL,
  PRIMARY KEY(kind, entity_id, version)
);
CREATE TABLE case_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  },
  {
    version: 2,
    name: '002-freeze-locks-and-dependencies',
    up: `
CREATE TABLE freeze_locks (
  lock_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  branch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reconstruction_ref TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  revoked_event_id TEXT
);
CREATE TABLE dependencies (
  dependent_entity_kind TEXT NOT NULL,
  dependent_entity_id TEXT NOT NULL,
  dependent_version INTEGER NOT NULL,
  dependency_ref_kind TEXT NOT NULL,
  dependency_ref_id TEXT NOT NULL,
  dependency_ref_version INTEGER NOT NULL,
  recorded_by_event_id TEXT NOT NULL,
  PRIMARY KEY(dependent_entity_kind, dependent_entity_id, dependent_version, dependency_ref_kind, dependency_ref_id, dependency_ref_version)
);
CREATE INDEX idx_deps_ref ON dependencies(dependency_ref_kind, dependency_ref_id, dependency_ref_version);
`,
  },
];

export function migrate(db: DatabaseSync): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  );
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  let current = 0;
  for (const m of MIGRATIONS) {
    current = Math.max(current, m.version - 1);
    if (applied.has(m.version)) {
      current = m.version;
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)').run(
        m.version,
        m.name,
        new Date(0).toISOString(),
      );
      db.exec('COMMIT');
      current = m.version;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return current;
}

export function createStore(opts: StoreOptions = {}): Store {
  const db = new DatabaseSync(opts.filename ?? ':memory:');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  return new Store(db, opts.readonly ?? false);
}

/** 测试辅助：从指定迁移版本建库，用于状态迁移测试。 */
export function createStoreAtVersion(target: number, filename?: string): Store {
  const db = new DatabaseSync(filename ?? ':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  );
  for (const m of MIGRATIONS) {
    if (m.version > target) break;
    db.exec(m.up);
    db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)').run(
      m.version,
      m.name,
      new Date(0).toISOString(),
    );
  }
  return new Store(db, target === 0);
}

export class Store {
  constructor(
    public readonly db: DatabaseSync,
    public readonly readonlyMode: boolean,
  ) {}

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    const rows = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').all() as { v: number | null }[];
    return rows[0]?.v ?? 0;
  }

  migrationNames(): string[] {
    const rows = this.db.prepare('SELECT name FROM schema_migrations ORDER BY version').all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  /* ---------------- 不可变内容（原始字节只存一份） ---------------- */

  putBlob(hash: string, mediaType: string, bytes: Uint8Array, relpath?: string): void {
    this.db
      .prepare(
        `INSERT INTO content_blobs(content_hash, media_type, byte_length, bytes, original_relpath)
         VALUES (?,?,?,?,?) ON CONFLICT(content_hash) DO NOTHING`,
      )
      .run(hash, mediaType, bytes.length, bytes, relpath ?? null);
  }

  getBlob(hash: string): { bytes: Uint8Array; mediaType: string } | null {
    const row = this.db
      .prepare('SELECT bytes, media_type FROM content_blobs WHERE content_hash = ?')
      .get(hash) as { bytes: Uint8Array; media_type: string } | undefined;
    return row ? { bytes: row.bytes, mediaType: row.media_type } : null;
  }

  blobHashes(): string[] {
    return (this.db.prepare('SELECT content_hash FROM content_blobs').all() as { content_hash: string }[]).map(
      (r) => r.content_hash,
    );
  }

  createCase(caseId: string, name: string, createdAt: string, casepackVersion: string): void {
    this.db
      .prepare('INSERT INTO cases(case_id, name, created_at, casepack_version) VALUES (?,?,?,?)')
      .run(caseId, name, createdAt, casepackVersion);
  }

  getCase(caseId: string): { caseId: string; name: string; createdAt: string; casepackVersion: string } | null {
    const row = this.db
      .prepare('SELECT case_id, name, created_at, casepack_version FROM cases WHERE case_id = ?')
      .get(caseId) as
      | { case_id: string; name: string; created_at: string; casepack_version: string }
      | undefined;
    return row
      ? { caseId: row.case_id, name: row.name, createdAt: row.created_at, casepackVersion: row.casepack_version }
      : null;
  }

  listCases(): { caseId: string; name: string }[] {
    return (this.db.prepare('SELECT case_id, name FROM cases ORDER BY created_at').all() as {
      case_id: string;
      name: string;
    }[]).map((r) => ({ caseId: r.case_id, name: r.name }));
  }

  createBranch(branchId: string, caseId: string, parentBranchId: string | null, name: string, createdAt: string): void {
    this.db
      .prepare(
        `INSERT INTO branches(branch_id, case_id, parent_branch_id, name, head_event_id, created_at)
         VALUES (?,?,?,?,NULL,?)`,
      )
      .run(branchId, caseId, parentBranchId, name, createdAt);
  }

  getBranch(branchId: string): { branchId: string; caseId: string; parentBranchId: string | null; name: string; headEventId: string | null } | null {
    const row = this.db
      .prepare('SELECT branch_id, case_id, parent_branch_id, name, head_event_id FROM branches WHERE branch_id = ?')
      .get(branchId) as
      | {
          branch_id: string;
          case_id: string;
          parent_branch_id: string | null;
          name: string;
          head_event_id: string | null;
        }
      | undefined;
    return row
      ? {
          branchId: row.branch_id,
          caseId: row.case_id,
          parentBranchId: row.parent_branch_id,
          name: row.name,
          headEventId: row.head_event_id,
        }
      : null;
  }

  listBranches(caseId: string) {
    return (
      this.db
        .prepare('SELECT branch_id, name, parent_branch_id, head_event_id FROM branches WHERE case_id = ? ORDER BY created_at')
        .all(caseId) as {
        branch_id: string;
        name: string;
        parent_branch_id: string | null;
        head_event_id: string | null;
      }[]
    ).map((r) => ({
      branchId: r.branch_id,
      name: r.name,
      parentBranchId: r.parent_branch_id,
      headEventId: r.head_event_id,
    }));
  }

  branchSeq(branchId: string): number {
    const row = this.db.prepare('SELECT MAX(seq) AS s FROM events WHERE branch_id = ?').get(branchId) as {
      s: number | null;
    };
    return row.s ?? 0;
  }

  /* ---------------- 事件追加（乐观并发 + 引用完整性） ---------------- */

  /**
   * 追加事件。expectedHead 必须等于当前分支头（两窗口并发时后提交者收到 ConflictError）。
   * refs 中每个实体引用必须能在 entity_versions 中找到精确版本，否则 ReferenceCorruptionError，
   * 绝不退回最新版。整个追加在单个事务内，失败回滚，不留半份记录。
   */
  appendEvent(
    e: Omit<EventRecord, 'seq'>,
    expectedHead: string | null,
    entityWrites?: { kind: string; data: unknown; id: string }[],
    supersedes?: { kind: string; id: string; version: number }[],
  ): EventRecord {
    const tx = this.db;
    tx.exec('BEGIN IMMEDIATE');
    try {
      const branch = tx
        .prepare('SELECT head_event_id FROM branches WHERE branch_id = ?')
        .get(e.branchId) as { head_event_id: string | null } | undefined;
      if (!branch) throw new Error(`分支不存在: ${e.branchId}`);
      if (branch.head_event_id !== expectedHead) {
        const competing = tx
          .prepare(
            'SELECT event_id FROM events WHERE branch_id = ? ORDER BY seq DESC LIMIT 1',
          )
          .get(e.branchId) as { event_id: string };
        throw new ConflictError(
          e.branchId,
          expectedHead ?? '(empty)',
          branch.head_event_id ?? '(empty)',
          expectedHead ?? '(empty)',
          competing.event_id,
        );
      }
      for (const ref of e.refs) {
        const row = tx
          .prepare(
            'SELECT 1 FROM entity_versions WHERE kind = ? AND entity_id = ? AND version = ? AND superseded_by_event_id IS NULL',
          )
          .get(ref.kind, ref.id, ref.version);
        if (!row) {
          const anyVersion = tx
            .prepare('SELECT version FROM entity_versions WHERE kind = ? AND entity_id = ? ORDER BY version DESC LIMIT 1')
            .get(ref.kind, ref.id) as { version: number } | undefined;
          if (anyVersion) {
            throw new ReferenceCorruptionError(ref, e.id);
          }
          throw new ReferenceCorruptionError(ref, e.id);
        }
      }

      const seq = (tx.prepare('SELECT COALESCE(MAX(seq),0) + 1 AS s FROM events WHERE branch_id = ?').get(e.branchId) as {
        s: number;
      }).s;
      const record: EventRecord = { ...e, seq };
      tx.prepare(
        `INSERT INTO events(event_id, case_id, branch_id, seq, parent_event_id, base_branch_head, timestamp, code, payload_json, refs_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.id,
        record.caseId,
        record.branchId,
        record.seq,
        record.parentEventId,
        record.baseBranchHead,
        record.timestamp,
        record.code,
        JSON.stringify(record.payload),
        JSON.stringify(record.refs),
      );

      for (const write of entityWrites ?? []) {
        const version = (tx
          .prepare('SELECT COALESCE(MAX(version),0) + 1 AS v FROM entity_versions WHERE kind = ? AND entity_id = ?')
          .get(write.kind, write.id) as { v: number }).v;
        const summary = sha256Hex(JSON.stringify(write.data)).slice(0, 16);
        tx.prepare(
          `INSERT INTO entity_versions(kind, entity_id, version, content_summary, created_by_event_id, superseded_by_event_id, data_json)
           VALUES (?,?,?,?,?,NULL,?)`,
        ).run(write.kind, write.id, version, summary, record.id, JSON.stringify(write.data));
      }
      for (const old of supersedes ?? []) {
        tx.prepare(
          'UPDATE entity_versions SET superseded_by_event_id = ? WHERE kind = ? AND entity_id = ? AND version = ?',
        ).run(record.id, old.kind, old.id, old.version);
      }

      tx.prepare('UPDATE branches SET head_event_id = ? WHERE branch_id = ?').run(record.id, e.branchId);
      tx.exec('COMMIT');
      return record;
    } catch (err) {
      tx.exec('ROLLBACK');
      throw err;
    }
  }

  /** 不带引用校验的事件追加：仅用于追加回滚/损坏诊断事件。 */
  appendDiagnosticEvent(e: Omit<EventRecord, 'seq'>, expectedHead: string | null): EventRecord {
    const tx = this.db;
    tx.exec('BEGIN IMMEDIATE');
    try {
      const branch = tx.prepare('SELECT head_event_id FROM branches WHERE branch_id = ?').get(e.branchId) as
        | { head_event_id: string | null }
        | undefined;
      if (!branch) throw new Error(`分支不存在: ${e.branchId}`);
      if (branch.head_event_id !== expectedHead) {
        throw new ConflictError(e.branchId, expectedHead ?? '(empty)', branch.head_event_id ?? '(empty)', '(empty)', '(empty)');
      }
      const seq = (tx.prepare('SELECT COALESCE(MAX(seq),0) + 1 AS s FROM events WHERE branch_id = ?').get(e.branchId) as {
        s: number;
      }).s;
      const record: EventRecord = { ...e, seq };
      tx.prepare(
        `INSERT INTO events(event_id, case_id, branch_id, seq, parent_event_id, base_branch_head, timestamp, code, payload_json, refs_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.id,
        record.caseId,
        record.branchId,
        record.seq,
        record.parentEventId,
        record.baseBranchHead,
        record.timestamp,
        record.code,
        JSON.stringify(record.payload),
        JSON.stringify(record.refs),
      );
      tx.prepare('UPDATE branches SET head_event_id = ? WHERE branch_id = ?').run(record.id, e.branchId);
      tx.exec('COMMIT');
      return record;
    } catch (err) {
      tx.exec('ROLLBACK');
      throw err;
    }
  }

  listEvents(branchId: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE branch_id = ? ORDER BY seq ASC')
      .all(branchId) as EventRow[];
    return rows.map(rowToEvent);
  }

  listAllEvents(caseId: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE case_id = ? ORDER BY timestamp ASC, seq ASC')
      .all(caseId) as EventRow[];
    return rows.map(rowToEvent);
  }

  getEvent(eventId: string): EventRecord | null {
    const row = this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  /** 沿分支线性父链重放（不跨分支），并在每个事件处校验引用版本存在。 */
  replayBranch(branchId: string, untilEventId?: string): EventRecord[] {
    const events = this.listEvents(branchId);
    const out: EventRecord[] = [];
    const existing = new Set<string>();
    for (const ev of events) {
      for (const ref of ev.refs) {
        const row = this.db
          .prepare('SELECT 1 FROM entity_versions WHERE kind = ? AND entity_id = ? AND version = ?')
          .get(ref.kind, ref.id, ref.version);
        if (!row) throw new ReferenceCorruptionError(ref, ev.id);
        void existing;
      }
      out.push(ev);
      if (untilEventId && ev.id === untilEventId) break;
    }
    return out;
  }

  getEntityVersion(kind: string, id: string, version: number) {
    const row = this.db
      .prepare('SELECT * FROM entity_versions WHERE kind = ? AND entity_id = ? AND version = ?')
      .get(kind, id, version) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  getCurrentEntity(kind: string, id: string) {
    const row = this.db
      .prepare(
        'SELECT * FROM entity_versions WHERE kind = ? AND entity_id = ? AND superseded_by_event_id IS NULL ORDER BY version DESC LIMIT 1',
      )
      .get(kind, id) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  listEntityVersions(kind: string, id: string) {
    return (
      this.db
        .prepare('SELECT * FROM entity_versions WHERE kind = ? AND entity_id = ? ORDER BY version')
        .all(kind, id) as EntityRow[]
    ).map(rowToEntity);
  }

  listCurrentEntities(kind: string) {
    return (
      this.db
        .prepare(
          `SELECT * FROM entity_versions ev WHERE superseded_by_event_id IS NULL
           AND version = (SELECT MAX(version) FROM entity_versions WHERE kind = ev.kind AND entity_id = ev.entity_id)
           AND kind = ? ORDER BY entity_id`,
        )
        .all(kind) as EntityRow[]
    ).map(rowToEntity);
  }

  recordDependency(dep: {
    dependentEntityKind: string;
    dependentEntityId: string;
    dependentVersion: number;
    ref: EventRef;
    recordedByEventId: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO dependencies(dependent_entity_kind, dependent_entity_id, dependent_version,
           dependency_ref_kind, dependency_ref_id, dependency_ref_version, recorded_by_event_id)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        dep.dependentEntityKind,
        dep.dependentEntityId,
        dep.dependentVersion,
        dep.ref.kind,
        dep.ref.id,
        dep.ref.version,
        dep.recordedByEventId,
      );
  }

  /** 依赖失效范围：所有在引用版本之外引用了被替换实体版本的派生实体。 */
  dependentsOf(refKind: string, refId: string, changedVersion: number) {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT dependent_entity_kind AS kind, dependent_entity_id AS id, dependent_version AS version
           FROM dependencies WHERE dependency_ref_kind = ? AND dependency_ref_id = ? AND dependency_ref_version < ?`,
        )
        .all(refKind, refId, changedVersion) as { kind: string; id: string; version: number }[]
    );
  }

  acquireFreezeLock(input: {
    lockId: string;
    caseId: string;
    branchId: string;
    candidateId: string;
    eventId: string;
    reconstructionRef: string;
    lockedAt: string;
  }): { ok: true } | { ok: false; competingLockId: string } {
    const tx = this.db;
    tx.exec('BEGIN IMMEDIATE');
    try {
      const existing = tx
        .prepare('SELECT lock_id FROM freeze_locks WHERE case_id = ? AND revoked_event_id IS NULL')
        .get(input.caseId) as { lock_id: string } | undefined;
      if (existing) {
        tx.exec('ROLLBACK');
        return { ok: false, competingLockId: existing.lock_id };
      }
      tx.prepare(
        `INSERT INTO freeze_locks(lock_id, case_id, branch_id, candidate_id, event_id, reconstruction_ref, locked_at, revoked_event_id)
         VALUES (?,?,?,?,?,?,?,NULL)`,
      ).run(
        input.lockId,
        input.caseId,
        input.branchId,
        input.candidateId,
        input.eventId,
        input.reconstructionRef,
        input.lockedAt,
      );
      tx.exec('COMMIT');
      return { ok: true };
    } catch (err) {
      tx.exec('ROLLBACK');
      throw err;
    }
  }

  activeLock(caseId: string) {
    const row = this.db
      .prepare('SELECT * FROM freeze_locks WHERE case_id = ? AND revoked_event_id IS NULL')
      .get(caseId) as
      | {
          lock_id: string;
          branch_id: string;
          candidate_id: string;
          event_id: string;
          reconstruction_ref: string;
          locked_at: string;
        }
      | undefined;
    return row
      ? {
          lockId: row.lock_id,
          branchId: row.branch_id,
          candidateId: row.candidate_id,
          eventId: row.event_id,
          reconstructionRef: row.reconstruction_ref,
          lockedAt: row.locked_at,
        }
      : null;
  }

  revokeLock(lockId: string, eventId: string): void {
    this.db.prepare('UPDATE freeze_locks SET revoked_event_id = ? WHERE lock_id = ?').run(eventId, lockId);
  }
}

interface EventRow {
  event_id: string;
  case_id: string;
  branch_id: string;
  seq: number;
  parent_event_id: string | null;
  base_branch_head: string | null;
  timestamp: string;
  code: EventRecord['code'];
  payload_json: string;
  refs_json: string;
}

function rowToEvent(row: EventRow): EventRecord {
  return {
    id: row.event_id,
    caseId: row.case_id,
    branchId: row.branch_id,
    seq: row.seq,
    parentEventId: row.parent_event_id,
    baseBranchHead: row.base_branch_head,
    timestamp: row.timestamp,
    code: row.code,
    payload: JSON.parse(row.payload_json),
    refs: JSON.parse(row.refs_json),
  };
}

interface EntityRow {
  kind: string;
  entity_id: string;
  version: number;
  content_summary: string;
  created_by_event_id: string;
  superseded_by_event_id: string | null;
  data_json: string;
}

function rowToEntity(row: EntityRow) {
  return {
    kind: row.kind,
    id: row.entity_id,
    version: row.version,
    contentSummary: row.content_summary,
    createdByEventId: row.created_by_event_id,
    supersededByEventId: row.superseded_by_event_id,
    data: JSON.parse(row.data_json),
  };
}
