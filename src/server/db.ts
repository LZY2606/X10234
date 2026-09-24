import { DatabaseSync } from 'node:sqlite';

export interface Migration { version: number; sql: string }

// 迁移 1：基线 schema。迁移 2：decisions 增加 note 列 + 索引（供状态迁移测试）。
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE blobs(
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  branch_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE series(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_seq INTEGER NOT NULL,
  superseded_seq INTEGER
);
CREATE TABLE sources(
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  series_id TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  superseded_seq INTEGER,
  PRIMARY KEY(id, version)
);
CREATE TABLE branches(
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_branch_id TEXT,
  source_pins TEXT NOT NULL,
  head_event_seq INTEGER,
  created_seq INTEGER NOT NULL,
  superseded_seq INTEGER
);
CREATE TABLE candidates(
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  params TEXT NOT NULL,
  point_set_hash TEXT NOT NULL,
  frame_set TEXT NOT NULL,
  residuals TEXT NOT NULL,
  total_rms_nm REAL NOT NULL,
  status TEXT NOT NULL,
  digest TEXT NOT NULL,
  refs TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  superseded_seq INTEGER,
  PRIMARY KEY(id, version)
);
CREATE TABLE decisions(
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  action TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  superseded_seq INTEGER
);
CREATE TABLE locks(
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,
  created_seq INTEGER NOT NULL,
  superseded_seq INTEGER
);
CREATE TABLE deps(
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_version INTEGER NOT NULL,
  dep_kind TEXT NOT NULL,
  dep_id TEXT NOT NULL,
  dep_version INTEGER NOT NULL
);
CREATE TABLE invalidations(
  id TEXT PRIMARY KEY,
  trigger_seq INTEGER NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE diagnostics(
  id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE archive_entries(
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE decisions ADD COLUMN note TEXT;
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_deps_dep ON deps(dep_kind, dep_id);
`,
  },
];

export const ALL_TABLES = [
  'blobs', 'events', 'series', 'sources', 'branches', 'candidates',
  'decisions', 'locks', 'deps', 'invalidations', 'diagnostics', 'archive_entries',
];

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  migrate(db);
  return db;
}

export function currentVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    return row.v ?? 0;
  } catch {
    return 0;
  }
}

export function migrate(db: DatabaseSync, targetVersion?: number): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const have = currentVersion(db);
  const target = targetVersion ?? Math.max(...MIGRATIONS.map((m) => m.version));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version > have && m.version <= target) {
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(
          m.version, new Date().toISOString(),
        );
        db.exec('COMMIT');
        applied.push(m.version);
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  }
  return applied;
}
