import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 持久层。
 * - events：append-only 事件流（分支链 + 全局 seq 排序）
 * - contents：内容身份 -> 规范化 JSON（同一内容只存一份）
 * - blobs：原始帧字节，内容寻址，多输入共享只存一份不可变内容
 * - branches：分支头乐观并发（并发冻结）
 * - refs：实体直接引用索引（用于依赖失效范围与损坏检查）
 * - locks：重建引用钉版
 */

export const CURRENT_SCHEMA_VERSION = 3;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  let version = row.v;

  if (version < 1) {
    db.exec(`
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        branch_id TEXT NOT NULL,
        branch_seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (branch_id, branch_seq)
      );
      CREATE TABLE branches (
        branch_id TEXT PRIMARY KEY,
        parent_branch_id TEXT,
        head_branch_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE contents (
        content_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE blobs (
        content_id TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE refs (
        from_content_id TEXT NOT NULL,
        from_entity_id TEXT NOT NULL,
        ref_entity_id TEXT NOT NULL,
        ref_version INTEGER NOT NULL,
        ref_content_id TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE INDEX idx_refs_target ON refs(ref_content_id);
      CREATE INDEX idx_events_branch ON events(branch_id, branch_seq);
    `);
    version = 1;
    stamp(db, 1);
  }

  // 状态迁移 2：重建引用钉版表（历史锁定在旧库中不可见 -> 迁移补齐）。
  if (version < 2) {
    db.exec(`
      CREATE TABLE reconstruction_locks (
        handle TEXT PRIMARY KEY,
        candidate_content_id TEXT NOT NULL,
        candidate_entity_id TEXT NOT NULL,
        candidate_version INTEGER NOT NULL,
        locked_at TEXT NOT NULL,
        locked_by TEXT NOT NULL
      );
    `);
    // 从既有 locked_for_reconstruction 事件回填，保证迁移不丢历史。
    const lockEvents = db
      .prepare(
        `SELECT payload_json FROM events WHERE type = 'locked_for_reconstruction'`
      )
      .all() as Array<{ payload_json: string }>;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO reconstruction_locks
       (handle, candidate_content_id, candidate_entity_id, candidate_version, locked_at, locked_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const ev of lockEvents) {
      const payload = JSON.parse(ev.payload_json) as {
        reconstructionHandle: string;
        candidateRef: { contentId: string; entityId: string; version: number };
      };
      insert.run(
        payload.reconstructionHandle,
        payload.candidateRef.contentId,
        payload.candidateRef.entityId,
        payload.candidateRef.version,
        new Date(0).toISOString(),
        'migration-v2'
      );
    }
    version = 2;
    stamp(db, 2);
  }

  // 状态迁移 3：案例安装标记（保证案例可重复、幂等安装）。
  if (version < 3) {
    db.exec(`
      CREATE TABLE case_installations (
        case_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        PRIMARY KEY (case_id, branch_id)
      );
    `);
    version = 3;
    stamp(db, 3);
  }
}

function stamp(db: DatabaseSync, version: number): void {
  db.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
  ).run(version, new Date().toISOString());
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  return row.v;
}

/** 仅供迁移测试：建立一个指定历史版本的旧 schema 数据库。 */
export function createLegacySchema(db: DatabaseSync, targetVersion: 1 | 2): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  if (targetVersion >= 1) {
    db.exec(`
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        branch_id TEXT NOT NULL,
        branch_seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (branch_id, branch_seq)
      );
      CREATE TABLE branches (
        branch_id TEXT PRIMARY KEY,
        parent_branch_id TEXT,
        head_branch_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE contents (
        content_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE blobs (
        content_id TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE refs (
        from_content_id TEXT NOT NULL,
        from_entity_id TEXT NOT NULL,
        ref_entity_id TEXT NOT NULL,
        ref_version INTEGER NOT NULL,
        ref_content_id TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE INDEX idx_refs_target ON refs(ref_content_id);
      CREATE INDEX idx_events_branch ON events(branch_id, branch_seq);
    `);
    db.prepare(
      'INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    ).run(1, new Date().toISOString());
  }
  if (targetVersion >= 2) {
    db.exec(`
      CREATE TABLE reconstruction_locks (
        handle TEXT PRIMARY KEY,
        candidate_content_id TEXT NOT NULL,
        candidate_entity_id TEXT NOT NULL,
        candidate_version INTEGER NOT NULL,
        locked_at TEXT NOT NULL,
        locked_by TEXT NOT NULL
      );
    `);
    db.prepare(
      'INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    ).run(2, new Date().toISOString());
  }
}
