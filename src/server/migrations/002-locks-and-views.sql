-- v2: 视图状态与导出日志（迁移测试验证旧数据保留）
CREATE TABLE IF NOT EXISTS review_view_states (
  view_state_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  frame_opacity REAL NOT NULL,
  show_axis INTEGER NOT NULL,
  show_breakpoints INTEGER NOT NULL,
  selected_candidate_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_log (
  export_id TEXT PRIMARY KEY,
  exported_at TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  entity_count INTEGER NOT NULL
);
