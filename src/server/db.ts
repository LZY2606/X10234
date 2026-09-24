import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

export function currentSchemaVersion(db: DatabaseSync): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`
  );
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
    .get() as { value?: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function runMigrations(db: DatabaseSync): {
  from: number;
  to: number;
  applied: number[];
} {
  const from = currentSchemaVersion(db);
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version > from) {
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.prepare(
          `INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', ?)`
        ).run(String(m.version));
        db.exec('COMMIT');
        applied.push(m.version);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }
  return { from, to: SCHEMA_VERSION, applied };
}
