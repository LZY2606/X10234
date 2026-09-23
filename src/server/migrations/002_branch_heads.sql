-- 002: 分支头指针显式化（此前由查询推导）。迁移需回填已有分支。
CREATE TABLE branch_heads (
  branch_id TEXT PRIMARY KEY REFERENCES interpretation_branches(id),
  interpretation_id TEXT NOT NULL,
  interpretation_version INTEGER NOT NULL,
  decision_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
