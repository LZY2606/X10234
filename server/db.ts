import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "core-versioned-store",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS blobs (
          hash TEXT PRIMARY KEY,
          media_type TEXT NOT NULL,
          content TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          created_seq INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          created_seq INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entity_versions (
          entity_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          payload TEXT NOT NULL,
          digest TEXT NOT NULL,
          refs TEXT NOT NULL DEFAULT '[]',
          event_seq INTEGER NOT NULL,
          PRIMARY KEY (entity_id, branch_id, version)
        );
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          branch_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: "branches-and-dependencies",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS branches (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          parent_id TEXT,
          base_event_seq INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
        );
        CREATE TABLE IF NOT EXISTS dependencies (
          derivation_id TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          rule_version INTEGER NOT NULL,
          branch_id TEXT NOT NULL,
          input_entity_id TEXT NOT NULL,
          input_version INTEGER NOT NULL,
          output_entity_id TEXT NOT NULL,
          output_version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'valid',
          PRIMARY KEY (derivation_id, input_entity_id, output_entity_id)
        );
      `);
    }
  },
  {
    version: 3,
    name: "locks-and-source-hash",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS locks (
          scope TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          digest TEXT NOT NULL,
          event_seq INTEGER NOT NULL
        );
        ALTER TABLE entity_versions ADD COLUMN source_hash TEXT;
      `);
    }
  }
];

export function migrate(db: DatabaseSync): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const rows = db.prepare(`SELECT version FROM schema_migrations`).all() as Array<{ version: number }>;
  const applied = new Set(rows.map((r) => r.version));
  const nowApplied: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      m.up(db);
      db.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`).run(
        m.version,
        m.name,
        new Date().toISOString()
      );
      db.exec("COMMIT");
      nowApplied.push(m.version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return nowApplied;
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
