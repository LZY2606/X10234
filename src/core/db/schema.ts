/**
 * Schema 版本史：
 *  v1  legacy：只有 blobs / entities / events 三张表，events 没有 branch 列。
 *  v2  当前：事件带分支与序号，新增 branches / locks / scenario_cases。
 * 迁移测试会用 v1 文件验证升级到 v2 后数据可读、身份稳定。
 */
export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS entities (
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id, version)
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL
);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1');
`;

export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS entities (
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id, version)
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (branch_id, seq)
);
CREATE TABLE IF NOT EXISTS branches (
  branch_id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_branch_id TEXT,
  head_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS locks (
  lock_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  author TEXT NOT NULL,
  note TEXT NOT NULL,
  active INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (branch_id, lock_id)
);
CREATE TABLE IF NOT EXISTS scenario_cases (
  case_id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,
  body TEXT NOT NULL
);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2');
`;

/** v1 -> v2：重建 events 表并补分支列，旧事件归入 main 分支且保持原顺序。 */
export const MIGRATION_1_TO_2 = `
ALTER TABLE events RENAME TO events_v1;
${SCHEMA_V2}
INSERT INTO events (event_id, seq, branch_id, kind, at, payload)
  SELECT event_id, rowid, 'main', kind, at, payload FROM events_v1 ORDER BY rowid;
DROP TABLE events_v1;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2');
`;
