// 事件溯源存储：来源与解释分开保存；导入失败只回滚本次变更；
// 重新解释新建分支，旧分支、人工裁定和原始字节都可继续读取。
import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { hashContent } from '../shared/units.js';
import { RULESET_VERSION } from '../shared/types.js';
import type { SourcePayload, Diagnostic } from '../shared/types.js';

export class ConflictError extends Error {
  constructor(public currentHead: number, public serverEvents: any[], public yourPayload: any) {
    super('VERSION_CONFLICT');
  }
}
export class CorruptionError extends Error {
  constructor(message: string) { super(message); this.name = 'CorruptionError'; }
}

export interface Dep { type: 'source' | 'ruleset'; id: string; version: number | string }

// ---------- 事件 ----------
export function appendEvent(db: DB, branchId: string | null, type: string, payload: any, actor: string): number {
  const r = db.prepare(
    'INSERT INTO events (event_id, branch_id, type, payload, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), branchId, type, JSON.stringify(payload), actor, new Date().toISOString());
  const seq = Number(r.lastInsertRowid);
  if (branchId) {
    db.prepare('UPDATE branches SET head_seq = ? WHERE branch_id = ?').run(seq, branchId);
  }
  return seq;
}

export function createBranch(db: DB, name: string, baseSeq: number): string {
  const branchId = `br-${randomUUID().slice(0, 8)}`;
  db.prepare('INSERT INTO branches (branch_id, name, base_seq, head_seq) VALUES (?, ?, ?, ?)').run(branchId, name, baseSeq, baseSeq);
  appendEvent(db, branchId, 'branch.created', { name, baseSeq }, 'system');
  return branchId;
}

export function getBranch(db: DB, branchId: string): any {
  const b = db.prepare('SELECT * FROM branches WHERE branch_id = ?').get(branchId);
  if (!b) throw new Error(`branch not found: ${branchId}`);
  return b;
}

// ---------- 来源（不可变内容 + 版本） ----------
export function putBlob(db: DB, mediaType: string, content: string): string {
  const hash = hashContent(content);
  db.prepare('INSERT OR IGNORE INTO blobs (hash, media_type, content) VALUES (?, ?, ?)').run(hash, mediaType, content);
  return hash;
}

/** 导入一个来源版本。共享的原始片段按内容哈希只存一份；失败只回滚本次变更 */
export function importSource(db: DB, sourceId: string, kind: string, payload: SourcePayload, actor: string, branchId: string | null = null): { version: number; blobHash: string } {
  db.exec('BEGIN');
  try {
    const blobHash = putBlob(db, 'application/json', JSON.stringify(payload));
    const row = db.prepare('SELECT MAX(version) AS v FROM sources WHERE source_id = ?').get(sourceId) as any;
    const version = (row?.v ?? 0) + 1;
    const seq = appendEvent(db, branchId, 'source.versioned', { sourceId, kind, version, blobHash }, actor);
    db.prepare('INSERT INTO sources (source_id, version, kind, blob_hash, created_seq) VALUES (?, ?, ?, ?, ?)')
      .run(sourceId, version, kind, blobHash, seq);
    db.exec('COMMIT');
    return { version, blobHash };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSource(db: DB, sourceId: string, version?: number): { version: number; kind: string; payload: any; blobHash: string } {
  const row = version !== undefined
    ? db.prepare('SELECT * FROM sources WHERE source_id = ? AND version = ?').get(sourceId, version) as any
    : db.prepare('SELECT * FROM sources WHERE source_id = ? ORDER BY version DESC LIMIT 1').get(sourceId) as any;
  if (!row) throw new CorruptionError(`CORRUPT: 缺少引用 source ${sourceId}@${version ?? 'latest'}`);
  const blob = db.prepare('SELECT content FROM blobs WHERE hash = ?').get(row.blob_hash) as any;
  if (!blob) throw new CorruptionError(`CORRUPT: 缺少 blob ${row.blob_hash} (source ${sourceId}@${row.version})`);
  return { version: row.version, kind: row.kind, payload: JSON.parse(blob.content), blobHash: row.blob_hash };
}

// ---------- 解释实体（派生层，依赖精确版本） ----------
export function putEntity(
  db: DB, branchId: string, entityId: string, kind: string,
  payload: any, deps: Dep[], diagnostics: Diagnostic[], actor: string,
): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM entities WHERE entity_id = ? AND branch_id = ?').get(entityId, branchId) as any;
  const version = (row?.v ?? 0) + 1;
  const digest = hashContent(JSON.stringify(payload));
  const seq = appendEvent(db, branchId, 'entity.created', { entityId, kind, version, digest, deps, ruleset: RULESET_VERSION }, actor);
  db.prepare(
    'INSERT INTO entities (entity_id, version, branch_id, kind, payload, deps, digest, status, created_seq, ruleset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(entityId, version, branchId, kind, JSON.stringify(payload), JSON.stringify(deps), digest, 'valid', seq, RULESET_VERSION);
  for (const d of diagnostics) {
    db.prepare('INSERT INTO diagnostics (diag_id, entity_id, entity_version, branch_id, code, message, path, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), entityId, version, branchId, d.code, d.message, d.path ?? null, seq);
    appendEvent(db, branchId, 'diagnostic.raised', { entityId, entityVersion: version, ...d }, actor);
  }
  return version;
}

/** 查询实体：返回它引用的版本号与内容摘要；缺少引用必须报损坏，不能退回当前最新版 */
export function getEntity(db: DB, entityId: string, branchId: string, version?: number): any {
  const row = version !== undefined
    ? db.prepare('SELECT * FROM entities WHERE entity_id = ? AND branch_id = ? AND version = ?').get(entityId, branchId, version) as any
    : db.prepare('SELECT * FROM entities WHERE entity_id = ? AND branch_id = ? ORDER BY version DESC LIMIT 1').get(entityId, branchId) as any;
  if (!row) throw new CorruptionError(`CORRUPT: 实体不存在 ${entityId} (${branchId})`);
  const deps = JSON.parse(row.deps) as Dep[];
  const resolved = deps.map((d) => {
    if (d.type === 'source') {
      const s = getSource(db, d.id, d.version as number); // 缺失 → CorruptionError
      return { ...d, digest: hashContent(JSON.stringify(s.payload)) };
    }
    return { ...d, digest: String(d.version) };
  });
  const diagnostics = db.prepare('SELECT code, message, path FROM diagnostics WHERE entity_id = ? AND entity_version = ? AND branch_id = ?')
    .all(entityId, row.version, branchId);
  return {
    entityId, version: row.version, branchId, kind: row.kind,
    payload: JSON.parse(row.payload), deps: resolved, digest: row.digest,
    status: row.status, ruleset: row.ruleset, diagnostics,
  };
}

// ---------- 失效范围：参数或参考版本变化后按依赖关系计算，不全局替换 ----------
export function computeInvalidation(db: DB, branchId: string, changed: { sourceId?: string; rulesetChanged?: boolean }, actor: string): string[] {
  const affected: string[] = [];
  const rows = db.prepare("SELECT entity_id, version, deps FROM entities WHERE branch_id = ? AND status = 'valid'").all(branchId) as any[];
  for (const r of rows) {
    const deps = JSON.parse(r.deps) as Dep[];
    const hit = deps.some((d) =>
      (d.type === 'source' && changed.sourceId !== undefined && d.id === changed.sourceId) ||
      (d.type === 'ruleset' && changed.rulesetChanged));
    if (hit) {
      db.prepare('UPDATE entities SET status = ? WHERE entity_id = ? AND branch_id = ? AND version = ?')
        .run('stale', r.entity_id, branchId, r.version);
      affected.push(r.entity_id);
    }
  }
  appendEvent(db, branchId, 'invalidation.computed', { changed, affectedEntities: affected }, actor);
  return affected;
}

// ---------- 裁定（可撤销；并发保存 → 版本冲突及双方差异） ----------
function checkHead(db: DB, branchId: string, expectedHead: number | undefined, yourPayload: any) {
  if (expectedHead === undefined) return;
  const b = getBranch(db, branchId);
  if (b.head_seq !== expectedHead) {
    const serverEvents = db.prepare('SELECT seq, type, payload, actor FROM events WHERE branch_id = ? AND seq > ? ORDER BY seq').all(branchId, expectedHead)
      .map((e: any) => ({ ...e, payload: JSON.parse(e.payload) }));
    throw new ConflictError(b.head_seq, serverEvents, yourPayload);
  }
}

export function adjudicate(db: DB, branchId: string, args: { candidateId: string; candidateVersion: number; decision: 'accept' | 'reject'; reason: string; actor: string; expectedHead?: number }): number {
  checkHead(db, branchId, args.expectedHead, { candidateId: args.candidateId, decision: args.decision, reason: args.reason });
  return appendEvent(db, branchId, 'adjudication.recorded', {
    adjudicationId: randomUUID(), candidateId: args.candidateId, candidateVersion: args.candidateVersion,
    decision: args.decision, reason: args.reason,
  }, args.actor);
}

export function revokeAdjudication(db: DB, branchId: string, adjudicationEventSeq: number, actor: string): number {
  const ev = db.prepare('SELECT * FROM events WHERE seq = ? AND type = ?').get(adjudicationEventSeq, 'adjudication.recorded') as any;
  if (!ev) throw new Error(`adjudication event not found: ${adjudicationEventSeq}`);
  return appendEvent(db, branchId, 'adjudication.revoked', { revokedSeq: adjudicationEventSeq }, actor);
}

/** 锁定一版配准供重建引用；并发冻结 → 后提交者看到版本冲突及双方差异 */
export function lockAlignment(db: DB, branchId: string, args: { candidateId: string; candidateVersion: number; actor: string; expectedHead?: number }): string {
  checkHead(db, branchId, args.expectedHead, { op: 'lock', candidateId: args.candidateId, candidateVersion: args.candidateVersion });
  const lockId = `lock-${randomUUID().slice(0, 8)}`;
  const seq = appendEvent(db, branchId, 'alignment.locked', { lockId, candidateId: args.candidateId, candidateVersion: args.candidateVersion }, args.actor);
  db.prepare('INSERT INTO locks (lock_id, branch_id, candidate_id, entity_version, created_seq) VALUES (?, ?, ?, ?, ?)')
    .run(lockId, branchId, args.candidateId, args.candidateVersion, seq);
  return lockId;
}

// ---------- 状态读取（可回到任意旧事件：恢复当时的依赖版本和可见结论） ----------
export function getState(db: DB, opts: { atSeq?: number } = {}): any {
  const atSeq = opts.atSeq ?? Number.MAX_SAFE_INTEGER;
  const branches = db.prepare('SELECT * FROM branches ORDER BY created_seq').all() as any[];
  const events = (db.prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq').all(atSeq) as any[])
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
  const revoked = new Set(events.filter((e) => e.type === 'adjudication.revoked').map((e) => e.payload.revokedSeq));
  const adjudications = events.filter((e) => e.type === 'adjudication.recorded' && !revoked.has(e.seq));
  const entities = (db.prepare('SELECT * FROM entities WHERE created_seq <= ? ORDER BY entity_id, version').all(atSeq) as any[])
    .map((r) => ({ ...r, payload: JSON.parse(r.payload), deps: JSON.parse(r.deps) }));
  const diagnostics = (db.prepare('SELECT * FROM diagnostics WHERE created_seq <= ? ORDER BY created_seq').all(atSeq) as any[]);
  const locks = (db.prepare('SELECT * FROM locks WHERE created_seq <= ? ORDER BY created_seq').all(atSeq) as any[]);
  const sources = (db.prepare('SELECT source_id, version, kind, blob_hash, created_seq FROM sources WHERE created_seq <= ? ORDER BY source_id, version').all(atSeq) as any[]);
  return { branches, events, adjudications, entities, diagnostics, locks, sources, headSeq: events.length ? events[events.length - 1].seq : 0 };
}

// ---------- 导出 / 导入：身份、顺序和来源关系保持 ----------
export function exportArchive(db: DB): any {
  const tables = ['blobs', 'sources', 'events', 'branches', 'entities', 'diagnostics', 'locks', 'schema_migrations'];
  const out: any = { format: 'tilt-align-review/archive@1', exportedAt: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    const order = t === 'events' ? 'ORDER BY seq' : t === 'sources' ? 'ORDER BY source_id, version' : '';
    out.tables[t] = db.prepare(`SELECT * FROM ${t} ${order}`).all();
  }
  return out;
}

export function importArchive(db: DB, archive: any): void {
  if (archive.format !== 'tilt-align-review/archive@1') throw new Error('unknown archive format');
  db.exec('BEGIN');
  try {
    for (const [table, rows] of Object.entries(archive.tables) as [string, any[]][]) {
      for (const row of rows) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
          .run(...cols.map((c) => row[c]));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
