import { digestOf } from '../domain/ids.js';
import type {
  EventRecord,
  EntityVersionRef,
  RegistrationCandidate,
  Adjudication,
  LockedRegistration,
  TrackInterpretation,
  TiltAxisParams,
} from '../domain/types.js';

/**
 * 纯函数重放：给定分支上的事件序列，还原“当时”的可见结论。
 * 回到任意旧事件 = 只重放到该 ordinal，绝不拿最新结果覆盖历史。
 */

export interface SourceEntities {
  frames: Record<string, Record<string, unknown>>;
  tilts: Record<string, Record<string, unknown>>;
  scales: Record<string, Record<string, unknown>>;
  doses: Record<string, Record<string, unknown>>;
  points: Record<string, Record<string, unknown>>;
  gaps: Record<string, Record<string, unknown>>;
  exclusions: Record<string, Record<string, unknown>>;
}

export interface ReplayState {
  seriesId: string | null;
  source: SourceEntities;
  /** entityId -> 最新版本号（该分支）。 */
  versions: Record<string, number>;
  /** entityId -> 版本 -> 数据（保留全部版本，支持时间旅行）。 */
  history: Record<string, Record<number, Record<string, unknown>>>;
  /** entityId@version -> 引用集合。 */
  refs: Record<string, EntityVersionRef[]>;
  /** entityId@version -> 内容摘要。 */
  digests: Record<string, string>;
  rules: Record<string, Record<string, unknown>>;
  tracks: TrackInterpretation | null;
  tracksVersion: number;
  axis: TiltAxisParams | null;
  axisVersion: number;
  candidates: Record<string, RegistrationCandidate>;
  candidateOrder: string[];
  adjudications: Record<string, Adjudication>;
  adjudicationOrder: string[];
  lock: LockedRegistration | null;
  diagnostics: Record<string, unknown>[];
  scenarios: Record<string, unknown>[];
}

export function emptyState(seriesId: string | null = null): ReplayState {
  return {
    seriesId,
    source: { frames: {}, tilts: {}, scales: {}, doses: {}, points: {}, gaps: {}, exclusions: {} },
    versions: {},
    history: {},
    refs: {},
    digests: {},
    rules: {},
    tracks: null,
    tracksVersion: 0,
    axis: null,
    axisVersion: 0,
    candidates: {},
    candidateOrder: [],
    adjudications: {},
    adjudicationOrder: [],
    lock: null,
    diagnostics: [],
    scenarios: [],
  };
}

const SOURCE_TABLE: Record<string, keyof SourceEntities> = {
  'source.frame.recorded': 'frames',
  'source.tilt.recorded': 'tilts',
  'source.pixelscale.recorded': 'scales',
  'source.dose.recorded': 'doses',
  'source.point.recorded': 'points',
  'source.gap.recorded': 'gaps',
};

export function applyEvent(state: ReplayState, evt: EventRecord): void {
  const p = evt.payload as Record<string, any>;
  const putVersioned = (entityId: string, entityType: string, data: Record<string, unknown>, refs: EntityVersionRef[] = []) => {
    const v = (state.versions[entityId] ?? 0) + 1;
    state.versions[entityId] = v;
    const stored = { ...data, id: entityId, entityType, version: v };
    (state.history[entityId] ??= {})[v] = stored;
    state.refs[`${entityId}@${v}`] = refs;
    state.digests[`${entityId}@${v}`] = (p.digest as string) ?? digestOf(stored);
  };

  if (evt.type === 'series.imported') {
    state.seriesId = p.seriesId;
    if (p.rules) for (const r of p.rules as Record<string, unknown>[]) state.rules[r.code as string] = r;
  } else if (evt.type === 'rule.asserted') {
    state.rules[p.code as string] = p;
  } else if (SOURCE_TABLE[evt.type]) {
    const bucket = SOURCE_TABLE[evt.type];
    const data = p.entity as Record<string, unknown>;
    const id = data.id as string;
    state.source[bucket][id] = data;
    putVersioned(id, (data.entityType as string) ?? bucket, data, (p.references as EntityVersionRef[]) ?? []);
  } else if (evt.type === 'source.exclusion.recorded') {
    const data = p.entity as Record<string, unknown>;
    state.source.exclusions[data.id as string] = data;
    putVersioned(data.id as string, 'exclusion', data);
  } else if (evt.type === 'source.exclusion.revoked') {
    const ex = state.source.exclusions[p.exclusionId as string];
    if (ex) {
      const updated = { ...ex, active: false };
      state.source.exclusions[p.exclusionId as string] = updated;
      putVersioned(p.exclusionId as string, 'exclusion', updated);
    }
  } else if (evt.type === 'interpretation.tracks.committed') {
    state.tracks = p.tracks as TrackInterpretation;
    state.tracksVersion = p.version as number;
  } else if (evt.type === 'param.revised') {
    if (p.entityType === 'axis') {
      state.axis = p.axis as TiltAxisParams;
      state.axisVersion = p.version as number;
    }
  } else if (evt.type === 'candidate.committed') {
    const c = p.candidate as RegistrationCandidate;
    if (!state.candidates[c.id]) state.candidateOrder.push(c.id);
    state.candidates[c.id] = c;
  } else if (evt.type === 'adjudication.made') {
    const a = p.adjudication as Adjudication;
    state.adjudications[a.id] = a;
    if (!state.adjudicationOrder.includes(a.id)) state.adjudicationOrder.push(a.id);
  } else if (evt.type === 'decision.undone') {
    const a = state.adjudications[p.adjudicationId as string];
    if (a) state.adjudications[a.id] = { ...a, undone: true };
  } else if (evt.type === 'registration.locked') {
    state.lock = p.lock as LockedRegistration;
  } else if (evt.type === 'diagnostic.raised') {
    state.diagnostics.push(p);
  } else if (evt.type === 'scenario.replayed') {
    state.scenarios.push(p);
  } else if (evt.type === 'branch.forked' || evt.type === 'source.reinterpreted') {
    // 分叉本身不改写投影状态；其内容作为后续事件重放。
  }
}

export function replay(events: EventRecord[], upToOrdinal?: number, seriesId: string | null = null): ReplayState {
  const state = emptyState(seriesId);
  for (const e of events) {
    if (upToOrdinal !== undefined && e.ordinal > upToOrdinal) break;
    applyEvent(state, e);
  }
  return state;
}
