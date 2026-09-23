import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * 迁移历史必须保持只增不改：迁移测试从 v1 旧库升级到 v2 并核对数据。
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial-versioned-ledger',
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      -- 不可变内容片段（原始帧字节/合成内容），按内容哈希去重，共享只存一份
      CREATE TABLE raw_blobs (
        blob_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL UNIQUE,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE bundles (
        bundle_id TEXT PRIMARY KEY,
        scenario_code TEXT NOT NULL,
        bundle_kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE bundle_blobs (
        bundle_id TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (bundle_id, blob_id, role),
        FOREIGN KEY (bundle_id) REFERENCES bundles(bundle_id),
        FOREIGN KEY (blob_id) REFERENCES raw_blobs(blob_id)
      );

      CREATE TABLE branches (
        branch_id TEXT PRIMARY KEY,
        parent_branch_id TEXT,
        name TEXT NOT NULL,
        head_event_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE entities (
        entity_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        display_label TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE entity_versions (
        version_id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        branch_id TEXT NOT NULL,
        parent_version_id TEXT,
        version_kind TEXT NOT NULL, -- source-raw | interpretation | decision | rule
        payload_json TEXT NOT NULL,
        source_blob_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (entity_id, version_number, branch_id),
        FOREIGN KEY (entity_id) REFERENCES entities(entity_id),
        FOREIGN KEY (source_blob_id) REFERENCES raw_blobs(blob_id)
      );

      -- 引用固定到具体版本号；目标缺失 => 损坏，禁止回落到最新版
      CREATE TABLE version_refs (
        from_version_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        to_version_number INTEGER NOT NULL,
        ref_role TEXT NOT NULL,
        PRIMARY KEY (from_version_id, to_entity_id, ref_role),
        FOREIGN KEY (from_version_id) REFERENCES entity_versions(version_id)
      );

      CREATE TABLE rule_versions (
        version INTEGER PRIMARY KEY,
        rules_json TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE candidates (
        candidate_id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        parameter_revision INTEGER NOT NULL,
        effective_point_set_hash TEXT NOT NULL,
        effective_frame_count INTEGER NOT NULL,
        summary_rms_px REAL NOT NULL,
        ambiguous INTEGER NOT NULL,
        ambiguity_group_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE candidate_diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL,
        code TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        affected_json TEXT NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES candidates(candidate_id)
      );

      CREATE TABLE criterion_events (
        event_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        detail TEXT NOT NULL,
        related_candidate_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE adjudications (
        event_id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        chosen_candidate_id TEXT,
        rejected_candidate_ids_json TEXT NOT NULL,
        note TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        superseded_by_event_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        branch_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_id TEXT,
        entity_version_number INTEGER,
        payload_json TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE invalidation_scopes (
        scope_id TEXT PRIMARY KEY,
        caused_by_event_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        from_version_number INTEGER,
        to_version_number INTEGER,
        affected_candidate_ids_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE advisory_locks (
        lock_name TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        held_by TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'revision-grouping-for-event-replay',
    sql: `
      ALTER TABLE events ADD COLUMN revision_group TEXT;
      UPDATE events SET revision_group = 'initial' WHERE revision_group IS NULL;
      CREATE INDEX idx_events_branch_seq ON events(branch_id, seq);
      CREATE INDEX idx_entity_versions_entity ON entity_versions(entity_id, branch_id, version_number);
      CREATE INDEX idx_candidates_branch ON candidates(branch_id);
    `,
  },
];

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

export function applyMigrations(db: DatabaseSync): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     );`,
  );
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        now,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as unknown as { v: number };
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}
