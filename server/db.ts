import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

interface Migration { version: number; name: string; sql: string; }

// 分步迁移：迁移测试会从旧版本建库再升级到最新。
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,          -- 内容寻址：共享原始片段只存一份
  content TEXT NOT NULL,          -- 规范化 JSON，不可变
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY,            -- 'src.tilt_angles.v2'
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  blob_hash TEXT NOT NULL,        -- 引用 blobs；缺失必须报损坏
  unit_json TEXT NOT NULL,
  supersedes TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE interpretations (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  version INTEGER NOT NULL,
  pins_json TEXT NOT NULL,        -- 显式钉住每个来源版本
  params_json TEXT NOT NULL,
  derived_from TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  interpretation_id TEXT NOT NULL,
  scheme TEXT NOT NULL,
  effective_set_json TEXT NOT NULL,
  frames_used_json TEXT NOT NULL,
  residuals_json TEXT NOT NULL,
  comparison_rmse_nm REAL NOT NULL,
  dof INTEGER NOT NULL,
  diagnostics_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,            -- 'evt.000001'
  seq INTEGER NOT NULL,
  branch TEXT NOT NULL,
  type TEXT NOT NULL,
  parent TEXT,
  base_head TEXT,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  resulting_json TEXT NOT NULL,   -- 事件后的可见状态快照（恢复历史用）
  invalidated_json TEXT NOT NULL, -- 失效范围
  created_at TEXT NOT NULL
);
CREATE TABLE branches (
  name TEXT PRIMARY KEY,
  head_event_id TEXT
);
CREATE TABLE deps (
  entity_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (entity_id, depends_on)
);
CREATE TABLE locks (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  interpretation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,
  },
  {
    version: 2,
    name: 'judgment_basis',
    sql: `
ALTER TABLE events ADD COLUMN judgment_json TEXT;   -- 机器可读的判断依据
CREATE TABLE diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  at TEXT,
  severity TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,
  },
  {
    version: 3,
    name: 'freeze_and_reconstruction',
    sql: `
ALTER TABLE branches ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;  -- 并发冻结
CREATE TABLE reconstruction_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lock_id TEXT NOT NULL,
  consumer TEXT NOT NULL,          -- 引用方（重建流程）
  read_at TEXT NOT NULL
);`,
  },
];

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function currentVersion(db: DB): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function migrate(db: DB, toVersion?: number): void {
  const target = toVersion ?? MIGRATIONS[MIGRATIONS.length - 1].version;
  let v = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version > v && m.version <= target) {
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      v = m.version;
    }
  }
}
