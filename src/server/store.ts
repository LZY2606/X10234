/**
 * 版本化事件溯源存储（node:sqlite）。
 *
 *  - 写操作全部在单个事务内；导入失败回滚，不留半份记录。
 *  - 实体按 (id, version) append-only；查询实体必须显式带版本，
 *    缺少引用 -> corruption，绝不退回当前最新版。
 *  - blob 内容寻址（sha256），共享原始片段物理上只存一份。
 *  - 事件 seq 与 world_version 单调递增；裁定保存使用乐观并发版本号。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, currentSchemaVersion } from './schema.js';
import type { EntityEnvelope, EntityKind } from '../domain/types.js';

export interface StoredEvent {
  eventId: string;
  seq: number;
  revisionId: string;
  branchId: string;
  atWorldVersion: number;
  type: string;
  subjectId?: string;
  payload: unknown;
  createdAt: string;
  correlationId?: string;
}

export interface StoreOptions {
  readonly?: boolean;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, opts: StoreOptions = {}) {
    if (path !== ':memory:' && !opts.readonly) {
      const dir = dirname(path);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(path, opts.readonly ? { readOnly: true } : {});
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    if (!opts.readonly) this.migrate();
  }

  migrate(): void {
    const applied = new Set(
      this.db.prepare('SELECT version FROM schema_migrations').all()
        .map(r => (r as { version: number }).version),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      const tx = this.db.prepare(`INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)`);
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.sql);
        tx.run(m.version, m.name, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  schemaVersion(): number {
    const rows = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').all() as { v: number | null }[];
    return rows[0].v ?? 0;
  }

  close(): void { this.db.close(); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  ensureRepository(repoId = 'tilt-assembly-room'): void {
    this.db.prepare(
      `INSERT INTO repositories(repo_id,current_revision,world_version,created_at)
       VALUES(?,?,0,?) ON CONFLICT(repo_id) DO NOTHING`,
    ).run(repoId, 0, new Date().toISOString());
  }

  worldVersion(): number {
    const r = this.db.prepare('SELECT world_version FROM repositories WHERE repo_id=?').get('tilt-assembly-room') as
      | { world_version: number } | undefined;
    return r?.world_version ?? 0;
  }

  bumpWorld(): number {
    this.db.prepare('UPDATE repositories SET world_version=world_version+1 WHERE repo_id=?').run('tilt-assembly-room');
    return this.worldVersion();
  }

  currentRevisionNo(): number {
    const r = this.db.prepare('SELECT current_revision AS v FROM repositories WHERE repo_id=?').get('tilt-assembly-room') as
      | { v: number } | undefined;
    return r?.v ?? 0;
  }

  setCurrentRevision(n: number): void {
    this.db.prepare('UPDATE repositories SET current_revision=? WHERE repo_id=?').run(n, 'tilt-assembly-room');
  }

  // ---------- blobs ----------
  putBlob(bytes: Buffer, mediaType: string): { blobId: string; sha256: string; deduplicated: boolean } {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const blobId = `blob/${sha256}`;
    const existing = this.db.prepare('SELECT blob_id FROM blobs WHERE blob_id=?').get(blobId);
    if (existing) return { blobId, sha256, deduplicated: true };
    this.db.prepare(
      'INSERT INTO blobs(blob_id,sha256,bytes,media_type,byte_length,created_at) VALUES(?,?,?,?,?,?)',
    ).run(blobId, sha256, bytes, mediaType, bytes.length, new Date().toISOString());
    return { blobId, sha256, deduplicated: false };
  }

  getBlob(blobId: string): { bytes: Buffer; sha256: string; mediaType: string } | undefined {
    const r = this.db.prepare('SELECT bytes,sha256,media_type FROM blobs WHERE blob_id=?').get(blobId) as
      | { bytes: Buffer; sha256: string; media_type: string } | undefined;
    return r ? { bytes: Buffer.from(r.bytes as unknown as Uint8Array), sha256: r.sha256, mediaType: r.media_type } : undefined;
  }

  allBlobIds(): string[] {
    return (this.db.prepare('SELECT blob_id FROM blobs').all() as { blob_id: string }[]).map(r => r.blob_id);
  }

  // ---------- revisions / branches ----------
  addRevision(rev: { revisionId: string; revisionNo: number; kind: string; label: string; parentRevisionId?: string }): void {
    this.db.prepare(
      `INSERT INTO revisions(revision_id,repo_id,revision_no,kind,label,parent_revision_id,created_at)
       VALUES(?,?,?,?,?,?,?) ON CONFLICT(revision_id) DO NOTHING`,
    ).run(rev.revisionId, 'tilt-assembly-room', rev.revisionNo, rev.kind, rev.label, rev.parentRevisionId ?? null, new Date().toISOString());
    this.setCurrentRevision(rev.revisionNo);
  }

  listRevisions() {
    return this.db.prepare('SELECT revision_id AS revisionId, revision_no AS revisionNo, kind, label, parent_revision_id AS parentRevisionId, created_at AS createdAt FROM revisions ORDER BY revision_no').all();
  }

  addBranch(b: { branchId: string; revisionId: string; parentBranchId?: string; name: string; note?: string }): void {
    this.db.prepare(
      `INSERT INTO branches(branch_id,revision_id,parent_branch_id,name,note,created_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(branch_id) DO NOTHING`,
    ).run(b.branchId, b.revisionId, b.parentBranchId ?? null, b.name, b.note ?? null, new Date().toISOString());
  }

  listBranches() {
    return this.db.prepare('SELECT branch_id AS branchId, revision_id AS revisionId, parent_branch_id AS parentBranchId, name, note FROM branches ORDER BY rowid').all();
  }

  // ---------- entities (append-only) ----------
  putEntity<T>(e: EntityEnvelope<T>, branchId?: string): void {
    const createdAt = e.createdAt || new Date().toISOString();
    const revisionId =
      e.payload && typeof e.payload === 'object' && 'revisionId' in (e.payload as Record<string, unknown>)
        ? String((e.payload as Record<string, unknown>).revisionId)
        : 'revision/unknown';
    this.db.prepare(
      `INSERT INTO entity_versions(id,kind,version,revision_id,branch_id,content_hash,summary,refs,payload,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id,version) DO NOTHING`,
    ).run(e.id, e.kind, e.version, revisionId, branchId ?? null, e.contentHash, e.summary,
      JSON.stringify(e.refs), JSON.stringify(e.payload), createdAt);
    this.db.prepare(
      `INSERT INTO entity_heads(id,kind,version,branch_id) VALUES(?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET version=excluded.version, kind=excluded.kind, branch_id=excluded.branch_id`,
    ).run(e.id, e.kind, e.version, branchId ?? null);
  }

  getEntityVersion<T = unknown>(id: string, version: number): EntityEnvelope<T> | undefined {
    const r = this.db.prepare('SELECT * FROM entity_versions WHERE id=? AND version=?').get(id, version) as
      | Record<string, string | number> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string, kind: r.kind as EntityKind, version: r.version as number,
      revision: undefined as never,
      contentHash: r.content_hash as string, summary: r.summary as string,
      createdAt: r.created_at as string, refs: JSON.parse(r.refs as string) as string[],
      payload: JSON.parse(r.payload as string) as T,
    } as EntityEnvelope<T>;
  }

  getEntityHeadVersion(id: string): number | undefined {
    const r = this.db.prepare('SELECT version FROM entity_heads WHERE id=?').get(id) as { version: number } | undefined;
    return r?.version;
  }

  getEntityHead<T = unknown>(id: string): EntityEnvelope<T> | undefined {
    const v = this.getEntityHeadVersion(id);
    return v === undefined ? undefined : this.getEntityVersion<T>(id, v);
  }

  listEntityHistory(id: string): EntityEnvelope[] {
    const rows = this.db.prepare('SELECT id,kind,version,content_hash,summary,created_at,refs,payload FROM entity_versions WHERE id=? ORDER BY version').all(id) as
      Record<string, string | number>[];
    return rows.map(r => ({
      id: r.id as string, kind: r.kind as EntityKind, version: r.version as number,
      contentHash: r.content_hash as string, summary: r.summary as string, createdAt: r.created_at as string,
      refs: JSON.parse(r.refs as string), payload: JSON.parse(r.payload as string),
    })) as EntityEnvelope[];
  }

  listEntities(kind?: EntityKind): EntityEnvelope[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM entity_heads h JOIN entity_versions v ON v.id=h.id AND v.version=h.version WHERE h.kind=?').all(kind) as Record<string, string | number>[]
      : this.db.prepare('SELECT v.* FROM entity_heads h JOIN entity_versions v ON v.id=h.id AND v.version=h.version').all() as Record<string, string | number>[];
    return rows.map(r => ({
      id: r.id as string, kind: r.kind as EntityKind, version: r.version as number,
      contentHash: r.content_hash as string, summary: r.summary as string, createdAt: r.created_at as string,
      refs: JSON.parse(r.refs as string), payload: JSON.parse(r.payload as string),
    })) as EntityEnvelope[];
  }

  // ---------- dependencies ----------
  addDependency(fromEntityId: string, toEntityId: string, toVersion: number, revisionId: string): void {
    this.db.prepare(
      `INSERT INTO dependencies(from_entity_id,to_entity_id,to_version,revision_id) VALUES(?,?,?,?)
       ON CONFLICT(from_entity_id,to_entity_id,to_version) DO NOTHING`,
    ).run(fromEntityId, toEntityId, toVersion, revisionId);
  }

  dependenciesOf(id: string): { to: string; version: number }[] {
    return (this.db.prepare('SELECT to_entity_id AS t, to_version AS v FROM dependencies WHERE from_entity_id=?').all(id) as
      { t: string; v: number }[]).map(r => ({ to: r.t, version: r.v }));
  }

  /** 沿依赖边 BFS，计算失效范围（直接 + 传递）。 */
  invalidationScope(changedSource: string): { direct: string[]; transitive: string[]; unaffected: string[] } {
    const parents = (child: string) =>
      (this.db.prepare('SELECT DISTINCT from_entity_id AS f FROM dependencies WHERE to_entity_id=?').all(child) as
        { f: string }[]).map(r => r.f);
    const direct = parents(changedSource);
    const transitive: string[] = [];
    const seen = new Set<string>([changedSource, ...direct]);
    let frontier = direct;
    while (frontier.length) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const p of parents(node)) {
          if (!seen.has(p)) { seen.add(p); next.push(p); transitive.push(p); }
        }
      }
      frontier = next;
    }
    const affected = new Set([...direct, ...transitive]);
    const allEntities = (this.db.prepare('SELECT DISTINCT id FROM entity_heads').all() as { id: string }[]).map(r => r.id);
    return { direct, transitive, unaffected: allEntities.filter(id => !affected.has(id) && id !== changedSource) };
  }

  recordInvalidation(eventId: string, changedSource: string, scope: { direct: string[]; transitive: string[] }): void {
    const ins = this.db.prepare('INSERT INTO invalidations(event_id,changed_source,affected_entity_id,depth) VALUES(?,?,?,?) ON CONFLICT DO NOTHING');
    for (const id of scope.direct) ins.run(eventId, changedSource, id, 'direct');
    for (const id of scope.transitive) ins.run(eventId, changedSource, id, 'transitive');
  }

  invalidationsFor(eventId: string) {
    return this.db.prepare('SELECT changed_source AS changedSource, affected_entity_id AS affectedEntityId, depth FROM invalidations WHERE event_id=?').all(eventId);
  }

  // ---------- events ----------
  appendEvent(e: Omit<StoredEvent, 'seq' | 'atWorldVersion'> & { atWorldVersion?: number }): StoredEvent {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM events').get() as { s: number }).s;
    const wv = e.atWorldVersion ?? this.worldVersion();
    this.db.prepare(
      `INSERT INTO events(event_id,seq,revision_id,branch_id,at_world_version,type,subject_id,payload_json,created_at,correlation_id)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(e.eventId, seq, e.revisionId, e.branchId, wv, e.type, e.subjectId ?? null,
      JSON.stringify(e.payload), e.createdAt, e.correlationId ?? null);
    return { ...e, seq, atWorldVersion: wv } as StoredEvent;
  }

  listEvents(): StoredEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all() as Record<string, string | number | null>[];
    return rows.map(r => ({
      eventId: r.event_id as string, seq: r.seq as number, revisionId: r.revision_id as string,
      branchId: r.branch_id as string, atWorldVersion: r.at_world_version as number,
      type: r.type as string, subjectId: (r.subject_id ?? undefined) as string | undefined,
      payload: JSON.parse(r.payload_json as string), createdAt: r.created_at as string,
      correlationId: (r.correlation_id ?? undefined) as string | undefined,
    }));
  }

  // ---------- adjudications / locks ----------
  insertAdjudication(a: {
    adjudicationId: string; candidateId: string; branchId: string; verdict: string;
    locked: boolean; undone: boolean; expectedWorldVersion: number; actualWorldVersion?: number;
    parentAdjudicationId?: string; correlationId: string; createdAt: string;
  }): void {
    this.db.prepare(
      `INSERT INTO adjudications(adjudication_id,candidate_id,branch_id,verdict,locked,undone,
        expected_world_version,actual_world_version,created_at,parent_adjudication_id,correlation_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(a.adjudicationId, a.candidateId, a.branchId, a.verdict, a.locked ? 1 : 0, a.undone ? 1 : 0,
      a.expectedWorldVersion, a.actualWorldVersion ?? null, a.createdAt, a.parentAdjudicationId ?? null, a.correlationId);
  }

  markUndone(adjudicationId: string): void {
    this.db.prepare('UPDATE adjudications SET undone=1 WHERE adjudication_id=?').run(adjudicationId);
    const row = this.db.prepare('SELECT candidate_id AS c FROM adjudications WHERE adjudication_id=?').get(adjudicationId) as { c: string } | undefined;
    if (row) this.db.prepare('DELETE FROM locks WHERE adjudication_id=?').run(adjudicationId);
  }

  setLock(materialKey: string, adjudicationId: string): void {
    this.db.prepare('INSERT INTO locks(material_key,adjudication_id,locked_at) VALUES(?,?,?) ON CONFLICT(material_key) DO UPDATE SET adjudication_id=excluded.adjudication_id, locked_at=excluded.locked_at')
      .run(materialKey, adjudicationId, new Date().toISOString());
  }

  currentLock(materialKey: string) {
    return this.db.prepare(`SELECT l.*, a.candidate_id AS candidateId, a.undone AS undone
      FROM locks l JOIN adjudications a ON a.adjudication_id=l.adjudication_id
      WHERE material_key=?`).get(materialKey) as Record<string, unknown> | undefined;
  }

  listAdjudications() {
    return this.db.prepare('SELECT * FROM adjudications ORDER BY rowid').all();
  }

  // ---------- integrity ----------
  /**
   * 损坏检测：
   *  - 实体 refs 指向的 (id,version) 必须存在，否则 corrupted；调用方禁止退回最新版
   *  - blob 引用 sha256 必须与字节一致
   */
  verifyIntegrity(): {
    corrupted: boolean;
    missingRefs: { from: string; ref: string; atVersion: number }[];
    danglingBlobs: string[];
    hashMismatches: string[];
  } {
    const missingRefs: { from: string; ref: string; atVersion: number }[] = [];
    const versions = this.db.prepare('SELECT id,version,refs,payload FROM entity_versions').all() as
      { id: string; version: number; refs: string; payload: string }[];
    const have = new Set(versions.map(v => `${v.id}@${v.version}`));
    for (const v of versions) {
      for (const ref of JSON.parse(v.refs) as string[]) {
        if (!have.has(ref)) missingRefs.push({ from: v.id, ref, atVersion: v.version });
      }
    }
    const hashMismatches: string[] = [];
    const blobs = this.db.prepare('SELECT blob_id,sha256,bytes FROM blobs').all() as
      { blob_id: string; sha256: string; bytes: Uint8Array }[];
    const referencedBlobs = new Set<string>();
    for (const v of versions) {
      const p = JSON.parse(v.payload) as { blobId?: string };
      if (p.blobId) referencedBlobs.add(p.blobId);
    }
    const danglingBlobs = blobs.filter(b => !referencedBlobs.has(b.blob_id)).map(b => b.blob_id);
    for (const b of blobs) {
      const actual = createHash('sha256').update(Buffer.from(b.bytes)).digest('hex');
      if (actual !== b.sha256) hashMismatches.push(b.blob_id);
    }
    return { corrupted: missingRefs.length > 0 || hashMismatches.length > 0, missingRefs, danglingBlobs, hashMismatches };
  }

  exportTo(targetPath: string): void {
    this.db.backup(targetPath);
  }
}

export function contentHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
