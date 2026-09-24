export const SCHEMA_VERSION = 2;

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 不可变原始字节（帧图像等），内容寻址，全局只存一份。
    CREATE TABLE IF NOT EXISTS blobs (
      blob_id TEXT PRIMARY KEY,
      byte_sha256 TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      bytes BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branches (
      branch_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_branch_id TEXT,
      revision INTEGER NOT NULL,
      head_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_entities (
      entity_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      frame_id TEXT,
      track_id TEXT,
      label TEXT NOT NULL,
      current_version INTEGER NOT NULL,
      branch_id TEXT NOT NULL
    );

    -- 来源与解释拆开保存：同一材料重新解释只追加新版本，旧版本继续可读。
    CREATE TABLE IF NOT EXISTS source_versions (
      version_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      blob_id TEXT,
      branch_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(entity_id, version)
    );

    -- 仅追加事件日志（事实）。
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      parent_event_id TEXT,
      basis_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidates (
      candidate_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      method TEXT NOT NULL,
      basis_rule_version TEXT NOT NULL,
      axis_json TEXT NOT NULL,
      transforms_json TEXT NOT NULL,
      per_frame_json TEXT NOT NULL,
      effective_frame_ids TEXT NOT NULL,
      effective_point_key TEXT NOT NULL,
      rmse_px REAL NOT NULL,
      holdout_rmse_px REAL,
      dof INTEGER NOT NULL,
      diagnoses_json TEXT NOT NULL,
      status TEXT NOT NULL,
      ambiguity_group_id TEXT,
      dependencies_json TEXT NOT NULL,
      valid INTEGER NOT NULL DEFAULT 1,
      stale_reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      decision_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      action TEXT NOT NULL,
      note TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      event_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      undone_by_event_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS locks (
      lock_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    -- 派生实体依赖：参数 / 参考版本变化后按依赖计算失效范围。
    CREATE TABLE IF NOT EXISTS dependencies (
      derived_id TEXT NOT NULL,
      ref_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      ref_version TEXT NOT NULL,
      PRIMARY KEY (derived_id, ref_kind, ref_id, ref_version)
    );

    CREATE TABLE IF NOT EXISTS invalidations (
      derived_id TEXT NOT NULL,
      source_ref_kind TEXT NOT NULL,
      source_ref_id TEXT NOT NULL,
      source_old_version TEXT NOT NULL,
      source_new_version TEXT NOT NULL,
      reason TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archive_cases (
      archive_id TEXT PRIMARY KEY,
      diag_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      adopted INTEGER NOT NULL,
      branch_id TEXT NOT NULL,
      shared_blob_ids TEXT NOT NULL,
      summary TEXT NOT NULL,
      minimal_ref TEXT,
      composite_ref TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS counterexamples (
      diag_key TEXT NOT NULL,
      minimal_branch_id TEXT NOT NULL,
      composite_branch_id TEXT NOT NULL,
      shared_blob_ids TEXT NOT NULL,
      PRIMARY KEY (diag_key)
    );
    `
  },
  {
    version: 2,
    sql: `
    -- 迁移 v2：为审计与损坏检测增加事件链锚点与导入批次表。
    CREATE TABLE IF NOT EXISTS import_batches (
      batch_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS corruption_reports (
      report_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      missing_ref_kind TEXT NOT NULL,
      missing_ref_id TEXT NOT NULL,
      missing_ref_version TEXT NOT NULL,
      detected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parameters (
      param_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      updated_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    `
  }
];
