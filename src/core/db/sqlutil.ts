import type { Database } from 'sql.js';

export function run(db: Database, sql: string, params: (string | number | null | Uint8Array)[] = []): void {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}

export function one<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: (string | number | null)[] = []
): T | null {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (stmt.step()) return stmt.getAsObject() as unknown as T;
    return null;
  } finally {
    stmt.free();
  }
}

export function all<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: (string | number | null)[] = []
): T[] {
  const stmt = db.prepare(sql);
  const rows: T[] = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
  } finally {
    stmt.free();
  }
  return rows;
}

export function tx<T>(db: Database, fn: () => T): T {
  db.run('SAVEPOINT chamber_write');
  try {
    const result = fn();
    db.run('RELEASE SAVEPOINT chamber_write');
    return result;
  } catch (err) {
    db.run('ROLLBACK TO SAVEPOINT chamber_write');
    db.run('RELEASE SAVEPOINT chamber_write');
    throw err;
  }
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}
