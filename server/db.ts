import { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * 状态迁移：每一步显式编号，测试覆盖 v1 -> 当前版本的数据保留。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "core-store",
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fragments (
        digest TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entities (
        entity_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        body_json TEXT NOT NULL,
        derived_from_ruleset TEXT,
        PRIMARY KEY (entity_id, version)
      );
      CREATE TABLE IF NOT EXISTS entity_refs (
        owner_entity_id TEXT NOT NULL,
        owner_version INTEGER NOT NULL,
        ref_entity_id TEXT NOT NULL,
        ref_version INTEGER NOT NULL,
        ref_digest TEXT NOT NULL,
        role TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        branch_id TEXT NOT NULL,
        at TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        refs_json TEXT NOT NULL,
        base_head_event_id TEXT
      );
      CREATE TABLE IF NOT EXISTS branches (
        branch_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        material_id TEXT NOT NULL,
        material_version INTEGER NOT NULL,
        head_event_id TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `
  },
  {
    version: 2,
    name: "locks-and-freeze-sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS locks (
        lock_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        candidate_version INTEGER NOT NULL,
        adjudication_id TEXT NOT NULL,
        locked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS freeze_sessions (
        session_id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        base_head_event_id TEXT,
        opened_at TEXT NOT NULL
      );
    `
  },
  {
    version: 3,
    name: "event-parents",
    sql: `
      ALTER TABLE events ADD COLUMN parent_event_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_events_branch ON events(branch_id, seq);
      CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
    `
  }
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  for (const migration of MIGRATIONS) {
    if (migration.version > current) {
      db.exec("BEGIN");
      try {
        db.exec(migration.sql);
        db.prepare(
          `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(String(migration.version));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
  }
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}
