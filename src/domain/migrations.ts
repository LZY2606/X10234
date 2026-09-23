import type { DatabaseSync } from 'node:sqlite';

export type Migration = {
  version: number;
  up: (db: DatabaseSync) => void;
};

// 状态迁移：版本化 schema。迁移测试会从 v1 逐步升级并校验旧数据存活。
export const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE blobs (
          blob_id    TEXT PRIMARY KEY,
          media_type TEXT NOT NULL,
          content    TEXT NOT NULL,
          digest     TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE sources (
          source_id  TEXT NOT NULL,
          version    INTEGER NOT NULL,
          kind       TEXT NOT NULL,
          blob_id    TEXT NOT NULL,
          digest     TEXT NOT NULL,
          note       TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          PRIMARY KEY (source_id, version)
        );
        CREATE TABLE interpretations (
          interp_id   TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          parent_id   TEXT,
          params      TEXT NOT NULL,
          pins        TEXT NOT NULL,
          created_seq INTEGER NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE TABLE point_sets (
          point_set_id TEXT PRIMARY KEY,
          members      TEXT NOT NULL,
          digest       TEXT NOT NULL
        );
        CREATE TABLE candidates (
          candidate_id TEXT PRIMARY KEY,
          interp_id    TEXT NOT NULL,
          model_kind   TEXT NOT NULL,
          point_set_id TEXT NOT NULL,
          ambiguity_group TEXT,
          axis         TEXT NOT NULL,
          residuals    TEXT NOT NULL,
          per_frame    TEXT NOT NULL,
          param_count  INTEGER NOT NULL,
          diagnostics  TEXT NOT NULL,
          created_seq  INTEGER NOT NULL
        );
        CREATE TABLE events (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id   TEXT NOT NULL,
          kind       TEXT NOT NULL,
          actor      TEXT NOT NULL,
          payload    TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE decisions (
          decision_id  TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          verdict      TEXT NOT NULL,
          rationale    TEXT NOT NULL,
          event_seq    INTEGER NOT NULL,
          undone_seq   INTEGER
        );
        CREATE TABLE locks (
          lock_id       TEXT PRIMARY KEY,
          candidate_id  TEXT NOT NULL,
          interp_id     TEXT NOT NULL,
          event_seq     INTEGER NOT NULL,
          active        INTEGER NOT NULL DEFAULT 1,
          superseded_seq INTEGER
        );
        CREATE TABLE invalidations (
          object_kind TEXT NOT NULL,
          object_id   TEXT NOT NULL,
          reason      TEXT NOT NULL,
          detail      TEXT NOT NULL,
          event_seq   INTEGER NOT NULL,
          PRIMARY KEY (object_kind, object_id, event_seq)
        );
      `);
    }
  },
  {
    version: 2,
    up(db) {
      // v2：复核标注（不回写原始数据，只作为新事件之外的可见备注表）
      db.exec(`
        CREATE TABLE review_annotations (
          annotation_id TEXT PRIMARY KEY,
          target_kind   TEXT NOT NULL,
          target_id     TEXT NOT NULL,
          note          TEXT NOT NULL,
          created_seq   INTEGER NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE TABLE normalization_diagnostics (
          diag_id    TEXT PRIMARY KEY,
          source_id  TEXT NOT NULL,
          version    INTEGER NOT NULL,
          code       TEXT NOT NULL,
          message    TEXT NOT NULL,
          at_path    TEXT,
          raw_value  TEXT
        );
      `);
    }
  }
];

export function latestSchemaVersion(): number {
  return migrations[migrations.length - 1].version;
}

// 迁移到目标版本；默认到最新。失败抛出，由调用方回滚。
export function runMigrations(db: DatabaseSync, targetVersion?: number): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
  );
  const appliedRows = db.prepare(`SELECT version FROM schema_migrations`).all() as Array<{ version: number }>;
  let applied = new Set(appliedRows.map((r) => r.version));
  const target = targetVersion ?? latestSchemaVersion();
  for (const migration of migrations) {
    if (migration.version > target) break;
    if (!applied.has(migration.version)) {
      db.exec('BEGIN');
      try {
        migration.up(db);
        db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
          migration.version,
          new Date().toISOString()
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      applied = new Set([...applied, migration.version]);
    }
  }
  return target;
}
