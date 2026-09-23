import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core',
    up(db) {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE raw_blobs (
          hash TEXT PRIMARY KEY,
          label TEXT,
          media_type TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE branches (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          parent_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE entities (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE entity_versions (
          entity_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          content TEXT NOT NULL,
          refs TEXT NOT NULL,
          deps TEXT NOT NULL,
          digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (entity_id, version)
        );
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          branch_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE decisions (
          id TEXT PRIMARY KEY,
          branch_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          action TEXT NOT NULL,
          payload TEXT NOT NULL,
          by TEXT NOT NULL,
          status TEXT NOT NULL,
          reverted_by_seq INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE TABLE locks (
          id TEXT PRIMARY KEY,
          candidate_entity_id TEXT NOT NULL,
          candidate_version INTEGER NOT NULL,
          branch_id TEXT NOT NULL,
          by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: 'diagnostics-and-event-supersedes',
    up(db) {
      db.exec(`
        ALTER TABLE events ADD COLUMN supersedes TEXT;
        CREATE TABLE diagnostics (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          message TEXT NOT NULL,
          raw_value TEXT,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
];

export function migrate(db: DatabaseSync, upTo?: number): number[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const nowApplied: number[] = [];
  for (const m of MIGRATIONS) {
    if (upTo !== undefined && m.version > upTo) break;
    if (applied.has(m.version)) continue;
    m.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      m.version,
      m.name,
      new Date().toISOString(),
    );
    nowApplied.push(m.version);
  }
  return nowApplied;
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  migrate(db);
  return db;
}
