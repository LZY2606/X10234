/**
 * 有序状态迁移。fresh 库按顺序全部应用；迁移测试从 v1 建库再升级到 head。
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1_TABLES = `
CREATE TABLE content_blobs (
  sha256 TEXT PRIMARY KEY,
  media TEXT NOT NULL,
  bytes BLOB NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  case_code TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  branch TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  UNIQUE(branch, seq)
);
CREATE INDEX events_branch_idx ON events(branch, seq);
CREATE TABLE branches (
  name TEXT PRIMARY KEY,
  head_event_id TEXT,
  created_event_id TEXT NOT NULL
);
CREATE TABLE input_entities (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  branch TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  introduced_event_id TEXT NOT NULL,
  superseded_event_id TEXT,
  PRIMARY KEY (id, version, branch)
);
CREATE TABLE axis_models (
  axis_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  branch TEXT NOT NULL,
  pivot_x REAL, pivot_y REAL,
  direction_deg REAL,
  locked_center INTEGER NOT NULL,
  source TEXT NOT NULL,
  introduced_event_id TEXT NOT NULL,
  PRIMARY KEY (axis_id, version, branch)
);
CREATE TABLE candidates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  branch TEXT NOT NULL,
  comparison_id TEXT NOT NULL,
  method TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  valid_set_size INTEGER NOT NULL,
  common_set_size INTEGER NOT NULL,
  common_rms REAL NOT NULL,
  own_rms REAL NOT NULL,
  dropped_frames_json TEXT NOT NULL,
  transforms_json TEXT NOT NULL,
  residuals_json TEXT NOT NULL,
  tied_with_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  introduced_event_id TEXT NOT NULL,
  PRIMARY KEY (id, version, branch)
);
CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  valid_point_set_json TEXT NOT NULL,
  frame_order_json TEXT NOT NULL,
  created_event_id TEXT NOT NULL
);
CREATE TABLE adjudications (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  comparison_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  active INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  undone_event_id TEXT
);
CREATE TABLE locks (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  comparison_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  snapshot_event_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  reconstruction_ref TEXT NOT NULL,
  created_event_id TEXT NOT NULL
);
CREATE TABLE dependencies (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_version INTEGER NOT NULL,
  branch TEXT NOT NULL,
  dep_entity_id TEXT NOT NULL,
  dep_version INTEGER NOT NULL,
  dep_content_sha TEXT,
  PRIMARY KEY (subject_type, subject_id, subject_version, branch, dep_entity_id, dep_version)
);
`;

/** v2：事件可见性快照（time-travel 时的查询视图），并记录诊断留存 */
const V2 = `
CREATE TABLE event_snapshots (
  event_id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state_json TEXT NOT NULL
);
CREATE TABLE retained_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch TEXT NOT NULL,
  event_id TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial-domain-schema', sql: V1_TABLES },
  { version: 2, name: 'event-snapshots-and-diagnostics', sql: V2 },
];
