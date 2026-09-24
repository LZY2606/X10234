import initSqlJs from 'sql.js';
// @ts-expect-error - vite 提供 ?url（Node 下解析为文件路径，浏览器下为资源 URL）
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { migrations, LATEST_SCHEMA_VERSION } from './migrations';

export type SQL = Awaited<ReturnType<typeof initSqlJs>>;
export type Database = InstanceType<SQL['Database']>;

let sqlPromise: Promise<SQL> | null = null;

export async function loadSql(): Promise<SQL> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => wasmUrl as string });
  }
  return sqlPromise;
}

export async function openDatabase(existing?: Uint8Array | null): Promise<Database> {
  const SQL = await loadSql();
  const db = existing ? new SQL.Database(existing) : new SQL.Database();
  return db;
}

export function currentSchemaVersion(db: Database): number {
  try {
    const row = db.exec('SELECT value FROM meta WHERE key = $k', { $k: 'schemaVersion' });
    if (row.length && row[0].values.length) return Number(row[0].values[0][0]);
    return 0;
  } catch {
    return 0;
  }
}

/** 全新库或历史库都按顺序迁移到最新版本；迁移测试直接调用它。 */
export function migrate(db: Database): { from: number; to: number; applied: number[] } {
  const from = currentSchemaVersion(db);
  const applied: number[] = [];
  db.run('BEGIN');
  try {
    for (const m of migrations) {
      if (m.version <= from) continue;
      for (const stmt of m.statements) db.run(stmt);
      applied.push(m.version);
    }
    db.run(
      `INSERT INTO meta(key,value) VALUES('schemaVersion',$v)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      { $v: String(LATEST_SCHEMA_VERSION) }
    );
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  return { from, to: LATEST_SCHEMA_VERSION, applied };
}

export function exportBytes(db: Database): Uint8Array {
  return db.export();
}

export function queryAll<T = Record<string, unknown>>(db: Database, sql: string, params?: unknown): T[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind((params ?? {}) as never);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
    return rows;
  } finally {
    stmt.free();
  }
}

export function queryOne<T = Record<string, unknown>>(db: Database, sql: string, params?: unknown): T | null {
  return queryAll<T>(db, sql, params)[0] ?? null;
}
