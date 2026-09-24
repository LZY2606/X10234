import type { Database } from 'sql.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';
import { eventId } from '../core/ids';
import { summarize } from '../core/summary';
import type {
  AuditEvent,
  BlobRecord,
  BranchState,
  EntityKind,
  EntityRef,
  EntityView,
  EventType
} from '../core/types';

export class CorruptArchiveError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'CorruptArchiveError';
  }
}

export class VersionConflictError extends Error {
  constructor(
    public branchId: string,
    public expectedParent: string | null | undefined,
    public actualParent: string
  ) {
    super(`version conflict on branch ${branchId}`);
    this.name = 'VersionConflictError';
  }
}

export class FrozenBranchError extends Error {
  constructor(public branchId: string) {
    super(`branch ${branchId} is frozen`);
    this.name = 'FrozenBranchError';
  }
}

export interface CommitInput {
  branchId: string;
  eventType: EventType;
  subject?: { kind: EntityKind; id: string; payload: unknown } | null;
  dependencies?: EntityRef[];
  rationaleCode: string;
  rationaleDetail?: Record<string, unknown>;
  expectedParentEventId?: string | null;
  author?: string;
  createdAt?: string;
}

export interface BranchInitInput {
  branchId: string;
  name: string;
  parentBranchId?: string | null;
  forkEventId: string;
  createdAt?: string;
}

function refKey(ref: { entity_kind: string; entity_id: string }): string {
  return `${ref.entity_kind} ${ref.entity_id}`;
}

export class ArchiveStore {
  constructor(public db: Database) {}

  migrate(): number {
    const rows = this.db.exec("SELECT value FROM meta WHERE key = 'schema_version'");
    const current = rows[0]?.values[0]?.[0] ? Number(rows[0].values[0][0]) : 0;
    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        this.db.run(migration.sql);
        this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [
          String(migration.version)
        ]);
      }
    }
    return SCHEMA_VERSION;
  }

  schemaVersion(): number {
    const rows = this.db.exec("SELECT value FROM meta WHERE key = 'schema_version'");
    return rows[0]?.values[0]?.[0] ? Number(rows[0].values[0][0]) : 0;
  }

  serialize(): Uint8Array {
    return this.db.export();
  }

  putBlob(blob: BlobRecord): void {
    this.db.run(
      'INSERT OR IGNORE INTO blobs (blob_id, sha256, media_type, origin, bytes) VALUES (?,?,?,?,?)',
      [blob.blob_id, blob.sha256, blob.media_type, blob.origin, blob.bytes]
    );
  }

  getBlob(blobId: string): BlobRecord | null {
    const stmt = this.db.prepare(
      'SELECT blob_id, sha256, media_type, origin, bytes FROM blobs WHERE blob_id = ?'
    );
    stmt.bind([blobId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as unknown as Record<string, unknown>;
    stmt.free();
 return {
      blob_id: row.blob_id as string,
      sha256: row.sha256 as string,
      media_type: row.media_type as string,
      origin: row.origin as string,
      bytes: row.bytes as Uint8Array
    };
  }

  allBlobs(): BlobRecord[] {
    const out: BlobRecord[] = [];
    const stmt = this.db.prepare(
      'SELECT blob_id, sha256, media_type, origin, bytes FROM blobs ORDER BY blob_id'
    );
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as Record<string, unknown>;
      out.push({
        blob_id: row.blob_id as string,
        blob_id2: undefined,
        sha256: row.sha256 as string,
        media_type: row.media_type as string,
        origin: row.origin as string,
        bytes: row.bytes as Uint8Array
      } as unknown as BlobRecord);
    }
    stmt.free();
    return out;
  }

  initBranch(input: BranchInitInput): BranchState {
    const createdAt = input.createdAt ?? new Date(0).toISOString();
    this.db.run(
      'INSERT INTO branches (branch_id, parent_branch_id, name, fork_event_id, head_event_id, visible_json, frozen, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        input.branchId,
        input.parentBranchId ?? null,
        input.name,
        input.forkEventId,
        input.forkEventId,
        '{}',
        0,
        createdAt
      ]
    );
    return this.getBranch(input.branchId)!;
  }

  getBranch(branchId: string): (BranchState & { fork_event_id: string }) | null {
    const stmt = this.db.prepare(
      'SELECT branch_id, parent_branch_id, name, fork_event_id, head_event_id, visible_json, frozen, created_at FROM branches WHERE branch_id = ?'
    );
    stmt.bind([branchId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as unknown as Record<string, unknown>;
    stmt.free();
    return {
      branch_id: row.branch_id as string,
      parent_branch_id: (row.parent_branch_id as string | null) ?? null,
      name: row.name as string,
      head_event_id: row.head_event_id as string,
      visible: JSON.parse(row.visible_json as string),
      frozen: Boolean(row.frozen),
      created_at: row.created_at as string,
      fork_event_id: row.fork_event_id as string
    };
  }

  listBranches(): BranchState[] {
    const out: BranchState[] = [];
    const stmt = this.db.prepare('SELECT branch_id FROM branches ORDER BY created_at, branch_id');
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as { branch_id: string };
      const b = this.getBranch(row.branch_id);
      if (b) out.push(b);
    }
    stmt.free();
    return out;
  }
}
