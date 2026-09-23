import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './schema';
import {
  VersionedEntity, EntityKind, AlignmentCandidate, Adjudication,
  LockedAlignment, DecisionKind, SourceBody
} from '../domain/types';

export class CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptionError';
  }
}

export class ConflictError extends Error {
  constructor(message: string, public baseRevision: number, public currentRevision: number) {
    super(message);
    this.name = 'ConflictError';
  }
}

export interface EventRow {
  eventId: string; seq: number; branchId: string; revision: number;
  eventType: string; payload: unknown; rationale: string; createdAt: string;
}

export interface VersionedRef { kind: EntityKind; entityId: string; version: number; contentDigest: string; }

export interface QueryResult<T> {
  value: T;
  refs: VersionedRef[];
}

export interface Archive {
  format: 'tilt-framing-chamber/archive';
  formatVersion: 1;
  exportedAt: string;
  blobs: { digest: string; mediaType: string; bytesB64: string }[];
  branches: { branchId: string; name: string; parentBranchId: string | null; createdAt: string }[];
  events: Omit<EventRow, 'seq'>[];
  materialized: Record<string, unknown>[];
  dependencies: Record<string, unknown>[];
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export class Store {
  db: DatabaseSync;

  constructor(pathOrDb: string | DatabaseSync) {
    this.db = typeof pathOrDb === 'string' ? openDatabase(pathOrDb) : pathOrDb;
    this.db.exec(SCHEMA);
    const v = this.db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string } | undefined;
    if (!v) this.db.prepare("INSERT INTO meta(key,value) VALUES('schemaVersion','1')").run();
  }

  close() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* ignore */ } this.db.close(); }

  // ---------- 内容寻址 blob ----------
  putBlob(bytes: Uint8Array, mediaType: string): string {
    const digest = 'sha256:' + sha256Hex(bytes);
    this.db.prepare(
      'INSERT OR IGNORE INTO blob(digest,bytes,mediaType,byteLength) VALUES(?,?,?,?)'
    ).run(digest, bytes as unknown as Uint8Array, mediaType, bytes.byteLength);
    return digest;
  }

  getBlob(digest: string): Uint8Array {
    const row = this.db.prepare('SELECT bytes FROM blob WHERE digest=?').get(digest) as { bytes: Uint8Array } | undefined;
    if (!row) throw new CorruptionError(`损坏：缺少被引用的原始字节 ${digest}`);
    return row.bytes;
  }

  // ---------- 分支 ----------
  createBranch(branchId: string, name: string, parentBranchId: string | null = null, createdAt = nowIso()) {
    const parent = parentBranchId;
    if (parent) {
      const r = this.db.prepare('SELECT headRevision FROM branch WHERE branchId=?').get(parent) as { headRevision: number } | undefined;
      if (!r) throw new CorruptionError(`损坏：父分支不存在 ${parent}`);
    }
    this.db.prepare(
      'INSERT INTO branch(branchId,name,parentBranchId,headRevision,createdAt) VALUES(?,?,?,0,?)'
    ).run(branchId, name, parent, createdAt);
  }

  listBranches() {
    return this.db.prepare('SELECT branchId,name,parentBranchId,headRevision,createdAt FROM branch ORDER BY rowid').all() as
      { branchId: string; name: string; parentBranchId: string | null; headRevision: number; createdAt: string }[];
  }

  private branch(branchId: string) {
    const r = this.db.prepare('SELECT * FROM branch WHERE branchId=?').get(branchId) as
      { branchId: string; headRevision: number } | undefined;
    if (!r) throw new CorruptionError(`损坏：分支不存在 ${branchId}`);
    return r;
  }

  // ---------- 事务：导入失败整体回滚，不允许半份记录 ----------
  transaction<T>(fn: () => T): T {
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- 只追加事件 ----------
  private appendEvent(branchId: string, eventType: string, payload: unknown, rationale: string): EventRow {
    const b = this.branch(branchId);
    const revision = b.headRevision + 1;
    const eventId = deterministicEventId(branchId, revision, eventType, payload);
    const createdAt = nowIso();
    this.db.prepare(
      `INSERT INTO event(eventId,branchId,revision,eventType,payload,rationale,createdAt)
       VALUES(?,?,?,?,?,?,?)`
    ).run(eventId, branchId, revision, eventType, JSON.stringify(payload), rationale, createdAt);
    this.db.prepare('UPDATE branch SET headRevision=? WHERE branchId=?').run(revision, branchId);
    return { eventId, seq: -1, branchId, revision, eventType, payload, rationale, createdAt };
  }

  events(branchId: string): EventRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM event WHERE branchId=? ORDER BY revision ASC'
    ).all(branchId) as (Omit<EventRow, 'payload'> & { payload: string })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  // 回到任意旧事件：读取当时的依赖版本与可见结论（历史快照，不用最新结果覆盖）
  stateAt(branchId: string, revision: number) {
    this.branch(branchId);
    return replay(this.db, branchId, revision);
  }

  // ---------- 实体版本 ----------
  putEntityVersion(opts: {
    branchId: string; ev: Omit<VersionedEntity, 'createdAt' | 'contentDigest'> & { createdAt?: string };
    rationale: string;
  }): { event: EventRow; digest: string } {
    const { branchId, ev, rationale } = opts;
    const bodyJson = JSON.stringify(ev.body);
    const digest = 'sha256:' + sha256Hex(new TextEncoder().encode(ev.entityId + '|' + ev.version + '|' + ev.sourceBlob + '|' + bodyJson));
    const event = this.appendEvent(branchId, 'source.versioned',
      { entityId: ev.entityId, kind: ev.kind, version: ev.version, seriesId: ev.seriesId,
        sourceBlob: ev.sourceBlob, contentDigest: digest, ordinal: null }, rationale);
    this.db.prepare(
      `INSERT INTO entity_version(entityId,version,branchId,kind,seriesId,sourceBlob,body,contentDigest,eventId,ordinal)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(ev.entityId, ev.version, branchId, ev.kind, ev.seriesId, ev.sourceBlob, bodyJson, digest, event.eventId,
      this.nextOrdinal(branchId, ev.kind));
    return { event, digest };
  }

  private nextOrdinal(branchId: string, kind: string): number {
    const r = this.db.prepare(
      'SELECT COALESCE(MAX(ordinal),-1)+1 AS n FROM entity_version WHERE branchId=? AND kind=?'
    ).get(branchId, kind) as { n: number };
    return r.n;
  }

  /** 查询实体：必须显式给版本；版本缺失报损坏，不回退最新版 */
  getEntityVersioned(branchId: string, entityId: string, version: number): QueryResult<VersionedEntity> {
    const row = this.db.prepare(
      'SELECT * FROM entity_version WHERE branchId=? AND entityId=? AND version=?'
    ).get(branchId, entityId, version) as
      { entityId: string; version: number; branchId: string; kind: EntityKind; seriesId: string;
        sourceBlob: string; body: string; contentDigest: string; eventId: string; ordinal: number } | undefined;
    if (!row) throw new CorruptionError(`损坏：缺少引用 ${entityId}@v${version}（禁止回退最新版）`);
    const entity: VersionedEntity = { ...row, body: JSON.parse(row.body) };
    return { value: entity, refs: [{ kind: row.kind, entityId, version, contentDigest: row.contentDigest }] };
  }

  latestEntityVersion(entityId: string, branchId: string): number {
    const r = this.db.prepare(
      'SELECT MAX(version) AS v FROM entity_version WHERE entityId=? AND branchId=?'
    ).get(entityId, branchId) as { v: number | null };
    if (r.v == null) throw new CorruptionError(`损坏：实体不存在 ${entityId}`);
    return r.v;
  }

  listEntities(branchId: string): VersionedEntity[] {
    const rows = this.db.prepare(
      'SELECT * FROM entity_version WHERE branchId=? ORDER BY ordinal ASC, version ASC'
    ).all(branchId) as ({ body: string } & Omit<VersionedEntity, 'body'>)[];
    return rows.map((r) => ({ ...r, body: JSON.parse(r.body) }));
  }
