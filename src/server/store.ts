import type { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalJSON, digestOf, eventIdOf } from '../domain/ids.js';
import type { EventType, EventRecord, EntityVersionRef } from '../domain/types.js';
import { replay, type ReplayState } from './replay.js';

export class VersionConflictError extends Error {
  constructor(
    public expectedHead: string,
    public actualHead: string,
    public serverEvents: EventRecord[],
  ) {
    super('version-conflict');
    this.name = 'VersionConflictError';
  }
}

export class CorruptionError extends Error {
  constructor(
    public entityId: string,
    public missing: { entityId: string; reason: string }[],
  ) {
    super(`corrupted-reference: ${entityId}`);
    this.name = 'CorruptionError';
  }
}

interface BlobRow {
  content_id: string;
  media_type: string;
  byte_length: number;
  sha256: string;
  bytes: Uint8Array;
}

export class Store {
  constructor(private db: DatabaseSync) {}

  now(): string {
    return new Date().toISOString();
  }

  // ---------- 不可变字节（内容寻址；共享原始片段只存一份） ----------
  putBlob(bytes: Uint8Array, mediaType: string): { contentId: string; sha256: string } {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const contentId = `blob-${sha.slice(0, 32)}`;
    const existing = this.db.prepare('SELECT content_id FROM blobs WHERE content_id = ?').get(contentId);
    if (!existing) {
      this.db
        .prepare(
          'INSERT INTO blobs (content_id, media_type, byte_length, sha256, bytes, created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(contentId, mediaType, bytes.length, sha, bytes, this.now());
    }
    return { contentId, sha256: sha };
  }

  getBlob(contentId: string): BlobRow | undefined {
    return this.db.prepare('SELECT * FROM blobs WHERE content_id = ?').get(contentId) as BlobRow | undefined;
  }

  // ---------- 分支 ----------
  createBranch(branchId: string, seriesId: string, name: string, parentBranchId: string | null): void {
    this.db
      .prepare(
        'INSERT INTO branches (branch_id, series_id, parent_branch_id, name, head_event_id, head_version, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(branchId, seriesId, parentBranchId, name, null, 0, this.now());
  }

  getBranch(branchId: string) {
    return this.db.prepare('SELECT * FROM branches WHERE branch_id = ?').get(branchId) as
      | {
          branch_id: string;
          series_id: string;
          parent_branch_id: string | null;
          name: string;
          head_event_id: string | null;
          head_version: number;
        }
      | undefined;
  }

  listBranches(seriesId: string) {
    return (
      this.db
        .prepare('SELECT * FROM branches WHERE series_id = ? ORDER BY created_at')
        .all(seriesId) as any[]
    ).map((r) => ({
      branchId: r.branch_id,
      seriesId: r.series_id,
      parentBranchId: r.parent_branch_id,
      name: r.name,
      headEventId: r.head_event_id,
      headVersion: r.head_version,
    }));
  }

  /** 分叉：复制父分支事件血缘的起点身份；新分支独立追加。 */
  forkBranch(newBranchId: string, seriesId: string, name: string, parentBranchId: string): void {
    const parent = this.getBranch(parentBranchId);
    if (!parent) throw new Error(`unknown-parent-branch: ${parentBranchId}`);
    const tx = this.db.prepare('INSERT INTO branches VALUES (?,?,?,?,?,?,?)');
    this.db
      .prepare(
        'INSERT INTO branches (branch_id, series_id, parent_branch_id, name, head_event_id, head_version, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(newBranchId, seriesId, parentBranchId, name, parent.head_event_id, parent.head_version, this.now());
    void tx;
  }

  // ---------- 事件追加（乐观并发 + 稳定身份） ----------
  /**
   * @returns append 结果；expectedHead 非 null 时执行并发冻结检查：
   * 与分支当前头不一致则抛 VersionConflictError，并返回对方事件供双方差异展示。
   */
  appendEvent(args: {
    seriesId: string;
    branchId: string;
    type: EventType;
    payload: Record<string, unknown>;
    rationale?: Record<string, unknown>;
    expectedHead?: string | null;
    parentIds?: string[];
  }): EventRecord {
    const branch = this.getBranch(args.branchId);
    if (!branch) throw new Error(`unknown-branch: ${args.branchId}`);

    if (args.expectedHead !== undefined) {
      const current = branch.head_event_id ?? '∅';
      if (args.expectedHead !== current) {
        const serverEvents = this.eventsAfter(args.branchId, args.expectedHead === '∅' ? null : args.expectedHead);
        throw new VersionConflictError(args.expectedHead ?? '∅', current, serverEvents);
      }
    }

    const ordinal = branch.head_version + 1;
    const parentIds = args.parentIds ?? (branch.head_event_id ? [branch.head_event_id] : []);
    const rec: EventRecord = {
      id: '',
      seriesId: args.seriesId,
      branchId: args.branchId,
      ordinal,
      type: args.type,
      parentIds,
      payload: args.payload,
      rationale: args.rationale,
      createdAt: this.now(),
      contentDigest: '',
    };
    rec.contentDigest = digestOf({ payload: args.payload, rationale: args.rationale ?? null });
    rec.id = eventIdOf({
      type: rec.type,
      branch: rec.branchId,
      parentIds: rec.parentIds,
      ordinal: rec.ordinal,
      payload: { p: rec.payload, r: rec.rationale ?? null },
    });

    this.db
      .prepare(
        'INSERT INTO events (event_id, series_id, branch_id, ordinal, type, parent_ids, payload_json, rationale_json, content_digest, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        rec.id,
        rec.seriesId,
        rec.branchId,
        rec.ordinal,
        rec.type,
        JSON.stringify(rec.parentIds),
        canonicalJSON(rec.payload),
        rec.rationale ? canonicalJSON(rec.rationale) : null,
        rec.contentDigest,
        rec.createdAt,
      );

    this.db
      .prepare('UPDATE branches SET head_event_id = ?, head_version = ? WHERE branch_id = ?')
      .run(rec.id, ordinal, args.branchId);
    return rec;
  }

  eventsAfter(branchId: string, afterEventId: string | null): EventRecord[] {
    if (!afterEventId) return this.listEvents(branchId);
    const row = this.db.prepare('SELECT ordinal FROM events WHERE event_id = ?').get(afterEventId) as
      | { ordinal: number }
      | undefined;
    if (!row) return this.listEvents(branchId);
    return this.listEvents(branchId).filter((e) => e.ordinal > row.ordinal);
  }

  listEvents(branchId: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE branch_id = ? ORDER BY ordinal ASC')
      .all(branchId) as any[];
    return rows.map(rowToEvent);
  }

  listAllEvents(seriesId: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE series_id = ? ORDER BY created_at, ordinal')
      .all(seriesId) as any[];
    return rows.map(rowToEvent);
  }

  getEvent(eventId: string): EventRecord | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as any;
    return row ? rowToEvent(row) : undefined;
  }

  replayBranch(branchId: string, upToOrdinal?: number): ReplayState {
    const branch = this.getBranch(branchId);
    if (!branch) throw new Error(`unknown-branch: ${branchId}`);
    return replay(this.listEvents(branchId), upToOrdinal, branch.series_id);
  }

  // ---------- 锁定 ----------
  setLock(lock: {
    branchId: string;
    seriesId: string;
    candidateId: string;
    reconstructionRef: string;
    lockedBy: string;
    references: EntityVersionRef[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO locks (branch_id, series_id, candidate_id, reconstruction_ref, locked_by, locked_at, references_json)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(branch_id) DO UPDATE SET candidate_id=excluded.candidate_id, reconstruction_ref=excluded.reconstruction_ref,
           locked_by=excluded.locked_by, locked_at=excluded.locked_at, references_json=excluded.references_json`,
      )
      .run(
        lock.branchId,
        lock.seriesId,
        lock.candidateId,
        lock.reconstructionRef,
        lock.lockedBy,
        this.now(),
        canonicalJSON(lock.references),
      );
  }

  getLock(branchId: string) {
    const row = this.db.prepare('SELECT * FROM locks WHERE branch_id = ?').get(branchId) as any;
    return row
      ? {
          branchId: row.branch_id,
          seriesId: row.series_id,
          candidateId: row.candidate_id,
          forReconstructionRef: row.reconstruction_ref,
          lockedBy: row.locked_by,
          lockedAt: row.locked_at,
          references: JSON.parse(row.references_json),
        }
      : undefined;
  }

  // ---------- 原子导入：失败回滚，绝不留半份记录 ----------
  beginImport(): string {
    const id = `imp-${randomUUID()}`;
    this.db
      .prepare('INSERT INTO imports (import_id, started_at, status, item_count) VALUES (?,?,?,?)')
      .run(id, this.now(), 'open', 0);
    this.db.exec('SAVEPOINT import_' + id.replace(/-/g, ''));
    return id;
  }

  commitImport(id: string, itemCount: number): void {
    this.db
      .prepare('UPDATE imports SET status=?, committed_at=?, item_count=? WHERE import_id=?')
      .run('committed', this.now(), itemCount, id);
    this.db.exec('RELEASE SAVEPOINT import_' + id.replace(/-/g, ''));
  }

  rollbackImport(id: string): void {
    this.db.exec('ROLLBACK TO SAVEPOINT import_' + id.replace(/-/g, ''));
    this.db.exec('RELEASE SAVEPOINT import_' + id.replace(/-/g, ''));
    this.db.prepare('DELETE FROM imports WHERE import_id=?').run(id);
  }

  // ---------- 损坏检测：缺少引用必须报损坏，不能退回最新版 ----------
  assertReferencesExist(state: ReplayState, entityId: string, version: number): EntityVersionRef[] {
    const key = `${entityId}@${version}`;
    const refs = state.refs[key] ?? [];
    const missing: { entityId: string; reason: string }[] = [];
    for (const r of refs) {
      const hv = state.history[r.entityId]?.[r.version];
      if (!hv) {
        missing.push({ entityId: r.entityId, reason: `missing-version-${r.version}` });
        continue;
      }
      const actualDigest = state.digests[`${r.entityId}@${r.version}`] ?? digestOf(hv);
      if (r.digest && actualDigest !== r.digest) {
        missing.push({ entityId: r.entityId, reason: `digest-mismatch@v${r.version}` });
      }
    }
    if (missing.length) throw new CorruptionError(entityId, missing);
    return refs;
  }
}

function rowToEvent(r: any): EventRecord {
  return {
    id: r.event_id,
    seriesId: r.series_id,
    branchId: r.branch_id,
    ordinal: r.ordinal,
    type: r.type,
    parentIds: JSON.parse(r.parent_ids),
    payload: JSON.parse(r.payload_json),
    rationale: r.rationale_json ? JSON.parse(r.rationale_json) : undefined,
    createdAt: r.created_at,
    contentDigest: r.content_digest,
  };
}
