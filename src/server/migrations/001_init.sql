-- 001: 基础结构。来源与解释分离；一切版本化；事件只追加。
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE raw_documents (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  raw_representation TEXT NOT NULL,   -- 导入时保留原始表示
  case_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE derived_values (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  payload TEXT NOT NULL,              -- 规范化结果 + 诊断
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id, source_version) REFERENCES raw_documents(id, version)
);

CREATE TABLE interpretation_branches (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  parent_branch_id TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE interpretation_versions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  branch_id TEXT NOT NULL REFERENCES interpretation_branches(id),
  params TEXT NOT NULL,               -- AlignmentParams JSON
  source_refs TEXT NOT NULL,          -- SourceRef[] JSON：引用的版本号与内容摘要
  supersedes_id TEXT,
  supersedes_version INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,   -- 依赖失效标记（不允许全局悄悄替换）
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE candidates (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  interpretation_id TEXT NOT NULL,
  interpretation_version INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- rigid | local_deform | exclude_bad_frames
  effective_point_set TEXT NOT NULL,  -- EffectivePointSet JSON
  residuals TEXT NOT NULL,            -- FrameResidual[] JSON
  status TEXT NOT NULL DEFAULT 'proposed',
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version),
  FOREIGN KEY (interpretation_id, interpretation_version)
    REFERENCES interpretation_versions(id, version)
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  rationale_code TEXT,                -- 机器可读取的判断依据
  payload TEXT NOT NULL,
  reverts_decision_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE alignment_locks (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  locked_by_decision_id TEXT NOT NULL REFERENCES decisions(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE counterexample_cases (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,
  baseline_refs TEXT NOT NULL,        -- SourceRef[] JSON
  minimal_input_refs TEXT NOT NULL,
  combined_input_refs TEXT NOT NULL,
  adopted_result TEXT,                -- 被采纳结果
  rejected_results TEXT NOT NULL,     -- 未采纳结果也保留
  expected_scope TEXT NOT NULL,       -- 允许受影响的对象清单
  observed_scope TEXT,                -- 实际受影响的对象清单
  created_at TEXT NOT NULL
);
