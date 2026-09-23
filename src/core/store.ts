import type { Database } from 'sql.js';
import { openDatabase, migrate, currentVersion, CURRENT_SCHEMA_VERSION, queryRows, queryOne } from './db';
import { ensureBytes, getContent, putContent, nextVersion, type ContentRecord } from './content';
import { stableHash } from '../util/hash';
import { BRANCH_MAIN, makeStableId, eventId, lockRef, prefixFor } from './ids';
import { CorruptArchiveError, type DomainEvent, type EntityEnvelope, type EventType, type ScenarioCode } from './domain';
import type { RATIONALE } from './domain';

export interface RefSpec { contentId: string; role: string }
export interface InvalidatesScope { kinds: string[]; branches: string[]; reason: string }

export interface AppendEventArgs {
  branch: string;
  type: EventType;
  scenario?: ScenarioCode;
  rationaleCode?: keyof typeof RATIONALE;
  author: string;
  payload: unknown;
  refs?: RefSpec[];
  invalidatesScope?: InvalidatesScope;
  parentEventId?: string | null;
  ts?: string;
  /** 乐观并发：调用方基于的分支头 eventId。 */
  expectedParentEventId?: string | null;
}

export class VersionConflictError extends Error {
  constructor(public readonly serverParent: string | null, public readonly clientParent: string | null) {
    super('版本冲突：分支在你编辑期间已被另一窗口推进');
    this.name = 'VersionConflictError';
  }
}

export class Store {
  db: Database;
  schemaVersion: number;
  private seqCache = new Map<string, number>();

  private constructor(db: Database) {
    this.db = db;
    this.schemaVersion = currentVersion(db);
  }

  static async create(): Promise<Store> {
    const db = await openDatabase();
    migrate(db);
    const store = new Store(db);
    store.initBranches();
    return store;
  }

  static async open(serialized: Uint8Array): Promise<Store> {
    const db = await openDatabase(serialized);
    migrate(db);
    const store = new Store(db);
    store.initBranches();
    store.verifyIntegrity();
    return store;
  }

  serialize(): Uint8Array {
    return this.db.export();
  }

  private initBranches() {
    const exists = queryOne<{ branch: string }>(this.db, 'SELECT branch FROM branches WHERE branch=?', [BRANCH_MAIN]);
    if (!exists) {
      this.db.run('INSERT INTO branches(branch,parent_branch,fork_event,label,created_seq,archived) VALUES (?,?,?,?,?,0)',
        [BRANCH_MAIN, null, null, '主线', 0]);
    }
  }

  // ---------- 分支头 / 序列号 ----------

  headEvent(branch: string): DomainEvent | null {
    const row = queryOne<{ event_id: string }>(
      this.db,
      'SELECT event_id FROM events WHERE branch=? ORDER BY seq DESC LIMIT 1',
      [branch]
    );
    return row ? this.getEvent(row.event_id) : null;
  }

  private nextSeq(branch: string): number {
    const cached = this.seqCache.get(branch);
    let n: number;
    if (cached !== undefined) {
      n = cached + 1;
    } else {
      const row = queryOne<{ n: number }>(this.db, 'SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE branch=?', [branch]);
      n = (row?.n ?? 0) + 1;
    }
    this.seqCache.set(branch, n);
    return n;
  }

  // ---------- 事件 ----------

  getEvent(eventIdValue: string): DomainEvent | null {
    const row = queryOne<{
      event_id: string; seq: number; branch: string; parent_event_id: string | null; type: EventType;
      scenario: ScenarioCode | null; rationale: string | null; author: string; ts: string;
      payload_json: string; refs_json: string; invalidates_json: string | null;
    }>(this.db, 'SELECT * FROM events WHERE event_id=?', [eventIdValue]);
    if (!row) return null;
    return {
      eventId: row.event_id,
      seq: row.seq,
      branch: row.branch,
      parentEventId: row.parent_event_id,
      type: row.type,
      scenario: row.scenario ?? undefined,
      rationaleCode: (row.rationale as keyof typeof RATIONALE) ?? undefined,
      timestamp: row.ts,
      author: row.author,
      payload: JSON.parse(row.payload_json),
      refs: JSON.parse(row.refs_json),
      invalidatesScope: row.invalidates_json ? JSON.parse(row.invalidates_json) : undefined
    };
  }

  events(branch: string): DomainEvent[] {
    return queryRows<{ event_id: string }>(this.db, 'SELECT event_id FROM events WHERE branch=? ORDER BY seq ASC', [branch])
      .map((r) => this.getEvent(r.event_id)!);
  }

  /** 追加事件：事务内做引用存在性校验；失败回滚，不允许留半份记录。 */
  appendEvent(args: AppendEventArgs): DomainEvent {
    this.db.run('SAVEPOINT append_event');
    try {
      const refs = (args.refs ?? []).map((r) => ({ ...r }));
      const missing: string[] = [];
      for (const ref of refs) {
        const ok = queryOne<{ c: number }>(this.db, 'SELECT 1 AS c FROM object_contents WHERE content_id=?', [ref.contentId]);
        if (!ok) missing.push(ref.contentId);
      }
      if (missing.length) {
        throw new CorruptArchiveError(`事件引用了不存在的内容版本: ${missing.join(', ')}`, missing);
      }
      const head = this.headEvent(args.branch);
      if (args.expectedParentEventId !== undefined && (args.expectedParentEventId ?? null) !== (head?.eventId ?? null)) {
        throw new VersionConflictError(head?.eventId ?? null, args.expectedParentEventId ?? null);
      }
      const seq = this.nextSeq(args.branch);
      const ev: DomainEvent = {
        eventId: eventId(seq, args.branch),
        seq,
        branch: args.branch,
        parentEventId: args.parentEventId !== undefined ? args.parentEventId : head?.eventId ?? null,
        type: args.type,
        scenario: args.scenario,
        rationaleCode: args.rationaleCode,
        timestamp: args.ts ?? new Date().toISOString(),
        author: args.author,
        payload: args.payload,
        refs,
        invalidatesScope: args.invalidatesScope
      };
      this.db.run(
        `INSERT INTO events(seq,branch,event_id,parent_event_id,type,scenario,rationale,author,ts,payload_json,refs_json,invalidates_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ev.seq, ev.branch, ev.eventId, ev.parentEventId, ev.type, ev.scenario ?? null, ev.rationaleCode ?? null,
         ev.author, ev.timestamp, JSON.stringify(ev.payload), JSON.stringify(ev.refs),
         ev.invalidatesScope ? JSON.stringify(ev.invalidatesScope) : null]
      );
      this.db.run('RELEASE SAVEPOINT append_event');
      return ev;
    } catch (e) {
      this.db.run('ROLLBACK TO SAVEPOINT append_event');
      this.db.run('RELEASE SAVEPOINT append_event');
      throw e;
    }
  }

  // ---------- 内容版本登记 ----------

  /**
   * 登记实体的一个新版本到某分支。
   * 内容哈希相同时复用既有内容；分支头永远指向该次事件写入的版本。
   */
  commitObject(args: {
    branch: string;
    stableId: string;
    kind: string;
    body: unknown;
    event: DomainEvent;
    refs?: RefSpec[];
  }): ContentRecord {
    const version = this.latestVersionNumber(args.stableId);
    const rec = putContent(this.db, {
      stableId: args.stableId,
      kind: args.kind,
      version,
      body: args.body
    }, args.event.eventId);
    for (const ref of args.refs ?? []) {
      this.db.run('INSERT OR IGNORE INTO object_refs(content_id,ref_content_id,role) VALUES (?,?,?)',
        [rec.contentId, ref.contentId, ref.role]);
    }
    this.db.run(
      `INSERT INTO object_versions(branch,stable_id,version,content_id,seq) VALUES (?,?,?,?,?)`,
      [args.branch, args.stableId, rec.version, rec.contentId, args.event.seq]
    );
    this.db.run(
      `INSERT INTO object_heads(branch,stable_id,version) VALUES (?,?,?)
       ON CONFLICT(branch,stable_id) DO UPDATE SET version=excluded.version`,
      [args.branch, args.stableId, rec.version]
    );
    return rec;
  }

  latestVersionNumber(stableId: string): number {
    return nextVersion(this.db, stableId);
  }

  /** 分支上某实体当前头版本的内容。 */
  headContent(branch: string, stableId: string, atSeq?: number): ContentRecord | null {
    let row: { content_id: string } | null;
    if (atSeq === undefined) {
      row = queryOne(this.db, 'SELECT content_id FROM object_heads WHERE branch=? AND stable_id=?', [branch, stableId]);
    } else {
      row = queryOne(
        this.db,
        `SELECT content_id FROM object_versions WHERE branch=? AND stable_id=? AND seq<=?
         ORDER BY version DESC LIMIT 1`,
        [branch, stableId, atSeq]
      );
    }
    return row ? getContent(this.db, row.content_id) : null;
  }

  /** 分支上某实体的全部版本（旧版本继续可读，不会被悄悄替换）。 */
  history(branch: string, stableId: string): ContentRecord[] {
    return queryRows<{ content_id: string }>(
      this.db,
      'SELECT content_id FROM object_versions WHERE branch=? AND stable_id=? ORDER BY version ASC',
      [branch, stableId]
    ).map((r) => getContent(this.db, r.content_id)!);
  }

  listStableIds(branch: string, kindPrefix?: string): { stableId: string; kind: string; version: number }[] {
    const rows = queryRows<{ stable_id: string; kind: string; version: number }>(
      this.db,
      `SELECT h.stable_id AS stable_id, c.kind AS kind, h.version AS version
       FROM object_heads h JOIN object_contents c
         ON c.stable_id=h.stable_id AND c.version=h.version
       WHERE h.branch=? ${kindPrefix ? 'AND c.kind=?' : ''} ORDER BY h.stable_id`,
      kindPrefix ? [branch, kindPrefix] : [branch]
    );
    return rows.map((r) => ({ stableId: r.stable_id, kind: r.kind, version: r.version }));
  }

  // ---------- 实体信封（每个显示值都有稳定身份） ----------

  /** 查询实体：返回引用的版本号与内容摘要；缺少引用直接报损坏，不回退最新版。 */
  getEntityEnvelope(branch: string, stableId: string, atSeq?: number): EntityEnvelope | null {
    const rec = this.headContent(branch, stableId, atSeq);
    if (!rec) return null;
    const created = queryOne<{ introduced_event: string }>(
      this.db,
      'SELECT introduced_event FROM object_contents WHERE content_id=?',
      [rec.contentId]
    );
    const refRows = queryRows<{ ref_content_id: string; role: string }>(
      this.db,
      'SELECT ref_content_id,role FROM object_refs WHERE content_id=?',
      [rec.contentId]
    );
    const refs = refRows.map((r) => {
      const target = getContent(this.db, r.ref_content_id);
      if (!target) {
        throw new CorruptArchiveError(
          `实体 ${stableId}@v${rec.version} 缺少引用 ${r.ref_content_id}（${r.role}），档案损坏；拒绝回退到最新版`,
          [r.ref_content_id]
        );
      }
      return { contentId: target.contentId, role: r.role, version: target.version, summary: target.summary };
    });
    return {
      stableId: rec.stableId,
      kind: rec.kind,
      branch,
      version: rec.version,
      contentId: rec.contentId,
      contentSummary: rec.summary,
      body: rec.body,
      refs,
      createdByEvent: created!.introduced_event
    };
  }

  // ---------- 原始字节 ----------

  putBytes(bytes: Uint8Array, now: string): string {
    return ensureBytes(this.db, bytes, now);
  }

  getBytes(contentHash: string): Uint8Array | null {
    const row = queryOne<{ bytes: Uint8Array }>(this.db, 'SELECT bytes FROM bytes WHERE content_hash=?', [contentHash]);
    return row ? row.bytes : null;
  }

  // ---------- 分支 ----------

  listBranches(): { branch: string; parentBranch: string | null; forkEvent: string | null; label: string; archived: boolean }[] {
    return queryRows<any>(this.db, 'SELECT branch,parent_branch AS parentBranch,fork_event AS forkEvent,label,archived FROM branches ORDER BY created_seq')
      .map((r) => ({ ...r, archived: !!r.archived }));
  }

  /**
   * 对同一份材料重新解释时新建分支：复制源对象版本指针，旧分支、人工裁定和原始字节继续可读。
   * 返回 branch.forked 事件。
   */
  forkBranch(args: { parent: string; name: string; label: string; author: string; reason: string }): DomainEvent {
    return this.transaction(() => {
      const exists = queryOne<{ branch: string }>(this.db, 'SELECT branch FROM branches WHERE branch=?', [args.name]);
      if (exists) throw new Error(`分支 ${args.name} 已存在`);
      const parentHead = this.headEvent(args.parent);
      const ev = this.appendEvent({
        branch: args.name,
        type: 'branch.forked',
        author: args.author,
        parentEventId: null,
        payload: { parent: args.parent, forkAtEvent: parentHead?.eventId ?? null, reason: args.reason },
        refs: []
      });
      // 复制父分支所有实体头指针（内容本身不复制，继续按内容哈希共享）
      const heads = queryRows<{ stable_id: string; version: number; content_id: string; seq: number }>(
        this.db,
        'SELECT stable_id,version,content_id,seq FROM object_heads WHERE branch=?',
        [args.parent]
      );
      for (const h of heads) {
        this.db.run('INSERT INTO object_heads(branch,stable_id,version) VALUES (?,?,?)', [args.name, h.stable_id, h.version]);
        this.db.run('INSERT OR IGNORE INTO object_versions(branch,stable_id,version,content_id,seq) VALUES (?,?,?,?,?)',
          [args.name, h.stable_id, h.version, h.content_id, ev.seq]);
      }
      this.db.run('INSERT INTO branches(branch,parent_branch,fork_event,label,created_seq,archived) VALUES (?,?,?,?,?,0)',
        [args.name, args.parent, ev.eventId, args.label, ev.seq]);
      return ev;
    });
  }

  // ---------- 完整性 ----------

  /** 导入后/读回时校验：内容、引用、版本链、事件序列。缺失引用必须报损坏。 */
  verifyIntegrity(): { ok: true } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const refRows = queryRows<{ content_id: string; ref_content_id: string }>(
      this.db,
      'SELECT content_id,ref_content_id FROM object_refs'
    );
    const known = new Set(queryRows<{ content_id: string }>(this.db, 'SELECT content_id FROM object_contents').map((r) => r.content_id));
    for (const r of refRows) {
      if (!known.has(r.ref_content_id)) errors.push(`悬空引用 ${r.content_id} -> ${r.ref_content_id}`);
    }
    for (const b of this.listBranches()) {
      let expected = b.forkEvent ? 1 : 1;
      const evs = this.events(b.branch);
      evs.forEach((ev, i) => {
        if (ev.seq !== i + 1) errors.push(`分支 ${b.branch} 事件序列不连续: 位置 ${i + 1} seq=${ev.seq}`);
      });
      void expected;
      const heads = queryRows<{ stable_id: string; version: number }>(this.db, 'SELECT stable_id,version FROM object_heads WHERE branch=?', [b.branch]);
      for (const h of heads) {
        const c = queryOne<{ c: number }>(this.db, 'SELECT 1 AS c FROM object_contents WHERE stable_id=? AND version=?', [h.stable_id, h.version]);
        if (!c) errors.push(`分支 ${b.branch} 头版本缺失: ${h.stable_id}@v${h.version}`);
      }
    }
    const bytesRows = queryRows<{ content_hash: string }>(this.db, 'SELECT content_hash FROM bytes');
    for (const r of bytesRows) {
      const used = queryOne<{ c: number }>(
        this.db,
        `SELECT 1 AS c FROM object_contents WHERE json LIKE ?`,
        [`%${r.content_hash}%`]
      );
      if (!used) errors.push(`孤立原始字节 ${r.content_hash}`);
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  assertIntegrity(): void {
    const r = this.verifyIntegrity();
    if (!r.ok) throw new CorruptArchiveError(`档案完整性校验失败: ${r.errors.join('; ')}`, r.errors);
  }

  get schemaVersionValue(): number {
    return CURRENT_SCHEMA_VERSION;
  }
}

/** 给实体生成稳定身份（kind+领域键）。 */
export function idFor(kind: string, key: string): string {
  return makeStableId(kind, key);
}

export { prefixFor, lockRef, stableHash };

  /** 保存点：运行一批写操作，任何异常整体回滚（导入失败不留半份记录）。 */
  transaction<T>(fn: () => T): T {
    this.db.run('SAVEPOINT txn');
    try {
      const result = fn();
      this.db.run('RELEASE SAVEPOINT txn');
      return result;
    } catch (e) {
      this.db.run('ROLLBACK TO SAVEPOINT txn');
      this.db.run('RELEASE SAVEPOINT txn');
      throw e;
    }
  }
}
