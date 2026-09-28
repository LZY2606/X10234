import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let warned = false;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  if (!warned) {
    const v = process.version;
    warned = true;
    void v;
  }
  migrate(db);
  return db;
}

/** 全部迁移语句（状态迁移测试逐个版本演进）。 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- 不可变内容块：同内容只存一份（最小输入/组合输入共享原始片段）
    CREATE TABLE content_blobs (
      content_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE source_versions (
      entity_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      kind TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_representation TEXT,
      units TEXT,
      coord_frame TEXT,
      branch_id TEXT NOT NULL,
      commit_event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, version_no)
    );

    CREATE TABLE branches (
      branch_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_branch_id TEXT,
      head_event_id TEXT,
      base_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- append-only 事件日志：裁定、参数修订、冲突、诊断全部是事件
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      scenario TEXT,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL,
      dependency_refs TEXT NOT NULL,
      view_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (branch_id, seq)
    );

    CREATE TABLE diagnostics (
      diagnostic_id TEXT PRIMARY KEY,
      entity_ref TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      raw_value TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_events_branch ON events(branch_id, seq);
    CREATE INDEX idx_src_branch ON source_versions(branch_id);
    `,
  },
  {
    // 迁移 v2：为反例档案的"影响范围"查询预留依赖边表（从事件冗余出来便于索引）
    version: 2,
    sql: `
    CREATE TABLE dependency_edges (
      from_event_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      to_ref TEXT NOT NULL,
      PRIMARY KEY (from_event_id, to_ref)
    );
    CREATE INDEX idx_dep_ref ON dependency_edges(to_ref);
    `,
  },
];

export function migrate(db: DatabaseSync): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     );`,
  );
  const appliedRows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
    version: number;
  }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  let current = appliedRows.length ? Math.max(...appliedRows.map((r) => r.version)) : 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        m.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      current = m.version;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return current;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
