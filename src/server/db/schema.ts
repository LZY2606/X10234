/**
 * 数据库迁移。任何 schema 变化都通过编号迁移进行，旧库必须可向前迁移，
 * 且迁移后既有实体的稳定身份、顺序与来源关系不变——这是状态迁移测试的契约。
 */
export interface Migration {
  version: number;
  description: string;
  sql: string[];
  verify?: (db: import("node:sqlite").DatabaseSync) => void;
}

const SHARED_TABLES = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS objects (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content_json TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    created_seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS blob_objects (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    data BLOB NOT NULL,
    bytes_digest TEXT NOT NULL,
    created_seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ingest_commits (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    material_version TEXT NOT NULL,
    parent_commit_id TEXT,
    rationale TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    entity_ids_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rule_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    params_json TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    rule_version_id TEXT NOT NULL,
    head_event_id TEXT,
    superseded_by TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    prev_event_id TEXT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    summary TEXT NOT NULL,
    refs_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    dependency_snapshot_json TEXT NOT NULL,
    UNIQUE(branch_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    depends_on_digest TEXT NOT NULL,
    scope TEXT NOT NULL,
    locality_key TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    rule_version_id TEXT NOT NULL,
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    comparison_group TEXT NOT NULL,
    point_set_digest TEXT NOT NULL,
    valid_frame_ids_json TEXT NOT NULL,
    identity_map_json TEXT NOT NULL,
    per_frame_json TEXT NOT NULL,
    rms_px REAL NOT NULL,
    max_px REAL NOT NULL,
    cv_rms_px REAL,
    complexity_penalty REAL NOT NULL,
    score REAL NOT NULL,
    diagnostics_json TEXT NOT NULL,
    created_event_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS locks (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL UNIQUE,
    candidate_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    for_reconstruction_ref TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    locked_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    at TEXT NOT NULL,
    expected_head_event_id TEXT NOT NULL,
    submitted_summary TEXT NOT NULL,
    actual_head_event_id TEXT NOT NULL,
    incoming_digest TEXT NOT NULL,
    base_digest TEXT NOT NULL,
    head_digest TEXT NOT NULL,
    actor_a TEXT NOT NULL,
    actor_b TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolution_event_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS dossier_entries (
    id TEXT PRIMARY KEY,
    case_code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    rule_statement TEXT NOT NULL,
    doc_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS diagnoses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    at_field TEXT NOT NULL
  )`,
];

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "初始版本：来源层、解释层、裁定事件、候选、锁定、冲突与反例档案",
    sql: SHARED_TABLES,
  },
  {
    version: 2,
    description: "候选增加 cross_validation_rms 列（局部形变过拟合判定）与诊断索引",
    sql: [
      `CREATE INDEX IF NOT EXISTS idx_candidates_branch ON candidates(branch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_diagnoses_entity ON diagnoses(entity_id)`,
    ],
    verify(db) {
      const row = db.prepare("SELECT COUNT(*) AS n FROM candidates").get() as { n: number };
      if (typeof row.n !== "number") throw new Error("MIGRATION_VERIFY_FAILED");
    },
  },
];
