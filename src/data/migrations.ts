/**
 * 状态迁移：有序、版本化。迁移测试从 v1 逐级升级并校验。
 */
export interface Migration {
  version: number;
  description: string;
  statements: string[];
}

export const LATEST_SCHEMA_VERSION = 2;

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'baseline: blobs, import batches, source versions, events, tilt sources, branches, interpretations',
    statements: [
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
      `CREATE TABLE blobs (
         sha TEXT PRIMARY KEY,
         byte_length INTEGER NOT NULL,
         media_type TEXT NOT NULL,
         bytes BLOB NOT NULL
       );`,
      `CREATE TABLE import_batches (
         batch_id TEXT PRIMARY KEY,
         tilt_series_id TEXT NOT NULL,
         source_version INTEGER NOT NULL,
         committed INTEGER NOT NULL,
         created_at_iso TEXT NOT NULL
       );`,
      `CREATE TABLE events (
         seq INTEGER PRIMARY KEY,
         event_id TEXT NOT NULL UNIQUE,
         code TEXT NOT NULL,
         branch_id TEXT,
         at_iso TEXT NOT NULL,
         author TEXT NOT NULL,
         refs_json TEXT NOT NULL DEFAULT '[]',
         rationale_json TEXT NOT NULL DEFAULT '[]',
         payload_json TEXT NOT NULL DEFAULT '{}',
         invalidation_json TEXT
       );`,
      `CREATE TABLE tilt_series (
         tilt_series_id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         source_version INTEGER NOT NULL,
         width_px INTEGER NOT NULL,
         height_px INTEGER NOT NULL,
         pixel_scale_json TEXT NOT NULL,
         sign_convention TEXT NOT NULL,
         created_at_iso TEXT NOT NULL
       );`,
      `CREATE TABLE frames (
         tilt_series_id TEXT NOT NULL,
         frame_seq INTEGER NOT NULL,
         source_version INTEGER NOT NULL,
         blob_sha TEXT NOT NULL,
         byte_length INTEGER NOT NULL,
         dose_per_frame_json TEXT NOT NULL,
         angle_json TEXT NOT NULL,
         PRIMARY KEY (tilt_series_id, frame_seq, source_version)
       );`,
      `CREATE TABLE marker_observations (
         tilt_series_id TEXT NOT NULL,
         marker_id TEXT NOT NULL,
         frame_seq INTEGER NOT NULL,
         source_version INTEGER NOT NULL,
         x_px REAL,
         y_px REAL,
         observed INTEGER NOT NULL,
         PRIMARY KEY (tilt_series_id, marker_id, frame_seq, source_version)
       );`,
      `CREATE TABLE track_gaps (
         gap_id TEXT PRIMARY KEY,
         tilt_series_id TEXT NOT NULL,
         marker_id TEXT NOT NULL,
         from_frame_seq INTEGER NOT NULL,
         to_frame_seq INTEGER NOT NULL,
         reason TEXT NOT NULL,
         source_version INTEGER NOT NULL
       );`,
      `CREATE TABLE manual_exclusions (
         exclusion_id TEXT PRIMARY KEY,
         tilt_series_id TEXT NOT NULL,
         frame_seq INTEGER NOT NULL,
         reason TEXT NOT NULL,
         author TEXT NOT NULL,
         at_iso TEXT NOT NULL,
         revoked INTEGER NOT NULL DEFAULT 0,
         source_version INTEGER NOT NULL
       );`,
      `CREATE TABLE branches (
         branch_id TEXT PRIMARY KEY,
         tilt_series_id TEXT NOT NULL,
         parent_branch_id TEXT,
         name TEXT NOT NULL,
         fork_event_id TEXT,
         head_event_id TEXT,
         revision INTEGER NOT NULL DEFAULT 1,
         frozen INTEGER NOT NULL DEFAULT 0,
         created_at_iso TEXT NOT NULL
       );`,
      `CREATE TABLE tilt_axis_interpretations (
         branch_id TEXT NOT NULL,
         event_id TEXT NOT NULL,
         orientation_deg REAL,
         intercept_x_px REAL,
         basis TEXT NOT NULL,
         origin_frame_seq INTEGER NOT NULL,
         evidence_json TEXT NOT NULL,
         unresolved_reason TEXT,
         PRIMARY KEY (branch_id, event_id)
       );`,
      `CREATE TABLE track_interpretations (
         branch_id TEXT NOT NULL,
         event_id TEXT NOT NULL,
         marker_id TEXT NOT NULL,
         status TEXT NOT NULL,
         segments_json TEXT NOT NULL,
         swapped_with TEXT,
         possible_identities_json TEXT NOT NULL,
         PRIMARY KEY (branch_id, event_id, marker_id)
       );`,
      `CREATE TABLE point_sets (
         point_set_id TEXT PRIMARY KEY,
         branch_id TEXT NOT NULL,
         pairs_json TEXT NOT NULL,
         frame_seqs_json TEXT NOT NULL,
         excluded_frame_seqs_json TEXT NOT NULL
       );`,
      `CREATE TABLE candidates (
         candidate_id TEXT PRIMARY KEY,
         branch_id TEXT NOT NULL,
         point_set_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         params_json TEXT NOT NULL,
         residuals_json TEXT NOT NULL,
         rms_px REAL NOT NULL,
         max_px REAL NOT NULL,
         pair_count INTEGER NOT NULL,
         overfit INTEGER NOT NULL,
         overfit_diagnostic TEXT,
         ambiguous_with_json TEXT,
         status TEXT NOT NULL,
         provenance_event_ids_json TEXT NOT NULL,
         coverage_note TEXT,
         created_at_iso TEXT NOT NULL
       );`,
      `CREATE TABLE decisions (
         decision_id TEXT PRIMARY KEY,
         branch_id TEXT NOT NULL,
         event_id TEXT NOT NULL UNIQUE,
         kind TEXT NOT NULL,
         candidate_id TEXT,
         reason TEXT NOT NULL,
         author TEXT NOT NULL,
         at_iso TEXT NOT NULL,
         reverts_decision_id TEXT,
         superseded_by TEXT
       );`,
      `CREATE TABLE locked_registrations (
         lock_id TEXT PRIMARY KEY,
         branch_id TEXT NOT NULL,
         candidate_id TEXT NOT NULL,
         point_set_id TEXT NOT NULL,
         revision INTEGER NOT NULL,
         locked_at_iso TEXT NOT NULL,
         reconstruction_ref TEXT NOT NULL
       );`,
      `CREATE TABLE invalidation_scopes (
         scope_id TEXT PRIMARY KEY,
         trigger_event_id TEXT NOT NULL,
         branch_id TEXT NOT NULL,
         affected_entity_ids_json TEXT NOT NULL,
         affected_kinds_json TEXT NOT NULL,
         reason TEXT NOT NULL
       );`
    ]
  },
  {
    version: 2,
    description: 'review notes table + head revision index for concurrent save conflict detection',
    statements: [
      `CREATE TABLE review_notes (
         note_id TEXT PRIMARY KEY,
         branch_id TEXT NOT NULL,
         event_id TEXT NOT NULL,
         view_state_json TEXT NOT NULL,
         note TEXT,
         created_at_iso TEXT NOT NULL
       );`,
      `CREATE INDEX idx_events_branch_seq ON events (branch_id, seq);`,
      `CREATE INDEX idx_candidates_branch ON candidates (branch_id);`
    ]
  }
];
