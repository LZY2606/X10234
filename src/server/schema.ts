/**
 * SQLite schema 与状态迁移。
 * 迁移从 v1 基线开始；测试覆盖 v1->v2（adjudications 增加 correlation_id）。
 * 所有版本化实体写入 entity_versions（append-only）；events 为机器可读事件流。
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'baseline',
    sql: `
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE repositories(repo_id TEXT PRIMARY KEY, current_revision INTEGER NOT NULL DEFAULT 0, world_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE revisions(revision_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, revision_no INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, parent_revision_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE blobs(blob_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, media_type TEXT NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE entity_versions(
      id TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
      revision_id TEXT NOT NULL, branch_id TEXT, content_hash TEXT NOT NULL,
      summary TEXT NOT NULL, refs TEXT NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL, superseded_by INTEGER,
      PRIMARY KEY(id, version)
    );
    CREATE TABLE entity_heads(id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL, branch_id TEXT);
    CREATE TABLE events(
      event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL,
      revision_id TEXT NOT NULL, branch_id TEXT NOT NULL,
      at_world_version INTEGER NOT NULL, type TEXT NOT NULL,
      subject_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      correlation_id TEXT
    );
    CREATE TABLE branches(branch_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, parent_branch_id TEXT, name TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
    CREATE TABLE dependencies(from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL, to_version INTEGER NOT NULL, revision_id TEXT NOT NULL, PRIMARY KEY(from_entity_id, to_entity_id, to_version));
    CREATE TABLE invalidations(event_id TEXT NOT NULL, changed_source TEXT NOT NULL, affected_entity_id TEXT NOT NULL, depth TEXT NOT NULL, PRIMARY KEY(event_id, affected_entity_id));
    CREATE TABLE adjudications(
      adjudication_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, branch_id TEXT NOT NULL,
      verdict TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0, undone INTEGER NOT NULL DEFAULT 0,
      expected_world_version INTEGER NOT NULL, actual_world_version INTEGER,
      created_at TEXT NOT NULL, parent_adjudication_id TEXT
    );
    CREATE TABLE locks(material_key TEXT PRIMARY KEY, adjudication_id TEXT NOT NULL, locked_at TEXT NOT NULL);
    `,
  },
  {
    version: 2,
    name: 'adjudication_correlation',
    sql: `ALTER TABLE adjudications ADD COLUMN correlation_id TEXT NOT NULL DEFAULT '';`,
  },
];

export function currentSchemaVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1].version;
}
