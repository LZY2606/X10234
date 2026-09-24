import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DB {
  raw: DatabaseSync;
}

// Every migration is append-only; migration tests replay every version.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE content_blobs (
      digest TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      bytes BLOB NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE entity_versions (
      entity_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      refs TEXT NOT NULL,
      created_by_event TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, version)
    );
    CREATE TABLE entity_heads (
      entity_id TEXT PRIMARY KEY,
      head_version INTEGER NOT NULL,
      locked_ref TEXT
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE adjudication_locks (
      scope TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    `,
  },
  {
    version: 2,
    sql: `
    CREATE TABLE archive_manifests (
      archive_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      content_count INTEGER NOT NULL
    );
    ALTER TABLE entity_versions ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'main';
    `,
  },
];

export function applyMigrations(db: DatabaseSync): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const getV = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`);
  let current = Number((getV.get() as { value?: string } | undefined)?.value ?? 0);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare(`INSERT OR REPLACE INTO schema_meta(key,value) VALUES('schema_version',?)`).run(String(m.version));
      db.exec('COMMIT');
      current = m.version;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return current;
}

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  applyMigrations(raw);
  return { raw };
}

export function closeDatabase(db: DB): void {
  db.raw.close();
}
