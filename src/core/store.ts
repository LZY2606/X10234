import Database from 'better-sqlite3';
import type {
  DomainEvent,
  EntityKind,
  EntityRecord,
  StableId,
  VersionRef,
} from '../shared/types';
import { canonicalJson, sha256, sha256Json } from './hash';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations';

export class CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptionError';
  }
}

export class VersionConflictError extends Error {
  constructor(
    message: string,
    public expectedVersion: number,
    public actualVersion: number,
    public diff: unknown,
  ) {
    super(message);
    this.name = 'VersionConflictError';
  }
}

export interface StoreOptions {
  path: string;
  readonly?: boolean;
}

export function openStore(path: string, opts: { readonly?: boolean } = {}): TiltStore {
  return new TiltStore(path, opts);
}

export class TiltStore {
  readonly db: Database.Database;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    this.db = new Database(path, { readonly: opts.readonly ?? false });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    if (!opts.readonly) this.migrate();
  }

  migrate(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    const current = row ? Number(row.value) : 0;
    const apply = this.db.transaction((target: number) => {
      for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        this.db.exec(m.sql);
        this.db
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(m.version, new Date().toISOString());
      }
      this.db
        .prepare(
          "INSERT INTO meta(key,value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(target));
    });
    apply(LATEST_SCHEMA_VERSION);
  }

  schemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  // ---------- 不可变 blob ----------

  putBlob(bytes: Buffer, mediaType: string): { digest: string; stored: boolean } {
    const digest = sha256(bytes);
    const existing = this.db.prepare('SELECT digest FROM blobs WHERE digest=?').get(digest);
    if (existing) return { digest, stored: false };
    this.db
      .prepare(
        'INSERT INTO blobs(digest, bytes, media_type, byte_length, ingested_at) VALUES (?,?,?,?,?)',
      )
      .run(digest, bytes, mediaType, bytes.length, new Date().toISOString());
    return { digest, stored: true };
  }

  getBlob(digest: string): { bytes: Buffer; mediaType: string } | null {
    const row = this.db
      .prepare('SELECT bytes, media_type FROM blobs WHERE digest=?')
      .get(digest) as { bytes: Buffer; mediaType: string } | undefined;
    return row ? { bytes: Buffer.from(row.bytes), mediaType: row.media_type } : null;
  }

  // ---------- 工作区与分支 ----------

  createWorkspace(id: StableId, name: string): void {
    this.db
      .prepare('INSERT INTO workspaces(id,name,created_at) VALUES (?,?,?)')
      .run(id, name, new Date().toISOString());
  }

  getWorkspace(id: StableId): { id: StableId; name: string } | null {
    return (
      (this.db.prepare('SELECT id, name FROM workspaces WHERE id=?').get(id) as
        | { id: StableId; name: string }
        | undefined) ?? null
    );
  }

  listWorkspaces(): Array<{ id: StableId; name: string }> {
    return this.db.prepare('SELECT id, name FROM workspaces ORDER BY created_at').all() as Array<{
      id: StableId;
      name: string;
    }>;
  }

  createBranch(branchId: string, workspaceId: StableId, name: string, parent: string | null): void {
    this.db
      .prepare(
        'INSERT INTO branches(branch_id, workspace_id, parent_branch_id, name, created_at) VALUES (?,?,?,?,?)',
      )
      .run(branchId, workspaceId, parent, name, new Date().toISOString());
  }

  setBranchHead(branchId: string, interpretationId: string): void {
    this.db.prepare('UPDATE branches SET head_interpretation_id=? WHERE branch_id=?').run(
      interpretationId,
      branchId,
    );
  }

  listBranches(workspaceId: StableId): Array<{
    branch_id: string;
    parent_branch_id: string | null;
    name: string;
  }> {
    return this.db
      .prepare(
        'SELECT branch_id, parent_branch_id, name FROM branches WHERE workspace_id=? ORDER BY created_at',
      )
      .all(workspaceId) as Array<{
      branch_id: string;
      parent_branch_id: string | null;
      name: string;
    }>;
  }

  // ---------- 实体版本 ----------

  /**
   * 写入一个新版本。同一 id 版本号单调递增；旧版本保持可读。
   * refs 必须全部能解析到具体版本（缺少引用 -> CorruptionError，不退回最新版）。
   */
  putEntity<T>(args: {
    id: StableId;
    kind: EntityKind;
    branchId: string;
    payload: T;
    refs?: VersionRef[];
    now?: string;
  }): EntityRecord<T> {
    const { id, kind, branchId, payload } = args;
    const refs = args.refs ?? collectRefs(payload);
    const now = args.now ?? new Date().toISOString();
    const maxRow = this.db
      .prepare('SELECT MAX(version) AS v FROM entity_versions WHERE id=?')
      .get(id) as { v: number | null };
    const version = (maxRow.v ?? 0) + 1;
    for (const ref of refs) this.assertRefResolvable(ref);
    const payloadJson = canonicalJson(payload);
    const digest = sha256Json({ id, kind, version, payload: payloadJson });
    this.db
      .prepare(
        `INSERT INTO entity_versions(id,version,kind,digest,branch_id,payload_json,refs_json,superseded_by,created_at)
         VALUES (?,?,?,?,?,?,?,NULL,?)`,
      )
      .run(id, version, kind, digest, branchId, payloadJson, canonicalJson(refs), now);
    return {
      id,
      version,
      kind,
      digest,
      branch_id: branchId,
      payload,
      refs,
      created_at: now,
      superseded_by: null,
    };
  }

  getEntity<T = unknown>(id: StableId, version?: number): EntityRecord<T> | null {
    const row =
      version === undefined
        ? (this.db
            .prepare(
              'SELECT * FROM entity_versions WHERE id=? ORDER BY version DESC LIMIT 1',
            )
            .get(id) as EntityRow | undefined)
        : (this.db
            .prepare('SELECT * FROM entity_versions WHERE id=? AND version=?')
            .get(id, version) as EntityRow | undefined);
    return row ? this.rowToRecord<T>(row) : null;
  }

  /** 按精确版本引用读取；引用缺失或版本不存在一律报损坏 */
  getByRef<T = unknown>(ref: VersionRef): EntityRecord<T> {
    if (!ref?.id || !ref.version) {
      throw new CorruptionError(`损坏：引用缺少 id/version (${JSON.stringify(ref)})`);
    }
    const rec = this.getEntity<T>(ref.id, ref.version);
    if (!rec) {
      throw new CorruptionError(
        `损坏：引用不可解析 ${ref.kind}:${ref.id}@v${ref.version}（不允许退回最新版）`,
      );
    }
    if (ref.digest && rec.digest !== ref.digest) {
      throw new CorruptionError(
        `损坏：${ref.id}@v${ref.version} 摘要不一致 ${rec.digest} != ${ref.digest}`,
      );
    }
    return rec;
  }

  assertRefResolvable(ref: VersionRef): void {
    if (ref.kind === 'blob') {
      if (!this.getBlob(ref.id)) {
        throw new CorruptionError(`损坏：blob 引用缺失 ${ref.id}`);
      }
      return;
    }
    this.getByRef(ref);
  }

  listEntities<T = unknown>(kind: EntityKind): Array<EntityRecord<T>> {
    const rows = this.db
      .prepare('SELECT * FROM entity_versions WHERE kind=? ORDER BY created_at, id, version')
      .all(kind) as EntityRow[];
    return rows.map((r) => this.rowToRecord<T>(r));
  }

  /** 每个稳定 id 的最新版本（列表视图用） */
  listLatest<T = unknown>(kind: EntityKind): Array<EntityRecord<T>> {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entity_versions e
         JOIN (SELECT id, MAX(version) mv FROM entity_versions WHERE kind=? GROUP BY id) m
         ON e.id=m.id AND e.version=m.mv ORDER BY e.created_at`,
      )
      .all(kind) as EntityRow[];
    return rows.map((r) => this.rowToRecord<T>(r));
  }

  versionsOf(id: StableId): number[] {
    const rows = this.db
      .prepare('SELECT version FROM entity_versions WHERE id=? ORDER BY version')
      .all(id) as Array<{ version: number }>;
    return rows.map((r) => r.version);
  }

  markSuperseded(id: StableId, version: number, by: StableId): void {
    this.db
      .prepare('UPDATE entity_versions SET superseded_by=? WHERE id=? AND version=?')
      .run(by, id, version);
  }

  private rowToRecord<T>(row: EntityRow): EntityRecord<T> {
    return {
      id: row.id,
      version: row.version,
      kind: row.kind as EntityKind,
      digest: row.digest,
      branch_id: row.branch_id,
      payload: JSON.parse(row.payload_json) as T,
      refs: JSON.parse(row.refs_json) as VersionRef[],
      created_at: row.created_at,
      superseded_by: row.superseded_by,
    };
  }

  // ---------- 事件 ----------

  nextEventSeq(workspaceId: StableId): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM events WHERE workspace_id=?')
      .get(workspaceId) as { s: number };
    return row.s;
  }

  appendEvent(event: DomainEvent): void {
    this.db
      .prepare(
        `INSERT INTO events(event_id,seq,workspace_id,branch_id,type,actor,payload_json,
           dependency_snapshot_json,related_entities_json,at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.event_id,
        event.seq,
        event.workspace_id ?? workspaceOf(event),
        event.branch_id,
        event.type,
        event.actor,
        canonicalJson(event.payload),
        canonicalJson(event.dependency_snapshot),
        canonicalJson(event.related_entities),
        event.at,
      );
  }

  listEvents(workspaceId: StableId): DomainEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE workspace_id=? ORDER BY seq')
      .all(workspaceId) as EventRow[];
    return rows.map((r) => ({
      event_id: r.event_id,
      seq: r.seq,
      type: r.type,
      at: r.at,
      branch_id: r.branch_id,
      actor: r.actor,
      payload: JSON.parse(r.payload_json),
      dependency_snapshot: JSON.parse(r.dependency_snapshot_json),
      related_entities: JSON.parse(r.related_entities_json),
    }));
  }

  // ---------- 依赖关系 / 失效范围 ----------

  addDependencyEdge(
    source: VersionRef,
    dependent: VersionRef,
    edgeKind: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO dependency_edges
         (source_id,source_version,dependent_id,dependent_version,edge_kind)
         VALUES (?,?,?,?,?)`,
      )
      .run(source.id, source.version, dependent.id, dependent.version, edgeKind);
  }

  /**
   * 失效范围：给定一个发生变化的源实体 id，沿依赖边 BFS 返回所有受影响的
   * (实体 id, 版本) 集合。参数或参考版本变化后只失效该闭包，不全局替换。
   */
  invalidationScope(changed: Array<{ id: StableId; version: number }>): VersionRef[] {
    const seen = new Set<string>();
    const queue = [...changed];
    const scope: VersionRef[] = [];
    while (queue.length) {
      const cur = queue.shift()!;
      const rows = this.db
        .prepare(
          `SELECT dependent_id, dependent_version FROM dependency_edges
           WHERE source_id=? AND source_version<=?`,
        )
        .all(cur.id, cur.version) as Array<{
        dependent_id: StableId;
        dependent_version: number;
      }>;
      for (const row of rows) {
        const key = `${row.dependent_id}@${row.dependent_version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rec = this.getEntity(row.dependent_id, row.dependent_version);
        const ref: VersionRef = {
          kind: rec?.kind ?? ('unknown' as EntityKind),
          id: row.dependent_id,
          version: row.dependent_version,
          digest: rec?.digest,
        };
        scope.push(ref);
        queue.push({ id: row.dependent_id, version: row.dependent_version });
      }
    }
    return scope;
  }

  // ---------- 并发冻结与复核锁定 ----------

  acquireLock(
    key: string,
    branchId: string,
    holderToken: string,
    expectedVersion: number,
  ): { ok: boolean; conflict?: { holder: string; held_since: string; expected: number } } {
    const existing = this.db
      .prepare('SELECT holder_token, held_since, expected_version FROM advisory_locks WHERE lock_key=?')
      .get(key) as
      | { holder_token: string; held_since: string; expected_version: number }
      | undefined;
    if (existing) {
      if (existing.holder_token === holderToken) return { ok: true };
      return {
        ok: false,
        conflict: {
          holder: existing.holder_token,
          held_since: existing.held_since,
          expected: existing.expected_version,
        },
      };
    }
    this.db
      .prepare(
        'INSERT INTO advisory_locks(lock_key,branch_id,holder_token,held_since,expected_version) VALUES (?,?,?,?,?)',
      )
      .run(key, branchId, holderToken, new Date().toISOString(), expectedVersion);
    return { ok: true };
  }

  releaseLock(key: string, holderToken: string): void {
    this.db
      .prepare('DELETE FROM advisory_locks WHERE lock_key=? AND holder_token=?')
      .run(key, holderToken);
  }

  /** 乐观并发：保存时校验期望版本，失败返回冲突与双方差异 */
  checkOptimistic(
    branchId: string,
    expectedHeadEventSeq: number,
  ): { ok: true; head: number } | { ok: false; head: number; theirEvents: DomainEvent[] } {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events WHERE branch_id=?')
      .get(branchId) as { s: number };
    if (row.s !== expectedHeadEventSeq) {
      const theirEvents = this.listEventsByBranch(branchId).filter(
        (e) => e.seq > expectedHeadEventSeq,
      );
      return { ok: false, head: row.s, theirEvents };
    }
    return { ok: true, head: row.s };
  }

  listEventsByBranch(branchId: string): DomainEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE branch_id=? ORDER BY seq')
      .all(branchId) as EventRow[];
    return rows.map((r) => ({
      event_id: r.event_id,
      seq: r.seq,
      type: r.type,
      at: r.at,
      branch_id: r.branch_id,
      actor: r.actor,
      payload: JSON.parse(r.payload_json),
      dependency_snapshot: JSON.parse(r.dependency_snapshot_json),
      related_entities: JSON.parse(r.related_entities_json),
    }));
  }

  setReviewLock(args: {
    interpretationId: StableId;
    candidateRef: VersionRef;
    lockedBy: string;
    note: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_locks(interpretation_id,candidate_id,candidate_version,locked_by,note,locked_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(interpretation_id) DO UPDATE SET
           candidate_id=excluded.candidate_id,
           candidate_version=excluded.candidate_version,
           locked_by=excluded.locked_by,
           note=excluded.note,
           locked_at=excluded.locked_at`,
      )
      .run(
        args.interpretationId,
        args.candidateRef.id,
        args.candidateRef.version,
        args.lockedBy,
        args.note,
        new Date().toISOString(),
      );
  }

  getReviewLock(interpretationId: StableId):
    | { candidate_id: StableId; candidate_version: number; locked_by: string; note: string; locked_at: string }
    | null {
    return (
      (this.db
        .prepare('SELECT * FROM review_locks WHERE interpretation_id=?')
        .get(interpretationId) as
        | {
            candidate_id: StableId;
            candidate_version: number;
            locked_by: string;
            note: string;
            locked_at: string;
          }
        | undefined) ?? null
    );
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

interface EntityRow {
  id: StableId;
  version: number;
  kind: string;
  digest: string;
  branch_id: string;
  payload_json: string;
  refs_json: string;
  superseded_by: StableId | null;
  created_at: string;
}

interface EventRow {
  event_id: StableId;
  seq: number;
  workspace_id: StableId;
  branch_id: string;
  type: string;
  actor: string;
  payload_json: string;
  dependency_snapshot_json: string;
  related_entities_json: string;
  at: string;
}

function workspaceOf(event: DomainEvent): StableId {
  // events 表在 appendEvent 调用处由调用方保证 workspace；此处仅为签名兜底
  return (event as unknown as { workspace_id?: StableId }).workspace_id ?? '';
}

/** 深度收集载荷中所有 VersionRef（形状：{kind,id,version}），用于引用校验 */
export function collectRefs(value: unknown): VersionRef[] {
  const out: VersionRef[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    const obj = v as Record<string, unknown>;
    if (
      typeof obj.kind === 'string' &&
      typeof obj.id === 'string' &&
      typeof obj.version === 'number'
    ) {
      const key = `${obj.kind}:${obj.id}@${obj.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(obj as unknown as VersionRef);
      }
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(value);
  return out;
}
