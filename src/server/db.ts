import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 存储：内容寻址不可变字节 + 只追加事件日志 + 分支头 + 导入事务。
 * 迁移以串行版本提供，旧库可逐级升到最新（迁移测试覆盖 v1/v2 -> v3）。
 */

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  migrate(db);
  return db;
}

interface Migration {
  version: number;
  name: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'baseline',
    up: `
    CREATE TABLE blobs (
      content_id TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      bytes BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE branches (
      branch_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      parent_branch_id TEXT,
      name TEXT NOT NULL,
      head_event_id TEXT,
      head_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      parent_ids TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      rationale_json TEXT,
      content_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (branch_id, ordinal)
    );
    `,
  },
  {
    version: 2,
    name: 'entity-versions',
    up: `
    CREATE TABLE entity_versions (
      entity_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      branch_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      digest TEXT NOT NULL,
      data_json TEXT NOT NULL,
      superseded_at TEXT,
      PRIMARY KEY (entity_id, version, branch_id)
    );
    CREATE INDEX idx_ev_branch ON entity_versions(branch_id);
    CREATE TABLE entity_refs (
      branch_id TEXT NOT NULL,
      owner_entity TEXT NOT NULL,
      owner_version INTEGER NOT NULL,
      ref_entity TEXT NOT NULL,
      ref_version INTEGER NOT NULL,
      ref_digest TEXT NOT NULL,
      PRIMARY KEY (branch_id, owner_entity, owner_version, ref_entity, ref_version)
    );
    `,
  },
  {
    version: 3,
    name: 'imports-and-locks',
    up: `
    CREATE TABLE imports (
      import_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      committed_at TEXT,
      status TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE locks (
      branch_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      reconstruction_ref TEXT NOT NULL,
      locked_by TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      references_json TEXT NOT NULL
    );
    CREATE INDEX idx_events_series ON events(series_id);
    `,
  },
];

export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return Number(row.user_version);
}

export function migrate(db: DatabaseSync): number {
  let version = currentSchemaVersion(db);
  for (const m of MIGRATIONS) {
    if (version < m.version) {
      db.exec('BEGIN');
      try {
        db.exec(m.up);
        db.exec(`PRAGMA user_version = ${m.version};`);
        db.exec('COMMIT');
        version = m.version;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }
  return version;
}

/** 测试辅助：构造一个指定旧版本的库（重放迁移的前 n 步）。 */
export function buildSchemaAtVersion(db: DatabaseSync, target: number): void {
  const v = currentSchemaVersion(db);
  if (v !== 0) throw new Error('buildSchemaAtVersion requires fresh db');
  for (const m of MIGRATIONS) {
    if (m.version > target) break;
    db.exec(m.up);
  }
  db.exec(`PRAGMA user_version = ${target};`);
}
