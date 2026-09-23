import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

interface Migration { version: number; name: string; sql: string }

// 状态迁移：逐版本推进，迁移测试覆盖 v1 → v2
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'event-sourced-core',
    sql: `
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE blobs (hash TEXT PRIMARY KEY, media_type TEXT NOT NULL, content TEXT NOT NULL);
      CREATE TABLE sources (
        source_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
        blob_hash TEXT NOT NULL REFERENCES blobs(hash), created_seq INTEGER NOT NULL,
        PRIMARY KEY (source_id, version)
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        branch_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL,
        actor TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE branches (
        branch_id TEXT PRIMARY KEY, name TEXT NOT NULL,
        base_seq INTEGER NOT NULL, head_seq INTEGER NOT NULL
      );
      CREATE TABLE entities (
        entity_id TEXT NOT NULL, version INTEGER NOT NULL, branch_id TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, deps TEXT NOT NULL,
        digest TEXT NOT NULL, status TEXT NOT NULL, created_seq INTEGER NOT NULL,
        PRIMARY KEY (entity_id, version, branch_id)
      );
    `,
  },
  {
    version: 2,
    name: 'diagnostics-locks-ruleset',
    sql: `
      CREATE TABLE diagnostics (
        diag_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, entity_version INTEGER NOT NULL,
        branch_id TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL,
        path TEXT, created_seq INTEGER NOT NULL
      );
      CREATE TABLE locks (
        lock_id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
        entity_version INTEGER NOT NULL, created_seq INTEGER NOT NULL
      );
      ALTER TABLE entities ADD COLUMN ruleset TEXT NOT NULL DEFAULT 'ruleset/1.0.0';
    `,
  },
];

export function openDb(path = ':memory:'): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function currentVersion(db: DB): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

export function migrate(db: DB, targetVersion?: number): number[] {
  const applied: number[] = [];
  const have = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= have) continue;
    if (targetVersion !== undefined && m.version > targetVersion) break;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(m.version);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return applied;
}
