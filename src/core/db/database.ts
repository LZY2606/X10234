import type { Database, SqlJsStatic } from 'sql.js';
import { MIGRATIONS } from './schema.js';

export interface ChamberDB {
  db: Database;
  sqljs: SqlJsStatic;
  revision: number;
}

export async function initSqlJs(locateFile?: (file: string) => string): Promise<SqlJsStatic> {
  const init = (await import('sql.js')).default;
  return init(locateFile ? { locateFile } : undefined);
}

export async function openChamber(locateFile?: (file: string) => string): Promise<ChamberDB> {
  const sqljs = await initSqlJs(locateFile);
  const db = new sqljs.Database();
  const chamber = { db, sqljs, revision: 0 };
  migrate(chamber);
  return chamber;
}

export function deserializeChamber(sqljs: SqlJsStatic, bytes: Uint8Array): ChamberDB {
  const db = new sqljs.Database(bytes);
  const chamber = { db, sqljs, revision: readRevision(db) };
  migrate(chamber);
  return chamber;
}

export function serializeChamber(chamber: ChamberDB): Uint8Array {
  return chamber.db.export();
}

export function readRevision(db: Database): number {
  const row = db.exec("SELECT value FROM meta WHERE key = 'db_revision'")[0];
  return row ? Number(row.values[0][0]) : 0;
}

export function bumpRevision(chamber: ChamberDB): number {
  chamber.db.run("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_revision'");
  chamber.revision = readRevision(chamber.db);
  return chamber.revision;
}

export function appliedVersions(db: Database): number[] {
  const tableExists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
  if (tableExists.length === 0) return [];
  const res = db.exec('SELECT version FROM schema_migrations ORDER BY version');
  if (res.length === 0) return [];
  return res[0].values.map((r) => Number(r[0]));
}

export function migrate(chamber: ChamberDB): number[] {
  const db = chamber.db;
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(appliedVersions(db));
  const ran: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.run('BEGIN TRANSACTION');
    try {
      db.run(migration.up);
      const stamp = new Date().toISOString();
      const stmt = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)');
      stmt.run([migration.version, migration.name, stamp]);
      stmt.free();
      db.run('COMMIT');
      ran.push(migration.version);
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
  }
  chamber.revision = readRevision(db);
  return ran;
}

export function assertChamber(db: Database): void {
  const role = db.exec("SELECT value FROM meta WHERE key = 'database_role'");
  if (role.length === 0 || role[0].values[0][0] !== 'tilt_stitch_chamber') {
    throw new Error('CORRUPT_DATABASE: not a tilt_stitch_chamber archive');
  }
}
