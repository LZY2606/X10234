import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const CORE_SCHEMA = `
CREATE TABLE blobs (
  digest TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE entity_versions (
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  blob_digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  supersedes INTEGER,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, version, branch_id)
);
CREATE TABLE version_sources (
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  role TEXT NOT NULL
);
CREATE TABLE dependencies (
  dependent_entity TEXT NOT NULL,
  dependent_version INTEGER NOT NULL,
  dependency_entity TEXT NOT NULL,
  dependency_version INTEGER NOT NULL
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  branch_id TEXT,
  entity_id TEXT,
  entity_version INTEGER,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE review_docs (
  branch_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  accepted_candidate TEXT,
  rejected TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE adjudications (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  candidate_id TEXT,
  prev_state TEXT NOT NULL,
  new_state TEXT NOT NULL,
  reverted_by TEXT,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-versioned-store',
    up(db) {
      db.exec(CORE_SCHEMA);
    },
  },
  {
    version: 2,
    name: 'scenario-runs',
    up(db) {
      db.exec(`
        CREATE TABLE scenario_runs (
          id TEXT PRIMARY KEY,
          scenario TEXT NOT NULL,
          input_kind TEXT NOT NULL,
          input_entity TEXT NOT NULL,
          diagnostics TEXT NOT NULL,
          affected TEXT NOT NULL,
          results TEXT NOT NULL,
          seq INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: 'alignment-locks',
    up(db) {
      db.exec(`
        CREATE TABLE locks (
          id TEXT PRIMARY KEY,
          branch_id TEXT NOT NULL,
          candidate_entity TEXT NOT NULL,
          candidate_version INTEGER NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          seq INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function migrateTo(db: DatabaseSync, targetVersion: number): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  for (const m of MIGRATIONS) {
    if (m.version > row.v && m.version <= targetVersion) {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    }
  }
}

export function migrate(db: DatabaseSync): void {
  migrateTo(db, SCHEMA_VERSION);
}

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}
