export const CURRENT_SCHEMA_VERSION = 2;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  archive_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dependency_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  author TEXT NOT NULL,
  at_iso TEXT NOT NULL,
  probe_id TEXT
);
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archives (
  archive_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  created_at_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_archive ON events(archive_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_probe ON events(probe_id);
`;

export const MIGRATIONS: Array<{ from: number; to: number; sql: string }> = [
  {
    from: 1,
    to: 2,
    sql: `
ALTER TABLE events ADD COLUMN replay_digest TEXT;
CREATE TABLE IF NOT EXISTS entity_heads (
  archive_id TEXT NOT NULL,
  stable_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  content_summary TEXT NOT NULL,
  PRIMARY KEY (archive_id, stable_id)
);
`
  }
];
