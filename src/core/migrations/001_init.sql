-- 倾转帧拼合室 初始模式（schema_version = 1）
PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- 不可变内容寻址存储：组合/最小反例共享的原始片段只存一份
CREATE TABLE blobs (
  digest TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 所有领域实体统一版本化外壳：稳定 ID + 版本号，新版本绝不覆盖旧版本
CREATE TABLE entity_versions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  branch_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX idx_entity_kind ON entity_versions(kind);
CREATE INDEX idx_entity_branch ON entity_versions(branch_id);

CREATE TABLE branches (
  branch_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_branch_id TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  head_interpretation_id TEXT
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dependency_snapshot_json TEXT NOT NULL,
  related_entities_json TEXT NOT NULL,
  at TEXT NOT NULL
);

-- 依赖边：参数/参考版本变化后据此计算失效范围，不做全局静默替换
CREATE TABLE dependency_edges (
  source_id TEXT NOT NULL,      -- 被依赖实体 id
  source_version INTEGER NOT NULL,
  dependent_id TEXT NOT NULL,   -- 依赖方实体 id
  dependent_version INTEGER NOT NULL,
  edge_kind TEXT NOT NULL,
  PRIMARY KEY (source_id, source_version, dependent_id, dependent_version, edge_kind)
);
CREATE INDEX idx_dep_source ON dependency_edges(source_id, source_version);
CREATE INDEX idx_dep_dependent ON dependency_edges(dependent_id, dependent_version);

-- 并发冻结：同一分支同一资源加锁，后提交者看到版本冲突及双方差异
CREATE TABLE advisory_locks (
  lock_key TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  holder_token TEXT NOT NULL,
  held_since TEXT NOT NULL,
  expected_version INTEGER NOT NULL
);

CREATE TABLE review_locks (
  interpretation_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  locked_by TEXT NOT NULL,
  note TEXT,
  locked_at TEXT NOT NULL
);
