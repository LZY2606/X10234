import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ALL_TABLES } from './db.js';
import { digestOf, canonicalJson } from './domain/digest.js';
import { normalizeQuantity } from './domain/units.js';
import {
  computeCandidate, compareOnCommonSet,
  type AlignmentParams, type CandidateResult, type FrameInput, type Track, type SpecimenRef,
} from './domain/alignment.js';

export type SourceKind =
  | 'frames' | 'pixel_size' | 'fiducial_tracks' | 'exclusions' | 'specimen_ref';

export interface Ref { kind: string; id: string; version: number; digest: string }
export interface ImportResult {
  series_id: string;
  source: { id: string; version: number; kind: SourceKind; digest: string };
  event_seq: number;
  invalidated: { owner_kind: string; owner_id: string; owner_version: number; reason: string }[];
  diagnostics: { code: string; message: string }[];
}

interface Row { [k: string]: unknown }
interface RawFrame { index: number; tilt_angle_raw: string; dose_raw: string; blur?: boolean }

export class VersionConflict extends Error {
  constructor(public current: unknown, public yours: unknown, public diff: unknown) {
    super('version_conflict');
    this.name = 'VersionConflict';
  }
}

export class Store {
  constructor(public db: DatabaseSync) {}

  private now() { return new Date().toISOString(); }

  event(type: string, actor: string, branchId: string | null, payload: unknown): number {
    const info = this.db.prepare(
      'INSERT INTO events(type, actor, branch_id, payload, created_at) VALUES(?,?,?,?,?)',
    ).run(type, actor, branchId, canonicalJson(payload), this.now());
    return Number(info.lastInsertRowid);
  }

  events(since = 0): Row[] {
    return (this.db.prepare(
      'SELECT seq, type, actor, branch_id, payload, created_at FROM events WHERE seq > ? ORDER BY seq',
    ).all(since) as Row[]).map((r) => ({ ...r, payload: JSON.parse(r.payload as string) }));
  }

  // blob：内容寻址，共享原始片段只存一份不可变内容
  putBlob(content: string, mediaType: string, seq: number): string {
    const hash = createHash('sha256').update(content).digest('hex');
    this.db.prepare(
      'INSERT OR IGNORE INTO blobs(hash, content, media_type, created_seq) VALUES(?,?,?,?)',
    ).run(hash, content, mediaType, seq);
    return hash;
  }

  getBlob(hash: string): { hash: string; content: string; media_type: string } | null {
    return (this.db.prepare('SELECT hash, content, media_type FROM blobs WHERE hash=?').get(hash) as
      { hash: string; content: string; media_type: string } | null) ?? null;
  }

  createSeries(id: string, name: string, actor = 'system'): number {
    const seq = this.event('series.created', actor, null, { id, name });
    this.db.prepare('INSERT INTO series(id, name, version, created_seq) VALUES(?,?,1,?)').run(id, name, seq);
    return seq;
  }

  series(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM series WHERE id=?').get(id) as Row | undefined;
  }

  // 导入源数据：失败整体回滚，不允许留下半份记录
  importSource(seriesId: string, kind: SourceKind, content: unknown, actor = 'em-group'): ImportResult {
    this.db.exec('SAVEPOINT import_source');
    try {
      const series = this.series(seriesId);
      if (!series) throw new Error(`unknown_series: ${seriesId}`);
      const serialized = canonicalJson(content);
      const evSeq = this.event('source.imported', actor, null, { series_id: seriesId, kind });
      const hash = this.putBlob(serialized, 'application/json', evSeq);
      const prev = this.db.prepare('SELECT MAX(version) AS v FROM sources WHERE id=?').get(kind) as { v: number | null };
      const version = (prev.v ?? 0) + 1;
      const d = digestOf(content);
      this.db.prepare(
        'INSERT INTO sources(id, version, kind, series_id, blob_hash, digest, created_seq) VALUES(?,?,?,?,?,?,?)',
      ).run(kind, version, kind, seriesId, hash, d, evSeq);
      const diagnostics = this.collectDiagnostics(kind, content, evSeq);
      const invalidated = this.invalidateDependents(kind, evSeq);
      this.db.exec('RELEASE SAVEPOINT import_source');
      return {
        series_id: seriesId,
        source: { id: kind, version, kind, digest: d },
        event_seq: evSeq, invalidated, diagnostics,
      };
    } catch (e) {
      this.db.exec('ROLLBACK TO SAVEPOINT import_source');
      this.db.exec('RELEASE SAVEPOINT import_source');
      throw e;
    }
  }

  private collectDiagnostics(kind: SourceKind, content: unknown, seq: number) {
    const out: { code: string; message: string }[] = [];
    const add = (code: string, message: string) => {
      this.db.prepare(
        'INSERT INTO diagnostics(id, entity_kind, entity_id, severity, code, message, created_seq) VALUES(?,?,?,?,?,?,?)',
      ).run(randomUUID(), kind, kind, code.includes('unparseable') ? 'error' : 'warning', code, message, seq);
      out.push({ code, message });
    };
    if (kind === 'frames') {
      const frames = (content as { frames: RawFrame[] }).frames;
      frames.forEach((f, i) => {
        const a = normalizeQuantity(f.tilt_angle_raw, 'angle');
        if (a.diagnostic) add(`frame[${i}].tilt_angle`, a.diagnostic);
        const dose = normalizeQuantity(f.dose_raw, 'dose');
        if (dose.diagnostic) add(`frame[${i}].dose`, dose.diagnostic);
      });
    }
    if (kind === 'pixel_size') {
      const q = normalizeQuantity((content as { value: string }).value, 'pixel_size');
      if (q.diagnostic) add('pixel_size', q.diagnostic);
    }
    return out;
  }

  // 参数或参考版本变化后，用依赖关系计算失效范围；旧结论保留可读，不做全局替换
  private invalidateDependents(depKind: string, triggerSeq: number) {
    const rows = this.db.prepare(
      'SELECT DISTINCT owner_kind, owner_id, owner_version FROM deps WHERE dep_kind=?',
    ).all(depKind) as { owner_kind: string; owner_id: string; owner_version: number }[];
    const out: ImportResult['invalidated'] = [];
    for (const r of rows) {
      const reason = `dependency_changed: ${depKind} 出现新版本，候选 ${r.owner_id}@v${r.owner_version} 的结论不再自动有效`;
      this.db.prepare(
        'INSERT INTO invalidations(id, trigger_seq, owner_kind, owner_id, owner_version, reason, created_seq) VALUES(?,?,?,?,?,?,?)',
      ).run(randomUUID(), triggerSeq, r.owner_kind, r.owner_id, r.owner_version, reason, triggerSeq);
      out.push({ ...r, reason });
    }
    return out;
  }

  latestSourceVersion(kind: string): number {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM sources WHERE id=?').get(kind) as { v: number | null };
    return r.v ?? 0;
  }

  sourceContent<T>(kind: string, version?: number): { version: number; digest: string; content: T } {
    const v = version ?? this.latestSourceVersion(kind);
    const row = this.db.prepare('SELECT digest, blob_hash FROM sources WHERE id=? AND version=?')
      .get(kind, v) as { digest: string; blob_hash: string } | undefined;
    if (!row) throw new Error(`missing_reference: ${kind}@v${v} —— 缺少引用必须报损坏，不能退回当前最新版`);
    const blob = this.getBlob(row.blob_hash)!;
    return { version: v, digest: row.digest, content: JSON.parse(blob.content) as T };
  }

  // 重新解释新建分支；旧分支、人工裁定和它们引用的原始字节都可继续读取
  createBranch(seriesId: string, name: string, parentId: string | null, actor = 'reviewer') {
    const parent = parentId ? this.branch(parentId) : null;
    const pins = parent ? JSON.parse(parent.source_pins as string) : this.currentPins();
    const seq = this.event('branch.created', actor, null, {
      series_id: seriesId, name, parent: parentId, source_pins: pins,
    });
    const id = `br_${randomUUID().slice(0, 10)}`;
    this.db.prepare(
      'INSERT INTO branches(id, series_id, name, parent_branch_id, source_pins, head_event_seq, created_seq) VALUES(?,?,?,?,?,?,?)',
    ).run(id, seriesId, name, parentId, canonicalJson(pins), seq, seq);
    return { id, pins, event_seq: seq };
  }

  currentPins(): Record<string, number> {
    const rows = this.db.prepare('SELECT id, MAX(version) AS v FROM sources GROUP BY id').all() as { id: string; v: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.v]));
  }

  branch(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM branches WHERE id=?').get(id) as Row | undefined;
  }
