/**
 * 状态迁移。每个迁移在一个事务内执行，并在 schema_meta 记录版本。
 * v1：基线 schema。v2（见 002）演示参数/参考版本字段如何无损演进。
 */
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

export function applyMigrations(db: DatabaseSync, current: number): void {
  if (current < 1) migrateV1(db);
  if (current < 2) migrateV2(db);
}

function migrateV1(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 不可变原始字节，按内容寻址；组合/最小输入共享的原始片段只存一份。
    CREATE TABLE raw_blob (
      blob_id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    -- 解释分支：对同一批材料重新解释时新建分支，不覆盖旧分支。
    CREATE TABLE branch (
      branch_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      parent_branch_id TEXT,
      created_at TEXT NOT NULL,
      note TEXT
    );

    CREATE TABLE entity (
      entity_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      series_id TEXT,
      first_branch_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- 版本化实体内容。旧版本行保留可继续读取，禁止导入时不可逆清洗。
    CREATE TABLE entity_version (
      version_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entity(entity_id),
      version_number INTEGER NOT NULL,
      branch_id TEXT NOT NULL REFERENCES branch(branch_id),
      parent_version_id TEXT REFERENCES entity_version(version_id),
      kind TEXT NOT NULL,
      content_json TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by TEXT REFERENCES entity_version(version_id),
      created_at TEXT NOT NULL,
      UNIQUE (entity_id, version_number)
    );

    -- 派生配准候选：多候选与裁定分支显式保存。
    CREATE TABLE candidate (
      candidate_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      branch_id TEXT NOT NULL REFERENCES branch(branch_id),
      method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      content_json TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT,
      decision_reason TEXT,
      created_at TEXT NOT NULL
    );

    -- 锁定：审阅者锁定一版配准供重建引用。
    CREATE TABLE registration_lock (
      series_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      locked_by TEXT NOT NULL,
      note TEXT
    );

    -- 仅追加的机器可读事件，带哈希链。
    CREATE TABLE event (
      event_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      branch_id TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      at_iso TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      parent_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    -- 失效范围：参数/参考版本变化后按依赖计算，不允许全局悄悄替换。
    CREATE TABLE invalidation (
      invalidation_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      trigger_version_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      affected_entity_ids_json TEXT NOT NULL,
      affected_candidate_ids_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      at_iso TEXT NOT NULL
    );

    -- 导入批次：失败回滚整个批次，不留半份记录。
    CREATE TABLE import_batch (
      batch_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      status TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      at_iso TEXT NOT NULL,
      detail TEXT
    );

    -- 乐观并发：分支当前期望事件序号；两个窗口同时保存时后提交者冲突。
    CREATE TABLE branch_revision (
      branch_id TEXT PRIMARY KEY REFERENCES branch(branch_id),
      head_event_seq INTEGER NOT NULL DEFAULT 0,
      head_event_id TEXT
    );

    CREATE INDEX idx_entity_series ON entity(series_id);
    CREATE INDEX idx_version_entity ON entity_version(entity_id, version_number);
    CREATE INDEX idx_version_branch ON entity_version(branch_id);
    CREATE INDEX idx_candidate_series ON candidate(series_id);
    CREATE INDEX idx_event_branch_seq ON event(branch_id, seq);
  `);
  db.prepare(`INSERT INTO schema_meta(key,value) VALUES ('schema_version','1')`).run();
}

function migrateV2(db: DatabaseSync): void {
  // 无数据丢失的增量：候选增加 scenario 列；增加反例档案表。
  db.exec(`
    ALTER TABLE candidate ADD COLUMN scenario TEXT;
    CREATE TABLE counterexample_archive (
      archive_id TEXT PRIMARY KEY,
      scenario TEXT NOT NULL UNIQUE,
      minimal_series_id TEXT NOT NULL,
      combined_series_id TEXT NOT NULL,
      accepted_candidate_id TEXT,
      rejected_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
      rule_event_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(`UPDATE schema_meta SET value='2' WHERE key='schema_version'`).run();
}
