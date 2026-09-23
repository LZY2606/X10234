import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

export const CURRENT_SCHEMA_VERSION = 2;

let SQL: SqlJsStatic | null = null;

export function wasmLocateFile(): string {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc && typeof proc.versions?.node === 'string') {
    // 非静态拼接，避免 Vite 在浏览器构建时静态解析 node_modules 内文件。
    const rel = '../../' + 'node_modules/sql.js/dist/sql-wasm.wasm';
    return new URL(rel, import.meta.url).pathname;
  }
  return wasmUrl;
}

export async function loadSql(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: wasmLocateFile });
  }
  return SQL;
}

/** 测试可注入 wasm 路径（happy-dom 下 ?url import 仍返回文件路径，node 可直接读）。 */
export async function openDatabase(serialized?: Uint8Array): Promise<Database> {
  const sql = await loadSql();
  return serialized ? new sql.Database(serialized) : new sql.Database();
}

/**
 * 迁移链。状态迁移测试会从 v1 起步升级到当前版本，
 * 证明旧数据库不会被悄悄替换、身份保持连续。
 */
const MIGRATIONS: { version: number; sql: string[] }[] = [
  {
    version: 1,
    sql: [
      `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
      `CREATE TABLE bytes (
         content_hash TEXT PRIMARY KEY,
         bytes BLOB NOT NULL,
         size INTEGER NOT NULL,
         imported_at TEXT NOT NULL
       );`,
      `CREATE TABLE object_contents (
         content_id TEXT PRIMARY KEY,
         stable_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         version INTEGER NOT NULL,
         json TEXT NOT NULL,
         summary TEXT NOT NULL,
         introduced_event TEXT NOT NULL,
         UNIQUE(stable_id, version)
       );`,
      `CREATE TABLE object_refs (
         content_id TEXT NOT NULL,
         ref_content_id TEXT NOT NULL,
         role TEXT NOT NULL,
         PRIMARY KEY(content_id, ref_content_id, role)
       );`,
      `CREATE TABLE object_versions (
         branch TEXT NOT NULL,
         stable_id TEXT NOT NULL,
         version INTEGER NOT NULL,
         content_id TEXT NOT NULL,
         seq INTEGER NOT NULL,
         PRIMARY KEY(branch, stable_id, version)
       );`,
      `CREATE TABLE object_heads (
         branch TEXT NOT NULL,
         stable_id TEXT NOT NULL,
         version INTEGER NOT NULL,
         PRIMARY KEY(branch, stable_id)
       );`,
      `CREATE TABLE events (
         seq INTEGER NOT NULL,
         branch TEXT NOT NULL,
         event_id TEXT PRIMARY KEY,
         parent_event_id TEXT,
         type TEXT NOT NULL,
         scenario TEXT,
         rationale TEXT,
         author TEXT NOT NULL,
         ts TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         refs_json TEXT NOT NULL,
         invalidates_json TEXT,
         UNIQUE(branch, seq)
       );`,
      `CREATE TABLE branches (
         branch TEXT PRIMARY KEY,
         parent_branch TEXT,
         fork_event TEXT,
         label TEXT NOT NULL,
         created_seq INTEGER NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0
       );`,
      `CREATE TABLE locks (
         branch TEXT NOT NULL PRIMARY KEY,
         reference TEXT NOT NULL,
         candidate_content_id TEXT NOT NULL,
         seq INTEGER NOT NULL,
         released INTEGER NOT NULL DEFAULT 0
       );`,
      `CREATE INDEX idx_contents_stable ON object_contents(stable_id);`,
      `CREATE INDEX idx_versions_branch ON object_versions(branch, stable_id);`,
      `CREATE INDEX idx_events_branch ON events(branch, seq);`
    ]
  },
  {
    version: 2,
    sql: [
      `ALTER TABLE object_contents ADD COLUMN superseded_content_id TEXT;`,
      `CREATE TABLE scenario_marks (
         scenario TEXT NOT NULL,
         scope TEXT NOT NULL,
         key TEXT NOT NULL,
         event_id TEXT NOT NULL,
         PRIMARY KEY(scenario, scope, key)
       );`
    ]
  }
];

export function migrate(db: Database): number {
  db.run('BEGIN');
  try {
    const from = currentVersion(db);
    for (const m of MIGRATIONS) {
      if (m.version <= from) continue;
      for (const stmt of m.sql) db.run(stmt);
    }
    db.run('DELETE FROM schema_meta WHERE key=?', ['schemaVersion']);
    db.run('INSERT INTO schema_meta(key,value) VALUES (?,?)', ['schemaVersion', String(CURRENT_SCHEMA_VERSION)]);
    db.run('COMMIT');
    return CURRENT_SCHEMA_VERSION;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

export function currentVersion(db: Database): number {
  try {
    const r = db.exec('SELECT value FROM schema_meta WHERE key=?', ['schemaVersion']);
    if (r.length && r[0].values.length) return Number(r[0].values[0][0]);
  } catch {
    /* 空库 */
  }
  return 0;
}

export function queryRows<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params as Database.SqlValue[]);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
    return rows;
  } finally {
    stmt.free();
  }
}

export function queryOne<T>(db: Database, sql: string, params: unknown[] = []): T | null {
  return queryRows<T>(db, sql, params)[0] ?? null;
}

export function serialize(db: Database): Uint8Array {
  return db.export();
}
