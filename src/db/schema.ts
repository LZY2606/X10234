/**
 * SQLite 模式迁移。迁移只允许追加，不允许修改旧迁移——旧结论不可被悄悄替换。
 */
export const SCHEMA_VERSION = 2;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline',
    sql: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE blobs (
      blob_id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      origin TEXT NOT NULL,
      bytes BLOB NOT NULL
    );
    CREATE TABLE entities (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_kind, entity_id, version)
    );
    CREATE TABLE event_dependencies (
      event_id TEXT NOT NULL,
      dep_kind TEXT NOT NULL,
      dep_id TEXT NOT NULL,
      dep_version INTEGER NOT NULL,
      ord INTEGER NOT NULL,
      PRIMARY KEY (event_id, ord)
    );
    CREATE TABLE audit_events (
      event_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      subject_kind TEXT,
      subject_id TEXT,
      subject_version INTEGER,
      rationale_code TEXT NOT NULL,
      rationale_detail TEXT NOT NULL,
      parent_event_id TEXT,
      expected_parent_event_id TEXT,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (branch_id, seq)
    );
    CREATE TABLE branches (
      branch_id TEXT PRIMARY KEY,
      parent_branch_id TEXT,
      name TEXT NOT NULL,
      fork_event_id TEXT NOT NULL,
      head_event_id TEXT NOT NULL,
      visible_json TEXT NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE diagnostics (
      diagnostic_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      context_json TEXT NOT NULL
    );
    `
  },
  {
    version: 2,
    name: 'scenario_archive',
    sql: `
    CREATE TABLE scenario_runs (
      scenario_run_id TEXT PRIMARY KEY,
      scenario TEXT NOT NULL,
      case_kind TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      status TEXT NOT NULL,
      entered_at_event_id TEXT NOT NULL,
      decided_event_id TEXT,
      shared_blob_ids_json TEXT NOT NULL,
      independent_payload_json TEXT NOT NULL
    );
    CREATE TABLE invalidations (
      invalidation_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      changed_ref_kind TEXT NOT NULL,
      changed_ref_id TEXT NOT NULL,
      changed_ref_version INTEGER NOT NULL,
      affected_kind TEXT NOT NULL,
      affected_id TEXT NOT NULL,
      affected_version INTEGER NOT NULL,
      scope_kind TEXT NOT NULL
    );
    CREATE INDEX idx_entities_id ON entities(entity_kind, entity_id);
    CREATE INDEX idx_events_branch ON audit_events(branch_id, seq);
    `
  }
];
