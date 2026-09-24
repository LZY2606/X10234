import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 持久层。来源（原始字节 blob）与解释（实体版本 / 事件 / 裁定）分表保存。
 * 迁移按版本号顺序执行；迁移测试会构造 v1 库再升级到最新。
 */

export const SCHEMA_VERSION = 2;

const MIGRATION_1 = `
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE entity_versions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(entity_id, branch_id, version_no)
);
CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  head_event_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  supersedes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  action TEXT NOT NULL,
  rationale TEXT NOT NULL,
  actor TEXT NOT NULL,
  base_head TEXT NOT NULL,
  event_id TEXT NOT NULL,
  undone_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE locks (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  base_head TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const MIGRATION_2 = `
CREATE TABLE unit_diagnostics (
  id TEXT PRIMARY KEY,
  entity_version_id TEXT NOT NULL,
  field TEXT NOT NULL,
  raw_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
  );
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  for (const m of MIGRATIONS) {
    if (m.version > row.v) {
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          m.version,
          new Date().toISOString()
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

/** 事务包装：导入失败只回滚本次变更，不留半份记录。 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
