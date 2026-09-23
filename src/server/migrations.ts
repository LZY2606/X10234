/** 状态迁移：按版本顺序应用，绝不原地改写旧结论。 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'core-versioned-store',
    sql: `
      CREATE TABLE blob (
        hash TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        content BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE source_record (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        logical_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        blob_hash TEXT NOT NULL REFERENCES blob(hash),
        meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(kind, logical_id, version)
      );
      CREATE TABLE branch (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE scenario (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        minimal_input TEXT NOT NULL,
        combined_input TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE interpretation (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branch(id),
        version INTEGER NOT NULL,
        rule_set_version INTEGER NOT NULL,
        source_refs TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        scenario_id TEXT,
        variant TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE candidate (
        id TEXT PRIMARY KEY,
        interpretation_id TEXT NOT NULL REFERENCES interpretation(id),
        kind TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        effective_point_set TEXT NOT NULL,
        tilt_axis TEXT NOT NULL,
        per_frame_residuals TEXT NOT NULL,
        alternatives TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE event (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(branch_id, seq)
      );
      CREATE TABLE adjudication (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        base_seq INTEGER NOT NULL,
        event_seq INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'event-actor-and-diagnostics',
    sql: `
      ALTER TABLE event ADD COLUMN actor TEXT NOT NULL DEFAULT 'system';
      CREATE TABLE diagnostic (
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'locks-and-freezes',
    sql: `
      CREATE TABLE locked_alignment (
        branch_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        adjudication_id TEXT,
        locked_at TEXT NOT NULL
      );
      CREATE TABLE branch_freeze (
        branch_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        frozen_at TEXT NOT NULL
      );
    `,
  },
];
