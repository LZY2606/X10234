import type { DatabaseSync } from 'node:sqlite';
import { sha256Hex, canonicalJson, contentId, actionId } from '../domain/hash';
import type {
  EntityBody,
  EntityKind,
  EntityRecord,
  VersionRef
} from '../domain/types';
import type { EventType, EventPayloads, RecordedEvent } from '../domain/events';
import { CorruptionError } from '../domain/archive';
import { openDatabase } from './db';

export interface StoredContent {
  contentId: string;
  kind: EntityKind;
  canonicalJson: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
}

export interface BranchInfo {
  branchId: string;
  parentBranchId: string | null;
  headBranchSeq: number;
  createdAt: string;
}

export class OptimisticLockError extends Error {
  constructor(
    public branchId: string,
    public expectedSeq: number,
    public actualSeq: number
  ) {
    super(
      `版本冲突：分支 ${branchId} 已从 #${expectedSeq} 推进到 #${actualSeq}`
    );
    this.name = 'OptimisticLockError';
  }
}

export interface AppendOptions {
  expectedHeadSeq?: number;
  author?: string;
  now?: string;
}

export interface AppendResult {
  event: RecordedEvent;
  newHeadSeq: number;
}

export class TiltStore {
  readonly db: DatabaseSync;

  constructor(path: string | DatabaseSync = 'data/tilt-room.sqlite') {
    this.db =
      typeof path === 'string' ? (openDatabase(path) as DatabaseSync) : path;
  }

  close(): void {
    this.db.close();
  }

  begin(): void {
    this.db.exec('BEGIN IMMEDIATE');
  }
  commit(): void {
    this.db.exec('COMMIT');
  }
  rollback(): void {
    this.db.exec('ROLLBACK');
  }

  transaction<T>(fn: () => T): T {
    this.begin();
    try {
      const result = fn();
      this.commit();
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  createBranch(branchId: string, parentBranchId?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO branches (branch_id, parent_branch_id, head_branch_seq, created_at)
         VALUES (?, ?, 0, ?)`
      )
      .run(branchId, parentBranchId ?? null, now);
  }

  branchExists(branchId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM branches WHERE branch_id = ?')
      .get(branchId);
    return Boolean(row);
  }

  getBranch(branchId: string): BranchInfo {
    const row = this.db
      .prepare(
        `SELECT branch_id, parent_branch_id, head_branch_seq, created_at
         FROM branches WHERE branch_id = ?`
      )
      .get(branchId) as
      | {
          branch_id: string;
          parent_branch_id: string | null;
          head_branch_seq: number;
          created_at: string;
        }
      | undefined;
    if (!row) throw new Error(`未知分支 ${branchId}`);
    return {
      branchId: row.branch_id,
      parentBranchId: row.parent_branch_id,
      headBranchSeq: row.head_branch_seq,
      createdAt: row.created_at
    };
  }

  listBranches(): BranchInfo[] {
    const rows = this.db
      .prepare(
        `SELECT branch_id, parent_branch_id, head_branch_seq, created_at
         FROM branches ORDER BY created_at ASC`
      )
      .all() as Array<{
      branch_id: string;
      parent_branch_id: string | null;
      head_branch_seq: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      branchId: row.branch_id,
      parentBranchId: row.parent_branch_id,
      headBranchSeq: row.head_branch_seq,
      createdAt: row.created_at
    }));
  }

  /**
   * 追加事件。期望头序号用于并发冻结：
   * 两个窗口同时保存时，后提交者 expectedHeadSeq 落后 -> 冲突并返回双方差异。
   */
  append<E extends EventType>(
    branchId: string,
    type: E,
    payload: EventPayloads[E],
    options: AppendOptions = {}
  ): AppendResult {
    return this.transaction(() => {
      const branch = this.db
        .prepare(
          'SELECT head_branch_seq FROM branches WHERE branch_id = ?'
        )
        .get(branchId) as { head_branch_seq: number } | undefined;
      if (!branch) throw new Error(`未知分支 ${branchId}`);
      if (
        options.expectedHeadSeq !== undefined &&
        options.expectedHeadSeq !== branch.head_branch_seq
      ) {
        throw new OptimisticLockError(
          branchId,
          options.expectedHeadSeq,
          branch.head_branch_seq
        );
      }
      const nextBranchSeq = branch.head_branch_seq + 1;
      const now = options.now ?? new Date().toISOString();
      const eventId = actionId('evt');
      const payloadJson = JSON.stringify(payload);
      const info = this.db
        .prepare(
          `INSERT INTO events
           (event_id, branch_id, branch_seq, type, payload_json, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          eventId,
          branchId,
          nextBranchSeq,
          type,
          payloadJson,
          options.author ?? 'reviewer',
          now
        );
      this.db
        .prepare('UPDATE branches SET head_branch_seq = ? WHERE branch_id = ?')
        .run(nextBranchSeq, branchId);
      const event: RecordedEvent = {
        eventId,
        branchId,
        seq: Number(info.lastInsertRowid),
        type,
        payload,
        createdAt: now,
        author: options.author ?? 'reviewer'
      };
      return { event, newHeadSeq: nextBranchSeq };
    });
  }

  events(branchId: string): RecordedEvent[] {
    return this.readEvents(
      this.db
        .prepare(
          'SELECT * FROM events WHERE branch_id = ? ORDER BY branch_seq ASC'
        )
        .all(branchId)
    );
  }

  eventsUntil(branchId: string, branchSeq: number): RecordedEvent[] {
    return this.readEvents(
      this.db
        .prepare(
          'SELECT * FROM events WHERE branch_id = ? AND branch_seq <= ? ORDER BY branch_seq ASC'
        )
        .all(branchId, branchSeq)
    );
  }

  private readEvents(rows: unknown[]): RecordedEvent[] {
    return (rows as Array<{
      event_id: string;
      branch_id: string;
      seq: number;
      branch_seq: number;
      type: EventType;
      payload_json: string;
      author: string;
      created_at: string;
    }>).map((row) => ({
      eventId: row.event_id,
      branchId: row.branch_id,
      seq: row.seq,
      type: row.type,
      payload: JSON.parse(row.payload_json) as never,
      author: row.author,
      createdAt: row.created_at
    }));
  }

  /** 内容去重：同内容只存一份；返回内容身份。 */
  putContent(kind: EntityKind, body: EntityBody): StoredContent {
    const json = canonicalJson(body);
    const id = contentId(kind, body);
    const hash = sha256Hex(json);
    const existing = this.db
      .prepare('SELECT content_id FROM contents WHERE content_id = ?')
      .get(id);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO contents
           (content_id, kind, canonical_json, sha256, byte_length, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, kind, json, hash, Buffer.byteLength(json, 'utf8'), new Date().toISOString());
    }
    return {
      contentId: id,
      kind,
      canonicalJson: json,
      sha256: hash,
      byteLength: Buffer.byteLength(json, 'utf8'),
      createdAt: new Date().toISOString()
    };
  }

  getContent(contentIdValue: string): StoredContent | null {
    const row = this.db
      .prepare(
        'SELECT content_id, kind, canonical_json, sha256, byte_length, created_at FROM contents WHERE content_id = ?'
      )
      .get(contentIdValue) as
      | {
          content_id: string;
          kind: EntityKind;
          canonical_json: string;
          sha256: string;
          byte_length: number;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      contentId: row.content_id,
      kind: row.kind,
      canonicalJson: row.canonical_json,
      sha256: row.sha256,
      byteLength: row.byte_length,
      createdAt: row.created_at
    };
  }

  putBlob(contentIdValue: string, bytes: Buffer, contentType: string): string {
    const hash = sha256Hex(bytes.toString('binary'));
    this.db
      .prepare(
        `INSERT OR IGNORE INTO blobs (content_id, bytes, sha256, byte_length, content_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        contentIdValue,
        bytes,
        hash,
        bytes.length,
        contentType,
        new Date().toISOString()
      );
    return hash;
  }

  getBlob(contentIdValue: string): { bytes: Buffer; contentType: string } | null {
    const row = this.db
      .prepare('SELECT bytes, content_type, sha256 FROM blobs WHERE content_id = ?')
      .get(contentIdValue) as
      | { bytes: Uint8Array; content_type: string; sha256: string }
      | undefined;
    if (!row) return null;
    return { bytes: Buffer.from(row.bytes), contentType: row.content_type };
  }

  listBlobIds(): string[] {
    const rows = this.db.prepare('SELECT content_id FROM blobs').all() as Array<{
      content_id: string;
    }>;
    return rows.map((r) => r.content_id);
  }

  addRef(
    fromContentId: string,
    fromEntityId: string,
    ref: VersionRef,
    seq: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO refs
         (from_content_id, from_entity_id, ref_entity_id, ref_version, ref_content_id, seq)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        fromContentId,
        fromEntityId,
        ref.entityId,
        ref.version,
        ref.contentId,
        seq
      );
  }

  /**
   * 依赖失效范围：所有（在事件流任意分支中）直接或传递引用了变更内容的实体。
   * 参数/参考版本变化后，只标记依赖范围内候选，绝不全局替换旧结论。
   */
  dependentsOf(contentIds: string[]): string[] {
    const affected = new Set<string>();
    const queue = [...contentIds];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const rows = this.db
        .prepare(
          `SELECT DISTINCT from_content_id FROM refs WHERE ref_content_id = ?`
        )
        .all(current) as Array<{ from_content_id: string }>;
      for (const row of rows) {
        if (!affected.has(row.from_content_id)) {
          affected.add(row.from_content_id);
          queue.push(row.from_content_id);
        }
      }
    }
    return [...affected];
  }

  // ---- 重建引用钉版 ----

  putLock(
    handle: string,
    ref: VersionRef,
    lockedBy: string
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reconstruction_locks
         (handle, candidate_content_id, candidate_entity_id, candidate_version, locked_at, locked_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        handle,
        ref.contentId,
        ref.entityId,
        ref.version,
        new Date().toISOString(),
        lockedBy
      );
  }

  getLock(handle: string): VersionRef | null {
    const row = this.db
      .prepare(
        'SELECT candidate_content_id, candidate_entity_id, candidate_version FROM reconstruction_locks WHERE handle = ?'
      )
      .get(handle) as
      | {
          candidate_content_id: string;
          candidate_entity_id: string;
          candidate_version: number;
        }
      | undefined;
    if (!row) return null;
    return {
      entityId: row.candidate_entity_id,
      kind: 'registration_candidate',
      version: row.candidate_version,
      contentId: row.candidate_content_id
    };
  }

  listLocks(): Array<{ handle: string; ref: VersionRef }> {
    const rows = this.db
      .prepare(
        'SELECT handle, candidate_content_id, candidate_entity_id, candidate_version, locked_at FROM reconstruction_locks ORDER BY locked_at ASC'
      )
      .all() as Array<{
      handle: string;
      candidate_content_id: string;
      candidate_entity_id: string;
      candidate_version: number;
    }>;
    return rows.map((row) => ({
      handle: row.handle,
      ref: {
        entityId: row.candidate_entity_id,
        kind: 'registration_candidate' as const,
        version: row.candidate_version,
        contentId: row.candidate_content_id
      }
    }));
  }

  markCaseInstalled(caseId: string, branchId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO case_installations (case_id, branch_id, installed_at) VALUES (?, ?, ?)'
      )
      .run(caseId, branchId, new Date().toISOString());
  }

  isCaseInstalled(caseId: string, branchId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM case_installations WHERE case_id = ? AND branch_id = ?'
        )
        .get(caseId, branchId)
    );
  }
}
