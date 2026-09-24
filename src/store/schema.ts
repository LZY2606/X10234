/** 关系模式（内存版与 SQLite 版共用）。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  blob_id TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_event_id TEXT
);
CREATE TABLE IF NOT EXISTS facts (
  stable_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  entity_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_event_id TEXT NOT NULL,
  supersedes_version INTEGER,
  PRIMARY KEY (stable_id, version)
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  parent_event_id TEXT,
  branch TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  baseline_id TEXT,
  conflict_status TEXT
);
CREATE TABLE IF NOT EXISTS refs (
  branch TEXT PRIMARY KEY,
  head_event_id TEXT NOT NULL,
  head_seq INTEGER NOT NULL,
  expected_parent_event_id TEXT
);
CREATE TABLE IF NOT EXISTS dependencies (
  from_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_id TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_id, from_version, to_id, to_version)
);
CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind);
CREATE INDEX IF NOT EXISTS idx_events_branch ON events(branch, seq);
CREATE INDEX IF NOT EXISTS idx_deps_to ON dependencies(to_id, to_version);
CREATE INDEX IF NOT EXISTS idx_deps_from ON dependencies(from_id, from_version);
`;
