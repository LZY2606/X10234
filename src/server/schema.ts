/**
 * SQLite schema 与迁移。版本化要点：
 *  - events：只追加事件日志（导入、解释、候选、裁定、回退），是唯一事实源。
 *  - entities：事件投影视图，按 (stable_id, version) 保存全部历史版本，不就地覆盖。
 *  - blobs：内容寻址的不可变原始字节（帧）。
 *  - 乐观并发由 series_state.version + 事件 seq 保证。
 */
export const LATEST_SCHEMA_VERSION = 2;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-event-log',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
    value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        branch_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        -- 该事件追加前的分支状态版本（乐观并发）
        parent_state_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        -- 事务标记：同一次导入的事件共享 tx_id；失败整组回滚
        tx_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_branch ON events(branch_id, seq);
      CREATE TABLE IF NOT EXISTS entities (
        stable_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        branch_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_json TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        produced_by_event_id TEXT NOT NULL,
        -- 该版本生效的分支状态版本（事件序号），历史回看用
        effective_from_seq INTEGER NOT NULL,
        superseded_at_seq INTEGER,
        PRIMARY KEY (stable_id, version, branch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entities_branch_kind
        ON entities(branch_id, kind, stable_id, version);
      CREATE TABLE IF NOT EXISTS refs (
        from_stable_id TEXT NOT NULL,
        from_version INTEGER NOT NULL,
        branch_id TEXT NOT NULL,
        to_stable_id TEXT NOT NULL,
        to_version INTEGER NOT NULL,
        to_sha256 TEXT,
        PRIMARY KEY (from_stable_id, from_version, branch_id, to_stable_id, to_version)
      );
    `,
  },
  {
    version: 2,
    name: 'dependencies-and-locks',
    sql: `
      -- 依赖边：派生实体版本 -> 直接来源实体版本。
      -- 参数/参考版本变化后沿此图计算失效范围，禁止全局悄悄替换。
      CREATE TABLE IF NOT EXISTS dependencies (
        downstream_stable_id TEXT NOT NULL,
        downstream_version INTEGER NOT NULL,
        branch_id TEXT NOT NULL,
        upstream_stable_id TEXT NOT NULL,
        upstream_version INTEGER NOT NULL,
        relation TEXT NOT NULL,
        PRIMARY KEY (
          downstream_stable_id,
          downstream_version,
          branch_id,
          upstream_stable_id,
          upstream_version
        )
      );
      CREATE INDEX IF NOT EXISTS idx_deps_up
        ON dependencies(branch_id, upstream_stable_id, upstream_version);

      -- 每分支序列状态（候选集合、当前锁定、状态版本=最后事件seq）
      CREATE TABLE IF NOT EXISTS branch_state (
        branch_id TEXT PRIMARY KEY,
        series_id TEXT,
        state_version INTEGER NOT NULL DEFAULT 0,
        locked_candidate_id TEXT,
        locked_at_event_id TEXT,
        reconstruction_handle TEXT
      );

      -- 导出包登记（验证导入/导出后身份、顺序、来源关系保持）
      CREATE TABLE IF NOT EXISTS export_manifests (
        export_id TEXT PRIMARY KEY,
        exported_at TEXT NOT NULL,
        entity_count INTEGER NOT NULL,
        blob_count INTEGER NOT NULL,
        root_event_seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
    `,
  },
];

export function migrate(db: {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    get: (...a: unknown[]) => unknown;
    run: (...a: unknown[]) => unknown;
  };
}): { fromVersion: number; toVersion: number; applied: string[] } {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get() as
    | { value?: string }
    | undefined;
  const fromVersion = row?.value ? Number(row.value) : 0;
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= fromVersion) continue;
    db.exec(m.sql);
    db.prepare(`INSERT INTO schema_meta(key,value) VALUES('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(m.version));
    applied.push(`${m.version}:${m.name}`);
  }
  return { fromVersion, toVersion: LATEST_SCHEMA_VERSION, applied };
}
