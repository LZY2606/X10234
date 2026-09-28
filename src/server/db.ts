/**
 * SQLite 存储层（Node 内置 node:sqlite）。
 * 迁移以版本链形式保存，并提供状态迁移测试所需的迁移记录。
 * 所有写操作在事务中完成：导入失败即回滚，不留半份记录。
 */
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from './util';

export interface StoreOptions {
  readonly?: boolean;
}

export function openDatabase(path: string, opts: StoreOptions = {}): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: opts.readonly ?? false });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export const MIGRATIONS: { version: number; name: string; up: string }[] = [
  {
    version: 1,
    name: 'baseline_events_blobs',
    up: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (
        sha256 TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branches (
        branch_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_branch_id TEXT,
        parent_event_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        type TEXT NOT NULL,
        author TEXT NOT NULL,
        at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        derivation_json TEXT,
        expected_version INTEGER NOT NULL DEFAULT 0,
        conflict_with_event_id TEXT,
        parent_event_id TEXT,
        prev_event_id TEXT,
        UNIQUE (branch_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_events_branch ON events(branch_id, version);
    `,
  },
  {
    // v2：为事件追加“内容摘要链”，支撑导入校验与显示值稳定身份。
    // 旧事件重放后回填 payload_sha256（状态迁移测试覆盖该回填）。
    version: 2,
    name: 'event_content_hash_chain',
    up: `
      ALTER TABLE events ADD COLUMN payload_sha256 TEXT;
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    `,
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  const appliedRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  for (const m of MIGRATIONS) {
    if (m.version <= appliedRow.v) continue;
    const apply = () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(m.up);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        ).run(m.version, m.name, new Date().toISOString());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    };
    apply();
    if (m.version === 2) backfillPayloadHashes(db);
  }
}

function backfillPayloadHashes(db: DatabaseSync): void {
  // 延迟引入避免循环；回填 v1 事件的内容摘要。
  const rows = db.prepare('SELECT event_id, payload_json FROM events').all() as {
    event_id: string;
    payload_json: string;
  }[];
  if (rows.length === 0) return;
  const stmt = db.prepare('UPDATE events SET payload_sha256 = ? WHERE event_id = ?');
  for (const row of rows) stmt.run(sha256Hex(row.payload_json), row.event_id);
}
