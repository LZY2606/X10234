import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.ts';

export function openDb(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  return db;
}

export function migrate(db: DatabaseSync): { from: number; applied: number[] } {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  let current = row?.user_version ?? 0;
  const from = current;
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec('COMMIT');
        current = m.version;
        applied.push(m.version);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }
  return { from, applied };
}

export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}
