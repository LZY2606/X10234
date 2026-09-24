import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { digestOf, type EntityRef } from '../domain';

export interface EventRow {
  seq: number;
  event_kind: string;
  branch_id: string | null;
  entity_id: string | null;
  entity_version: number | null;
  payload: unknown;
  created_at: string;
}

export interface BranchRow {
  branch_id: string;
  name: string;
  parent_branch_id: string | null;
  base_seq: number;
  created_seq: number;
}

export interface DecisionRow {
  decision_id: string;
  branch_id: string;
  candidate_entity: string;
  candidate_version: number;
  verdict: 'accepted' | 'rejected';
  reason: string | null;
  author: string | null;
  created_seq: number;
  undone_seq: number | null;
}

export class CorruptionError extends Error {
  readonly code = 'CORRUPTION';
}

export class ConflictError extends Error {
  readonly code = 'CONFLICT';
  constructor(message: string, readonly eventsSinceBase: EventRow[]) {
    super(message);
  }
}

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE blob (
  content_hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE entity (
  entity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE entity_version (
  entity_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (entity_id, version_no)
);
CREATE TABLE event (
  seq INTEGER PRIMARY KEY,
  event_kind TEXT NOT NULL,
  branch_id TEXT,
  entity_id TEXT,
  entity_version INTEGER,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE kv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`
  },
  {
    version: 2,
    sql: `
CREATE TABLE branch (
  branch_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_branch_id TEXT,
  base_seq INTEGER NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE decision (
  decision_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  candidate_entity TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  author TEXT,
  created_seq INTEGER NOT NULL,
  undone_seq INTEGER
);
CREATE TABLE alignment_lock (
  lock_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  candidate_entity TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  locked_by TEXT,
  note TEXT,
  created_seq INTEGER NOT NULL
);
`
  },
  {
    version: 3,
    sql: `
CREATE TABLE entity_ref (
  from_entity TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_entity TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  ref_kind TEXT NOT NULL,
  PRIMARY KEY (from_entity, from_version, to_entity, to_version, ref_kind)
);
CREATE TABLE blob_ref (
  from_entity TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (from_entity, from_version, content_hash, role)
);
CREATE TABLE diagnostic (
  diagnostic_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  raw_value TEXT,
  created_seq INTEGER NOT NULL
);
CREATE TABLE invalidation (
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  invalidated_seq INTEGER NOT NULL,
  cause_event_seq INTEGER NOT NULL,
  PRIMARY KEY (entity_id, entity_version, invalidated_seq)
);
`
  }
];

export class Store {
  private constructor(readonly db: DatabaseSync) {}

  static open(path: string): Store {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    const store = new Store(db);
    store.migrate();
    return store;
  }

  static memory(): Store {
    return Store.open(':memory:');
  }

  close(): void {
    this.db.close();
  }

  migrate(target?: number): void {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      if (target !== undefined && migration.version > target) break;
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.sql);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.db.exec(`PRAGMA user_version=${migration.version}`);
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  maxSeq(): number {
    const row = this.db.prepare("SELECT value FROM kv_meta WHERE key='clock'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  private tick(): number {
    const next = this.maxSeq() + 1;
    this.db
      .prepare(
        `INSERT INTO kv_meta(key,value) VALUES('clock', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      )
      .run(String(next));
    return next;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv_meta WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO kv_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, value);
  }

  /** 不可变内容寻址：相同字节只存一份。 */
  putBlob(bytes: Uint8Array, mediaType: string, explicitSeq?: number): string {
    const hash = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    const seq = explicitSeq ?? this.tick();
    this.db
      .prepare('INSERT OR IGNORE INTO blob(content_hash, media_type, bytes, created_seq) VALUES(?,?,?,?)')
      .run(hash, mediaType, Buffer.from(bytes), seq);
    return hash;
  }

  getBlob(hash: string): { bytes: Buffer; mediaType: string } {
    const row = this.db.prepare('SELECT bytes, media_type FROM blob WHERE content_hash=?').get(hash) as
      | { bytes: Buffer; media_type: string }
      | undefined;
    if (!row) throw new CorruptionError(`内容损坏：缺少被引用的原始字节 ${hash}`);
    return { bytes: Buffer.from(row.bytes), mediaType: row.media_type };
  }

  blobCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS c FROM blob').get() as { c: number }).c);
  }

  createEntity(kind: string, id?: string, explicitSeq?: number): string {
    const entityId = id ?? randomUUID();
    this.db
      .prepare('INSERT INTO entity(entity_id, kind, created_seq) VALUES(?,?,?)')
      .run(entityId, kind, explicitSeq ?? this.tick());
    return entityId;
  }

  listEntities(kind?: string): { entity_id: string; kind: string }[] {
    if (kind) return this.db.prepare('SELECT entity_id, kind FROM entity WHERE kind=? ORDER BY entity_id').all(kind) as never;
    return this.db.prepare('SELECT entity_id, kind FROM entity ORDER BY entity_id').all() as never;
  }

  /**
   * 新增解释版本。所有引用必须存在（实体版本与原始字节），缺少引用直接报损坏，
   * 绝不退回当前最新版。
   */
  addVersion(
    entityId: string,
    branchId: string,
    payload: unknown,
    options: {
      refs?: EntityRef[];
      blobs?: { hash: string; role: string }[];
      explicitSeq?: number;
    } = {}
  ): number {
    const refs = options.refs ?? [];
    const blobs = options.blobs ?? [];
    for (const ref of refs) {
      const found = this.db
        .prepare('SELECT 1 FROM entity_version WHERE entity_id=? AND version_no=?')
        .get(ref.entityId, ref.versionNo);
      if (!found) throw new CorruptionError(`引用损坏：${ref.entityId}@${ref.versionNo} 不存在`);
    }
    for (const blobRef of blobs) {
      const found = this.db.prepare('SELECT 1 FROM blob WHERE content_hash=?').get(blobRef.hash);
      if (!found) throw new CorruptionError(`引用损坏：原始字节 ${blobRef.hash} 不存在`);
    }
    const maxRow = this.db
      .prepare('SELECT COALESCE(MAX(version_no),0) AS v FROM entity_version WHERE entity_id=?')
      .get(entityId) as { v: number };
    const versionNo = maxRow.v + 1;
    const seq = options.explicitSeq ?? this.tick();
    this.db
      .prepare(
        `INSERT INTO entity_version(entity_id, version_no, branch_id, payload, content_digest, created_seq)
         VALUES(?,?,?,?,?,?)`
      )
      .run(entityId, versionNo, branchId, JSON.stringify(payload), digestOf(payload), seq);
    const refStmt = this.db.prepare(
      'INSERT INTO entity_ref(from_entity, from_version, to_entity, to_version, ref_kind) VALUES(?,?,?,?,?)'
    );
    for (const ref of refs) {
      refStmt.run(entityId, versionNo, ref.entityId, ref.versionNo, ref.kind ?? 'uses');
    }
    const blobStmt = this.db.prepare(
      'INSERT INTO blob_ref(from_entity, from_version, content_hash, role) VALUES(?,?,?,?)'
    );
    for (const blobRef of blobs) {
      blobStmt.run(entityId, versionNo, blobRef.hash, blobRef.role);
    }
    return versionNo;
  }

  /** 读取指定版本：返回内容摘要与全部引用（附摘要）；缺引用即损坏。 */
  getVersion<T = unknown>(entityId: string, versionNo: number): {
    payload: T;
    digest: string;
    branchId: string;
    createdSeq: number;
    refs: (EntityRef & { digest: string })[];
    blobs: { hash: string; role: string; mediaType: string }[];
  } {
    const row = this.db
      .prepare('SELECT payload, content_digest, branch_id, created_seq FROM entity_version WHERE entity_id=? AND version_no=?')
      .get(entityId, versionNo) as
      | { payload: string; content_digest: string; branch_id: string; created_seq: number }
      | undefined;
    if (!row) throw new CorruptionError(`实体版本不存在：${entityId}@${versionNo}`);

    const blobRows = this.db
      .prepare(
        `SELECT br.content_hash, br.role, b.media_type FROM blob_ref br
         LEFT JOIN blob b ON b.content_hash = br.content_hash
         WHERE br.from_entity=? AND br.from_version=?`
      )
      .all(entityId, versionNo) as { content_hash: string; role: string; media_type: string | null }[];
    const blobs = blobRows.map((blobRow) => {
      if (!blobRow.media_type) throw new CorruptionError(`内容损坏：缺少原始字节 ${blobRow.content_hash}`);
      return { hash: blobRow.content_hash, role: blobRow.role, mediaType: blobRow.media_type };
    });

    const refRows = this.db
      .prepare(
        `SELECT to_entity, to_version, ref_kind FROM entity_ref
         WHERE from_entity=? AND from_version=?`
      )
      .all(entityId, versionNo) as { to_entity: string; to_version: number; ref_kind: string }[];
    const refs = refRows.map((refRow) => {
      const target = this.db
        .prepare('SELECT content_digest FROM entity_version WHERE entity_id=? AND version_no=?')
        .get(refRow.to_entity, refRow.to_version) as { content_digest: string } | undefined;
      if (!target) throw new CorruptionError(`引用损坏：${refRow.to_entity}@${refRow.to_version} 已丢失`);
      return {
        entityId: refRow.to_entity,
        versionNo: refRow.to_version,
        kind: refRow.ref_kind,
        digest: target.content_digest
      };
    });

    return {
      payload: JSON.parse(row.payload) as T,
      digest: row.content_digest,
      branchId: row.branch_id,
      createdSeq: row.created_seq,
      refs,
      blobs
    };  }

  latest(
    entityId: string,
    branchId: string,
    asOfSeq?: number
  ): { versionNo: number; digest: string; payload: unknown; branchId: string; createdSeq: number } | null {
    const branch = this.getBranch(branchId);
    const cap = asOfSeq ?? this.maxSeq();
    const row = this.db
      .prepare(
        `SELECT version_no, content_digest, payload, branch_id, created_seq FROM entity_version
         WHERE entity_id=? AND created_seq<=?
           AND (branch_id=? OR created_seq<=?)
         ORDER BY version_no DESC LIMIT 1`
      )
      .get(entityId, cap, branchId, branch ? branch.base_seq : 0) as
      | { version_no: number; content_digest: string; payload: string; branch_id: string; created_seq: number }
      | undefined;
    if (!row) return null;
    return {
      versionNo: row.version_no,
      digest: row.content_digest,
      payload: JSON.parse(row.payload),
      branchId: row.branch_id,
      createdSeq: row.created_seq
    };
  }

  emit(
    kind: string,
    data: { branchId?: string; entityId?: string; entityVersion?: number; payload?: unknown } = {},
    explicitSeq?: number
  ): number {
    const seq = explicitSeq ?? this.tick();
    this.db
      .prepare(
        `INSERT INTO event(seq, event_kind, branch_id, entity_id, entity_version, payload, created_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(
        seq,
        kind,
        data.branchId ?? null,
        data.entityId ?? null,
        data.entityVersion ?? null,
        JSON.stringify(data.payload ?? {}),
        new Date().toISOString()
      );
    return seq;
  }

  events(sinceSeq = -1): EventRow[] {
    const rows = this.db
      .prepare('SELECT seq, event_kind, branch_id, entity_id, entity_version, payload, created_at FROM event WHERE seq>? ORDER BY seq')
      .all(sinceSeq) as Omit<EventRow, 'payload'>[];
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload as unknown as string) })) as EventRow[];
  }

  private checkBase(baseSeq: number): void {
    const current = this.maxSeq();
    if (current > baseSeq) {
      throw new ConflictError(
        `版本冲突：提交基线 seq=${baseSeq}，当前 seq=${current}，后提交者必须查看双方差异后重试`,
        this.events(baseSeq)
      );
    }
  }

  createBranch(branchId: string, name: string, parentBranchId: string | null, baseSeq?: number): void {
    this.db
      .prepare(
        'INSERT INTO branch(branch_id, name, parent_branch_id, base_seq, created_seq) VALUES(?,?,?,?,?)'
      )
      .run(branchId, name, parentBranchId, baseSeq ?? this.maxSeq(), this.tick());
  }

  branches(): BranchRow[] {
    return this.db
      .prepare('SELECT branch_id, name, parent_branch_id, base_seq, created_seq FROM branch ORDER BY base_seq, created_seq')
      .all() as never;
  }

  getBranch(branchId: string): BranchRow | null {
    return (
      (this.db
        .prepare('SELECT branch_id, name, parent_branch_id, base_seq, created_seq FROM branch WHERE branch_id=?')
        .get(branchId) as BranchRow | undefined) ?? null
    );
  }

  decide(input: {
    branchId: string;
    candidateEntity: string;
    candidateVersion: number;
    verdict: 'accepted' | 'rejected';
    reason: string;
    author: string;
    baseSeq: number;
  }): { decisionId: string; seq: number } {
    this.checkBase(input.baseSeq);
    this.getVersion(input.candidateEntity, input.candidateVersion);
    const decisionSeq = this.tick();
    const decisionId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO decision(decision_id, branch_id, candidate_entity, candidate_version, verdict, reason, author, created_seq, undone_seq)
         VALUES(?,?,?,?,?,?,?,?,NULL)`
      )
      .run(
        decisionId,
        input.branchId,
        input.candidateEntity,
        input.candidateVersion,
        input.verdict,
        input.reason,
        input.author,
        decisionSeq
      );
    const seq = this.emit(input.verdict === 'accepted' ? 'decision.accepted' : 'decision.rejected', {
      branchId: input.branchId,
      entityId: input.candidateEntity,
      entityVersion: input.candidateVersion,
      payload: {
        decisionId,
        verdict: input.verdict,
        reason: input.reason,
        author: input.author
      }
    });
    return { decisionId, seq };
  }

  undoDecision(decisionId: string, baseSeq: number): number {
    this.checkBase(baseSeq);
    const row = this.db.prepare('SELECT decision_id FROM decision WHERE decision_id=? AND undone_seq IS NULL').get(decisionId) as
      | { decision_id: string }
      | undefined;
    if (!row) throw new CorruptionError(`没有可撤销的裁定：${decisionId}`);
    const seq = this.tick();
    this.db.prepare('UPDATE decision SET undone_seq=? WHERE decision_id=?').run(seq, decisionId);
    return this.emit('decision.undone', { payload: { decisionId } });
  }

  decisions(branchId: string): DecisionRow[] {
    return this.db
      .prepare('SELECT * FROM decision WHERE branch_id=? ORDER BY created_seq')
      .all(branchId) as never;
  }

  /** 某时刻的有效裁定：撤销事件晚于该时刻的裁定仍然有效。 */
  activeDecision(branchId: string, asOfSeq = this.maxSeq()): DecisionRow | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM decision
         WHERE branch_id=? AND created_seq<=? AND (undone_seq IS NULL OR undone_seq>?)
         ORDER BY created_seq DESC LIMIT 1`
      )
      .all(branchId, asOfSeq, asOfSeq) as DecisionRow[];
    return rows[0] ?? null;
  }

  lock(input: {
    branchId: string;
    candidateEntity: string;
    candidateVersion: number;
    lockedBy: string;
    note: string;
    baseSeq: number;
  }): { lockId: string; seq: number } {
    this.checkBase(input.baseSeq);
    this.getVersion(input.candidateEntity, input.candidateVersion);
    const existing = this.db
      .prepare('SELECT 1 FROM alignment_lock WHERE branch_id=?')
      .get(input.branchId);
    if (existing) {
      throw new ConflictError(`分支 ${input.branchId} 已存在冻结版本，需要先显式解冻或另开分支`, this.events(input.baseSeq));
    }
    const lockId = randomUUID();
    const createdSeq = this.tick();
    this.db
      .prepare(
        'INSERT INTO alignment_lock(lock_id, branch_id, candidate_entity, candidate_version, locked_by, note, created_seq) VALUES(?,?,?,?,?,?,?)'
      )
      .run(
        lockId,
        input.branchId,
        input.candidateEntity,
        input.candidateVersion,
        input.lockedBy,
        input.note,
        createdSeq
      );
    const seq = this.emit('alignment.locked', {
      branchId: input.branchId,
      entityId: input.candidateEntity,
      entityVersion: input.candidateVersion,
      payload: { lockId, lockedBy: input.lockedBy, note: input.note }
    });
    return { lockId, seq };
  }

  locks(branchId?: string): {
    lock_id: string;
    branch_id: string;
    candidate_entity: string;
    candidate_version: number;
    locked_by: string | null;
    note: string | null;
    created_seq: number;
  }[] {
    if (branchId) {
      return this.db
        .prepare('SELECT * FROM alignment_lock WHERE branch_id=? ORDER BY created_seq')
        .all(branchId) as never;
    }
    return this.db.prepare('SELECT * FROM alignment_lock ORDER BY created_seq').all() as never;
  }

  activeLock(branchId: string, asOfSeq = this.maxSeq()) {
    return (
      (this.db
        .prepare('SELECT * FROM alignment_lock WHERE branch_id=? AND created_seq<=? ORDER BY created_seq DESC LIMIT 1')
        .get(branchId, asOfSeq) as ReturnType<Store['locks']>[number] | undefined) ?? null
    );
  }

  addDiagnostic(
    entityId: string,
    versionNo: number,
    code: string,
    message: string,
    rawValue?: unknown,
    explicitSeq?: number
  ): string {
    const diagnosticId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO diagnostic(diagnostic_id, entity_id, entity_version, code, message, raw_value, created_seq) VALUES(?,?,?,?,?,?,?)'
      )
      .run(diagnosticId, entityId, versionNo, code, message, rawValue === undefined ? null : JSON.stringify(rawValue), explicitSeq ?? this.tick());
    return diagnosticId;
  }

  diagnostics(entityId: string, versionNo?: number) {
    if (versionNo !== undefined) {
      return this.db
        .prepare('SELECT diagnostic_id, entity_id, entity_version, code, message, raw_value, created_seq FROM diagnostic WHERE entity_id=? AND entity_version=? ORDER BY created_seq')
        .all(entityId, versionNo) as never;
    }
    return this.db
      .prepare('SELECT diagnostic_id, entity_id, entity_version, code, message, raw_value, created_seq FROM diagnostic WHERE entity_id=? ORDER BY created_seq')
      .all(entityId) as never;
  }

  /**
   * 依赖失效：某实体出现新版本后，沿 entity_ref 反向闭包计算受影响范围。
   * 旧结论只标记失效，不删除、不被最新结果悄悄替换。
   */
  invalidateForNewVersion(entityId: string): { affected: { entityId: string; versionNo: number }[]; seq: number } {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE affected(entity_id, version_no) AS (
           SELECT from_entity, from_version FROM entity_ref
            WHERE to_entity = :id
              AND to_version < (SELECT MAX(version_no) FROM entity_version WHERE entity_id = :id)
           UNION
           SELECT r.from_entity, r.from_version
             FROM entity_ref r
             JOIN affected a ON r.to_entity = a.entity_id AND r.to_version = a.version_no
         )
         SELECT DISTINCT entity_id, version_no FROM affected`
      )
      .all({ id: entityId }) as { entity_id: string; version_no: number }[];
    const affected = rows
      .map((row) => ({ entityId: row.entity_id, versionNo: row.version_no }))
      .filter((item) => item.entityId !== entityId);
    const seq = this.tick();
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO invalidation(entity_id, entity_version, invalidated_seq, cause_event_seq) VALUES(?,?,?,?)'
    );
    for (const item of affected) {
      insert.run(item.entityId, item.versionNo, seq, seq);
    }
    return { affected, seq };
  }

  isInvalidated(entityId: string, versionNo: number): { invalidatedSeq: number } | null {
    const row = this.db
      .prepare('SELECT MIN(invalidated_seq) AS s FROM invalidation WHERE entity_id=? AND entity_version=?')
      .get(entityId, versionNo) as { s: number | null } | undefined;
    return row && row.s ? { invalidatedSeq: row.s } : null;
  }

  /** 时间回放：任意 seq 时刻，实体版本/裁定/冻结恢复为当时的依赖版本与可见结论。 */
  stateAsOf(seq: number) {
    const versions = this.db
      .prepare(
        `SELECT v.entity_id, v.version_no, v.branch_id, v.content_digest, v.created_seq,
                e.kind
           FROM entity_version v JOIN entity e ON e.entity_id = v.entity_id
          WHERE v.created_seq<=?
            AND v.version_no = (
              SELECT MAX(v2.version_no) FROM entity_version v2
               WHERE v2.entity_id = v.entity_id AND v2.created_seq<=?
                 AND (v2.branch_id = v.branch_id OR v2.created_seq <=
                      COALESCE((SELECT b.base_seq FROM branch b WHERE b.branch_id = v.branch_id), 0)))
          ORDER BY v.entity_id`
      )
      .all(seq, seq) as {
      entity_id: string;
      version_no: number;
      branch_id: string;
      content_digest: string;
      created_seq: number;
      kind: string;
    }[];
    const decisions = this.db
      .prepare(
        `SELECT * FROM decision WHERE created_seq<=? AND (undone_seq IS NULL OR undone_seq>?) ORDER BY created_seq`
      )
      .all(seq, seq) as DecisionRow[];
    const locks = this.db
      .prepare('SELECT * FROM alignment_lock WHERE created_seq<=? ORDER BY created_seq')
      .all(seq) as ReturnType<Store['locks']>;
    return { seq, versions, decisions, locks, events: this.events(0).filter((event) => event.seq <= seq) };
  }
}
