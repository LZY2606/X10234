import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/**
 * 状态迁移链。v1 为基线 schema；v2 增加裁定/锁定与分支列。
 * 迁移测试会构造 v1 库、灌入数据、再迁移到最新版验证无损。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'versioned-core',
    up(db) {
      db.exec(`
        CREATE TABLE blobs (
          hash TEXT PRIMARY KEY,
          media_type TEXT NOT NULL,
          content BLOB NOT NULL,
          byte_len INTEGER NOT NULL
        );
        CREATE TABLE entities (
          entity_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          entity_type TEXT NOT NULL,
          content_hash TEXT NOT NULL REFERENCES blobs(hash),
          summary TEXT NOT NULL,
          created_event TEXT NOT NULL,
          created_seq INTEGER NOT NULL,
          PRIMARY KEY (entity_id, version)
        );
        CREATE TABLE entity_refs (
          from_id TEXT NOT NULL,
          from_version INTEGER NOT NULL,
          role TEXT NOT NULL,
          to_id TEXT NOT NULL,
          to_version INTEGER NOT NULL,
          PRIMARY KEY (from_id, from_version, role, to_id, to_version)
        );
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          payload_hash TEXT NOT NULL REFERENCES blobs(hash),
          prev_event TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
    },
  },
  {
    version: 2,
    name: 'decisions-locks-branches',
    up(db) {
      db.exec(`
        ALTER TABLE entities ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'main';
        CREATE TABLE decisions (
          decision_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES events(event_id),
          candidate_id TEXT NOT NULL,
          candidate_version INTEGER NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('accept','reject')),
          rationale TEXT NOT NULL,
          undone_by TEXT
        );
        CREATE TABLE locks (
          lock_id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          entity_version INTEGER NOT NULL,
          event_id TEXT NOT NULL REFERENCES events(event_id)
        );
        CREATE INDEX idx_refs_to ON entity_refs (to_id, to_version);
        CREATE INDEX idx_events_seq ON events (seq);
      `);
    },
  },
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function migrate(db: DatabaseSync, targetVersion?: number): number {
  const target = targetVersion ?? MIGRATIONS[MIGRATIONS.length - 1].version;
  let version = currentSchemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= version || m.version > target) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version = m.version;
  }
  return version;
}
