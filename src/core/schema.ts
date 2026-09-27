import type { SqlDatabase } from './sqlite';

export const CURRENT_SCHEMA_VERSION = 2;

function exec(db: SqlDatabase, statements: string): void {
  db.run(statements);
}

export function migrate(db: SqlDatabase): void {
  const row = db.exec('PRAGMA user_version')[0];
  const version = row ? Number(row.values[0][0]) : 0;

  if (version === 0) {
    exec(
      db,
      `
      CREATE TABLE blobs (
        digest TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE entity_versions (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        digest TEXT NOT NULL,
        body_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        branch_id TEXT,
        PRIMARY KEY (kind, id, version)
      );

      CREATE TABLE branch_tips (
        series_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        parent_branch_id TEXT,
        fork_event_id TEXT,
        tip_event_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (series_id, branch_id)
      );

      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        ordinal_in_branch INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        parent_event_id TEXT,
        actor TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        rule_id TEXT,
        refs_json TEXT NOT NULL
      );

      CREATE UNIQUE INDEX events_branch_ordinal ON events (branch_id, ordinal_in_branch);

      CREATE TABLE dependency_edges (
        from_ref_kind TEXT NOT NULL,
        from_ref_id TEXT NOT NULL,
        from_ref_version INTEGER NOT NULL,
        to_ref_kind TEXT NOT NULL,
        to_ref_id TEXT NOT NULL,
        to_ref_version INTEGER NOT NULL,
        scope TEXT NOT NULL,
        edge_id INTEGER PRIMARY KEY AUTOINCREMENT
      );

      CREATE INDEX dep_edges_from ON dependency_edges (from_ref_kind, from_ref_id, from_ref_version);
      CREATE INDEX dep_edges_to ON dependency_edges (to_ref_kind, to_ref_id, to_ref_version);

      CREATE TABLE invalidations (
        invalidation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        caused_by_kind TEXT NOT NULL,
        caused_by_id TEXT NOT NULL,
        caused_by_version INTEGER NOT NULL,
        invalidated_kind TEXT NOT NULL,
        invalidated_id TEXT NOT NULL,
        invalidated_version INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        scope TEXT NOT NULL
      );

      CREATE TABLE freezes (
        freeze_id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        winner_actor TEXT NOT NULL,
        loser_actor TEXT NOT NULL,
        base_event_id TEXT NOT NULL,
        winner_event_id TEXT NOT NULL,
        loser_event_kind TEXT NOT NULL,
        loser_payload_digest TEXT NOT NULL,
        diff_summary TEXT NOT NULL,
        at TEXT NOT NULL
      );
      `
    );
    db.run('PRAGMA user_version = 1');
  }

  if (db.exec('PRAGMA user_version')[0]?.values[0][0] === 1) {
    exec(
      db,
      `
      CREATE TABLE entity_refs_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        ref_kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        ref_version INTEGER NOT NULL,
        ref_digest TEXT NOT NULL,
        exists_at_check INTEGER NOT NULL,
        checked_at TEXT NOT NULL
      );
      CREATE INDEX entity_refs_audit_event ON entity_refs_audit (event_id);
      `
    );
    db.run('PRAGMA user_version = 2');
  }

  const finalVersion = Number(db.exec('PRAGMA user_version')[0].values[0][0]);
  if (finalVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`未知数据库版本: ${finalVersion}`);
  }
}
