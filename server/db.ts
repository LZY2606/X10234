import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 状态迁移：migrations 按序执行，PRAGMA user_version 记录当前版本。
 * 迁移测试会构造旧版本库再升级，验证数据保留。
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE blobs (
        id TEXT PRIMARY KEY,
        content BLOB NOT NULL,
        media_type TEXT NOT NULL,
        byte_len INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE entity_versions (
        entity_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        blob_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'valid',
        created_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, version_no)
      );
      CREATE TABLE refs (
        from_entity TEXT NOT NULL,
        from_version INTEGER NOT NULL,
        ref_kind TEXT NOT NULL,
        to_entity TEXT NOT NULL,
        to_version INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE branches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        rule_id TEXT,
        payload TEXT NOT NULL,
        refs TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        severity TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        raw TEXT
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        action TEXT NOT NULL,
        candidate_entity TEXT NOT NULL,
        candidate_version INTEGER NOT NULL,
        rationale TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        undo_of TEXT,
        base_head INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE locks (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        candidate_entity TEXT NOT NULL,
        candidate_version INTEGER NOT NULL,
        locked_by TEXT NOT NULL,
        note TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE review_docs (
        id TEXT PRIMARY KEY,
        head INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `,
  },
];

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db: DatabaseSync): number[] {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let current = row.user_version;
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec("BEGIN");
      try {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      applied.push(m.version);
      current = m.version;
    }
  }
  return applied;
}
