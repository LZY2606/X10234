-- v1: 初始模式
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_blobs (
  sha256 TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_entities (
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  frame_id TEXT,
  track_id TEXT,
  payload_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  supersedes_entity_id TEXT,
  created_at TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  PRIMARY KEY (entity_id, version)
);
CREATE INDEX IF NOT EXISTS idx_source_kind ON source_entities(kind);
CREATE INDEX IF NOT EXISTS idx_source_scope ON source_entities(scope_key);

CREATE TABLE IF NOT EXISTS import_batches (
  batch_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  entity_count INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  branch_id TEXT PRIMARY KEY,
  parent_branch_id TEXT,
  label TEXT NOT NULL,
  note TEXT NOT NULL,
  rule_set_version TEXT NOT NULL,
  head_commit_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commits (
  commit_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  parent_commit_id TEXT,
  kind TEXT NOT NULL,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  rule_set_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  label TEXT NOT NULL,
  transform_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  effective_point_key TEXT NOT NULL,
  effective_frame_ids_json TEXT NOT NULL,
  effective_track_ids_json TEXT NOT NULL,
  excluded_frame_ids_json TEXT NOT NULL,
  transforms_json TEXT NOT NULL,
  per_frame_residual_json TEXT NOT NULL,
  mean_residual REAL NOT NULL,
  max_residual REAL NOT NULL,
  overfit_ratio REAL,
  free_parameter_count INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  ambiguity_family_id TEXT,
  diagnostics_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  candidate_id TEXT,
  kind TEXT NOT NULL,
  rationale TEXT NOT NULL,
  reverted_decision_id TEXT,
  active INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locked_alignments (
  lock_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  reconstruction_ref TEXT NOT NULL,
  active INTEGER NOT NULL,
  locked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_events (
  event_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  semantic_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_branch ON ledger_events(branch_id, created_at);

CREATE TABLE IF NOT EXISTS dependency_edges (
  from_entity_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_entity_id TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_entity_id, from_version, to_entity_id, to_version, relation)
);

CREATE TABLE IF NOT EXISTS casepack_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
