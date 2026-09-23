export const SCHEMA = `
CREATE TABLE IF NOT EXISTS blob (
  digest TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  mediaType TEXT NOT NULL,
  byteLength INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branch (
  branchId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parentBranchId TEXT,
  headRevision INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);

-- 全局只追加事件日志：机器可读的判断依据
CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  eventId TEXT NOT NULL UNIQUE,
  branchId TEXT NOT NULL,
  revision INTEGER NOT NULL,          -- 分支内单调修订号
  eventType TEXT NOT NULL,
  payload TEXT NOT NULL,              -- JSON
  rationale TEXT NOT NULL,            -- 规则引用，如 RULE:axis-not-center
  createdAt TEXT NOT NULL
);

-- 物化的版本化实体；查询任一实体必须带版本号，缺引用=损坏
CREATE TABLE IF NOT EXISTS entity_version (
  entityId TEXT NOT NULL,
  version INTEGER NOT NULL,
  branchId TEXT NOT NULL,
  kind TEXT NOT NULL,
  seriesId TEXT NOT NULL,
  sourceBlob TEXT NOT NULL,
  body TEXT NOT NULL,
  contentDigest TEXT NOT NULL,
  eventId TEXT NOT NULL,
  ordinal INTEGER NOT NULL,           -- 导入顺序，稳定
  PRIMARY KEY (entityId, version, branchId)
);

CREATE TABLE IF NOT EXISTS candidate (
  candidateId TEXT NOT NULL,
  branchId TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  parentCandidateId TEXT,
  data TEXT NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1,
  invalidatedByEventId TEXT,
  eventId TEXT NOT NULL,
  PRIMARY KEY (candidateId, branchId)
);

CREATE TABLE IF NOT EXISTS adjudication (
  adjudicationId TEXT PRIMARY KEY,
  branchId TEXT NOT NULL,
  candidateId TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL,
  decidedBy TEXT NOT NULL,
  baseRevision INTEGER NOT NULL,
  supersededBy TEXT,
  eventId TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locked_alignment (
  branchId TEXT PRIMARY KEY,
  candidateId TEXT NOT NULL,
  adjudicationId TEXT NOT NULL,
  lockedAt TEXT NOT NULL,
  reconstructionRef TEXT NOT NULL
);

-- 依赖图：参数/参考版本变化后据此计算失效范围
CREATE TABLE IF NOT EXISTS dependency (
  branchId TEXT NOT NULL,
  downstreamKind TEXT NOT NULL,      -- candidate | adjudication | lock
  downstreamId TEXT NOT NULL,
  upstreamKind TEXT NOT NULL,        -- entity
  upstreamId TEXT NOT NULL,
  upstreamVersion INTEGER NOT NULL,
  PRIMARY KEY (branchId, downstreamKind, downstreamId, upstreamKind, upstreamId, upstreamVersion)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
