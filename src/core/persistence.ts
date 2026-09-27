import { getSql } from './sqlite.js';
import type { DependencyEdge, Uid } from './domain.js';
import type { ArchiveEvent, StoredContent } from './events.js';
import { canonicalJson, sha256, sha256Canonical } from './hash.js';

const LATEST_SCHEMA = 2;

export class CorruptArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptArchiveError';
  }
}

export class VersionConflictError extends Error {
  constructor(
    message: string,
    readonly expectedHead: number,
    readonly actualHead: number,
    readonly sessionId: Uid,
  ) {
    super(message);
    this.name = 'VersionConflictError';
  }
}

interface Row {
  [col: string]: Uint8Array | string | number | null;
}

/**
 * SQLite 持久化。事件只追加；内容按内容寻址去重（最小输入与组合输入共享的原始片段只存一份）。
 * 分支头带乐观锁版本；冻结的会话无法提交（并发冻结检验）。
 */
export class ArchiveStore {
  private db!: initSqlJs.Database;
  private constructor(private readonly sql: initSqlJs.SqlJsStatic) {}

  static async open(bytes?: Uint8Array): Promise<ArchiveStore> {
    const sql = await getSql();
    const store = new ArchiveStore(sql);
    store.db = bytes ? new sql.Database(bytes) : new sql.Database();
    store.migrate();
    return store;
  }

  private migrate(): void {
    const current = this.meta('schema_version');
    if (current === null) {
      this.db.run(SCHEMA_V1);
      this.setMeta('schema_version', '1');
    }
    // v1 -> v2：增加 source 来源表与依赖失效范围索引
    if (Number(this.meta('schema_version')) < 2) {
      this.db.run(SCHEMA_V2);
      this.setMeta('schema_version', '2');
    }
    if (Number(this.meta('schema_version')) !== LATEST_SCHEMA) {
      throw new CorruptArchiveError(`unsupported schema_version=${this.meta('schema_version')}`);
    }
  }

  static async fromBytes(bytes: Uint8Array): Promise<ArchiveStore> {
    return ArchiveStore.open(bytes);
  }

  export(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }

  private meta(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    stmt.bind([key]);
    let value: string | null = null;
    if (stmt.step()) value = (stmt.getAsObject() as Row).value as string;
    stmt.free();
    return value;
  }

  private setMeta(key: string, value: string): void {
    this.db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      key,
      value,
    ]);
  }

  // ---- 内容寻址 ----

  putContent(content: StoredContent): void {
    const existing = this.contentDigest(content.digest);
    if (existing) {
      // 已存在不可变内容：只登记共享来源，绝不覆盖
      for (const ref of content.sharedWith) {
        this.db.run('INSERT OR IGNORE INTO content_refs(digest, ref_owner) VALUES (?, ?)', [content.digest, ref]);
      }
      return;
    }
    this.db.run('INSERT INTO contents(digest, bytes, media_type) VALUES (?, ?, ?)', [
      content.digest,
      content.bytes,
      content.mediaType,
    ]);
    for (const ref of content.sharedWith) {
      this.db.run('INSERT OR IGNORE INTO content_refs(digest, ref_owner) VALUES (?, ?)', [content.digest, ref]);
    }
  }

  getContent(digest: string): StoredContent | null {
    const stmt = this.db.prepare(
      'SELECT digest, bytes, media_type FROM contents WHERE digest = ?',
    );
    stmt.bind([digest]);
    let result: StoredContent | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as Row;
      result = {
        digest: row.digest as string,
        bytes: row.bytes as Uint8Array,
        mediaType: row.media_type as string,
        sharedWith: this.contentOwners(digest),
      };
    }
    stmt.free();
    return result;
  }

  private contentDigest(digest: string): string | null {
    const stmt = this.db.prepare('SELECT digest FROM contents WHERE digest = ?');
    stmt.bind([digest]);
    let result: string | null = null;
    if (stmt.step()) result = (stmt.getAsObject() as Row).digest as string;
    stmt.free();
    return result;
  }

  private contentOwners(digest: string): Uid[] {
    const stmt = this.db.prepare('SELECT ref_owner FROM content_refs WHERE digest = ? ORDER BY ref_owner');
    stmt.bind([digest]);
    const owners: Uid[] = [];
    while (stmt.step()) owners.push((stmt.getAsObject() as Row).ref_owner as Uid);
    stmt.free();
    return owners;
  }

  // ---- 实体版本（来源与解释拆开；缺引用即损坏） ----

  putEntityVersion(entity: string, version: number, digest: string, value: unknown): void {
    this.db.run(
      'INSERT INTO entity_versions(entity, version, digest, json) VALUES (?, ?, ?, ?) ON CONFLICT(entity, version) DO NOTHING',
      [entity, version, digest, JSON.stringify(value)],
    );
  }

  getEntityVersion(entity: string, version: number): { digest: string; value: unknown } | null {
    const stmt = this.db.prepare('SELECT digest, json FROM entity_versions WHERE entity = ? AND version = ?');
    stmt.bind([entity, version]);
    let result: { digest: string; value: unknown } | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as Row;
      result = { digest: row.digest as string, value: JSON.parse(row.json as string) };
    }
    stmt.free();
    return result;
  }

  listEntityVersions(entity: string): number[] {
    const stmt = this.db.prepare('SELECT version FROM entity_versions WHERE entity = ? ORDER BY version');
    stmt.bind([entity]);
    const versions: number[] = [];
    while (stmt.step()) versions.push((stmt.getAsObject() as Row).version as number);
    stmt.free();
    return versions;
  }

  // ---- 事件只追加 ----

  lastEventId(): number {
    const stmt = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events');
    let result = 0;
    if (stmt.step()) result = (stmt.getAsObject() as Row).m as number;
    stmt.free();
    return result;
  }

  getEvent(id: number): ArchiveEvent | null {
    const stmt = this.db.prepare('SELECT json FROM events WHERE id = ?');
    stmt.bind([id]);
    let result: ArchiveEvent | null = null;
    if (stmt.step()) result = JSON.parse((stmt.getAsObject() as Row).json as string) as ArchiveEvent;
    stmt.free();
    return result;
  }

  listEvents(seriesId?: Uid): ArchiveEvent[] {
    const events: ArchiveEvent[] = [];
    let stmt: initSqlJs.Statement;
    if (seriesId) {
      stmt = this.db.prepare('SELECT json FROM events WHERE series_id = ? ORDER BY id');
      stmt.bind([seriesId]);
    } else {
      stmt = this.db.prepare('SELECT json FROM events ORDER BY id');
    }
    while (stmt.step()) events.push(JSON.parse((stmt.getAsObject() as Row).json as string) as ArchiveEvent);
    stmt.free();
    return events;
  }

  /**
   * 追加事件。expectedHead 是调用方读到的分支头；并发保存时后提交者得到 VersionConflictError。
   * 冻结会话提交直接拒绝（并发冻结），双方差异写入 conflict 事件由上层处理。
   */
  appendEvent(input: {
    branchId: Uid | null;
    payload: ArchiveEvent['payload'];
    refs: ArchiveEvent['refs'];
    dependencies: DependencyEdge[];
    authorSessionId: Uid;
    expectedHead: number;
    parentCommitDigest: string | null;
    createdAt: string;
  }): ArchiveEvent {
    if (this.isFrozen(input.authorSessionId)) {
      throw new VersionConflictError('session frozen by unresolved concurrent save', this.branchHead(input.branchId), this.branchHead(input.branchId), input.authorSessionId);
    }

    const actualHead = this.branchHead(input.branchId);
    if (actualHead !== input.expectedHead) {
      throw new VersionConflictError(
        `branch head moved: expected ${input.expectedHead}, actual ${actualHead}`,
        input.expectedHead,
        actualHead,
        input.authorSessionId,
      );
    }

    const id = this.lastEventId() + 1;
    const seriesId = ('seriesId' in input.payload ? input.payload.seriesId : 'GLOBAL') as Uid;
    const commitBody = canonicalJson({
      parent: input.parentCommitDigest,
      payload: input.payload,
      refs: input.refs,
      deps: input.dependencies,
      id,
    });
    const commitDigest = `commit:${fnv1a(commitBody)}`;

    const event: ArchiveEvent = {
      id,
      seriesId,
      branchId: input.branchId,
      payload: input.payload,
      commitDigest,
      parentCommitDigest: input.parentCommitDigest,
      authorSessionId: input.authorSessionId,
      createdAt: input.createdAt,
      refs: input.refs,
      dependencies: input.dependencies,
    };

    this.db.run('BEGIN');
    try {
      this.db.run(
        'INSERT INTO events(id, series_id, branch_id, json) VALUES (?, ?, ?, ?)',
        [id, seriesId, input.branchId, JSON.stringify(event)],
      );
      this.db.run(
        'INSERT INTO branch_heads(branch_id, head_event_id) VALUES (?, ?) ON CONFLICT(branch_id) DO UPDATE SET head_event_id = excluded.head_event_id',
        [input.branchId ?? 'GLOBAL', id],
      );
      for (const dep of input.dependencies) {
        this.db.run(
          'INSERT INTO dependencies(from_entity, from_version, to_entity, to_version, scope) VALUES (?, ?, ?, ?, ?)',
          [dep.fromEntity, dep.fromVersion, dep.toEntity, dep.toVersion, dep.scope],
        );
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
    return event;
  }

  branchHead(branchId: Uid | null): number {
    const stmt = this.db.prepare('SELECT head_event_id FROM branch_heads WHERE branch_id = ?');
    stmt.bind([branchId ?? 'GLOBAL']);
    let result = 0;
    if (stmt.step()) result = (stmt.getAsObject() as Row).head_event_id as number;
    stmt.free();
    return result;
  }

  // ---- 并发冻结 ----

  freezeSession(sessionId: Uid): void {
    this.db.run('INSERT OR IGNORE INTO frozen_sessions(session_id) VALUES (?)', [sessionId]);
  }

  isFrozen(sessionId: Uid): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM frozen_sessions WHERE session_id = ?');
    stmt.bind([sessionId]);
    const found = stmt.step();
    stmt.free();
    return found;
  }

  unfreezeSession(sessionId: Uid): void {
    this.db.run('DELETE FROM frozen_sessions WHERE session_id = ?', [sessionId]);
  }

  // ---- 完整性：引用必须存在，否则损坏 ----

  verifyIntegrity(): { ok: true } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    for (const event of this.listEvents()) {
      for (const ref of event.refs) {
        if (!this.getEvent(ref.version)) {
          errors.push(`event ${event.id} references missing version ${ref.version} (${ref.entity})`);
        }
      }
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  assertCommitChain(): void {
    let previous: string | null = null;
    for (const event of this.listEvents()) {
      if (event.parentCommitDigest !== previous) {
        throw new CorruptArchiveError(`commit chain broken at event ${event.id}`);
      }
      const commitBody = canonicalJson({
        parent: event.parentCommitDigest,
        payload: event.payload,
        refs: event.refs,
        deps: event.dependencies,
        id: event.id,
      });
      if (`commit:${fnv1a(commitBody)}` !== event.commitDigest) {
        throw new CorruptArchiveError(`commit digest mismatch at event ${event.id}`);
      }
      previous = event.commitDigest;
    }
  }
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const SCHEMA_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE contents (
  digest TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  media_type TEXT NOT NULL
);
CREATE TABLE content_refs (
  digest TEXT NOT NULL,
  ref_owner TEXT NOT NULL,
  PRIMARY KEY (digest, ref_owner)
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  series_id TEXT NOT NULL,
  branch_id TEXT,
  json TEXT NOT NULL
);
CREATE TABLE branch_heads (
  branch_id TEXT PRIMARY KEY,
  head_event_id INTEGER NOT NULL
);
CREATE TABLE frozen_sessions (session_id TEXT PRIMARY KEY);
CREATE TABLE entity_versions (
  entity TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (entity, version)
);
`;

const SCHEMA_V2 = `
CREATE TABLE dependencies (
  from_entity TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_entity TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  PRIMARY KEY (from_entity, from_version, to_entity, to_version)
);
CREATE INDEX idx_dependencies_target ON dependencies(to_entity, to_version);
`;

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  return sha256(bytes);
}

export async function digestCanonical(value: unknown): Promise<string> {
  return sha256Canonical(value);
}
