import type { Store } from './store.ts';
import type {
  Adjudication,
  CandidateDifference,
  EventRecord,
  FrozenRegistration,
  ManualExclusion,
  MarkerCoordinate,
  PixelScaleRecord,
  DoseRecord,
  RawFrame,
  RegistrationCandidate,
  StableId,
  TiltAngleRecord,
  TiltAxisEstimate,
  TrackGap,
  FiducialTrackInterpretation,
} from '../shared/types.ts';

export interface ParameterSet {
  axisPolicy: 'fit-from-fiducials' | 'assume-image-center';
  maxResidualPx: number;
  localWarpEnabled: boolean;
}

export interface Versioned<T> {
  value: T;
  version: number;
  contentSummary: string;
  createdByEventId: StableId;
}

export interface ProjectedState {
  caseId: StableId;
  branchId: StableId;
  headEventId: StableId | null;
  parameterVersion: number;
  sourceVersion: number;
  parameters: ParameterSet;
  frames: Map<StableId, Versioned<RawFrame>>;
  tilts: Map<StableId, Versioned<TiltAngleRecord>>;
  pixelScales: Map<StableId, Versioned<PixelScaleRecord>>;
  doses: Map<StableId, Versioned<DoseRecord>>;
  markers: Map<string, Versioned<MarkerCoordinate>>;
  gaps: Map<StableId, Versioned<TrackGap>>;
  exclusions: Map<StableId, Versioned<ManualExclusion>>;
  axes: Map<StableId, Versioned<TiltAxisEstimate>>;
  tracks: Map<StableId, Versioned<FiducialTrackInterpretation>>;
  candidates: Map<StableId, Versioned<RegistrationCandidate> & { status: 'active' | 'accepted' | 'rejected' }>;
  diffs: Map<StableId, Versioned<CandidateDifference>>;
  adjudications: (Adjudication & { eventId: StableId; reverted: boolean })[];
  invalidations: { eventId: StableId; affected: { kind: string; id: StableId; version: number }[] }[];
  freeze: (FrozenRegistration & { eventId: StableId; active: boolean }) | null;
  timeline: EventRecord[];
}

const DEFAULT_PARAMS: ParameterSet = {
  axisPolicy: 'fit-from-fiducials',
  maxResidualPx: 2.0,
  localWarpEnabled: true,
};

type AnyVersioned = Versioned<unknown> & { status?: string };

function bump(map: Map<string, AnyVersioned>, key: string, value: unknown, ev: EventRecord): void {
  const prev = map.get(key);
  map.set(key, {
    value,
    version: prev ? prev.version + 1 : 1,
    contentSummary: ev.refs[0]?.contentSummary ?? ev.id.slice(0, 16),
    createdByEventId: ev.id,
  });
}

/**
 * 沿分支（含父分支基点之前的祖先事件）重放，得到状态。
 * untilEventId 给出后，状态停留在该事件之后——历史视图与当前视图共用同一投影逻辑，
 * 永远不会拿最新计算结果覆盖历史。
 */
export function project(
  store: Store,
  branchId: StableId,
  untilEventId?: StableId,
): ProjectedState {
  const events = collectBranchEvents(store, branchId, untilEventId);
  const state: ProjectedState = {
    caseId: '',
    branchId,
    headEventId: null,
    parameterVersion: 1,
    sourceVersion: 1,
    parameters: { ...DEFAULT_PARAMS },
    frames: new Map(),
    tilts: new Map(),
    pixelScales: new Map(),
    doses: new Map(),
    markers: new Map(),
    gaps: new Map(),
    exclusions: new Map(),
    axes: new Map(),
    tracks: new Map(),
    candidates: new Map(),
    diffs: new Map(),
    adjudications: [],
    invalidations: [],
    freeze: null,
    timeline: events,
  };

  for (const ev of events) {
    state.caseId = ev.caseId;
    state.headEventId = ev.id;
    applyEvent(state, ev);
  }
  return state;
}

/** 收集分支自身事件；若分支从父分支基点切出，则把基点（含）之前的父事件放在前面。 */
export function collectBranchEvents(
  store: Store,
  branchId: StableId,
  untilEventId?: StableId,
): EventRecord[] {
  const own = store.replayBranch(branchId, untilEventId);
  const first = own[0];
  if (!first || !first.baseBranchHead) return own;
  const branch = store.getBranch(branchId)!;
  const parentEvents = collectBranchEvents(store, branch.parentBranchId!, first.baseBranchHead);
  return [...parentEvents, ...own];
}

function applyEvent(state: ProjectedState, ev: EventRecord): void {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.code) {
    case 'raw.ingested':
    case 'source.local-patched':
      bump(state.frames, p.id as string, p, ev);
      state.sourceVersion += ev.code === 'source.local-patched' ? 1 : 0;
      break;
    case 'tilt.ingested':
      bump(state.tilts, p.id as string, p, ev);
      break;
    case 'pixelscale.ingested':
      bump(state.pixelScales, p.id as string, p, ev);
      break;
    case 'dose.ingested':
      bump(state.doses, p.id as string, p, ev);
      break;
    case 'marker.ingested':
      bump(state.markers, `${p.markerId}@${p.frameId}`, p, ev);
      break;
    case 'gap.ingested':
      bump(state.gaps, p.id as string, p, ev);
      break;
    case 'exclusion.ingested':
      bump(state.exclusions, p.id as string, p, ev);
      break;
    case 'parameter.revised':
      state.parameters = { ...state.parameters, ...(p.parameters as object) };
      state.parameterVersion += 1;
      break;
    case 'reference.changed':
      state.parameterVersion += 1;
      break;
    case 'interpretation.axis-offset':
      bump(state.axes, p.id as string, p, ev);
      break;
    case 'interpretation.identity-swap':
    case 'interpretation.track-gap':
      bump(state.tracks, p.id as string, p, ev);
      break;
    case 'candidate.created':
      bump(state.candidates, p.id as string, { ...(p as object), status: 'active' }, ev);
      {
        const entry = state.candidates.get(p.id as string)!;
        entry.status = (entry.value as { status?: string }).status as 'active' | undefined
          ? ((entry.value as { status: string }).status as 'active' | 'accepted' | 'rejected')
          : 'active';
      }
      break;
    case 'candidate.comparison':
      bump(state.diffs, p.id as string, p, ev);
      break;
    case 'dependency.invalidated':
      state.invalidations.push({
        eventId: ev.id,
        affected: p.affected as { kind: string; id: StableId; version: number }[],
      });
      break;
    case 'adjudication.accepted':
    case 'adjudication.rejected':
    case 'adjudication.parameter-adjusted':
      state.adjudications.push({
        id: p.id as string,
        branchId: state.branchId,
        decision:
          ev.code === 'adjudication.accepted'
            ? 'accept'
            : ev.code === 'adjudication.rejected'
              ? 'reject'
              : 'parameter-adjust',
        candidateId: (p.candidateId as StableId) ?? null,
        reason: p.reason as string,
        revertedAdjudicationId: (p.revertedAdjudicationId as StableId) ?? null,
        eventId: ev.id,
        reverted: false,
      });
      if (p.candidateId) {
        const entry = state.candidates.get(p.candidateId as string);
        if (entry) entry.status = ev.code === 'adjudication.accepted' ? 'accepted' : 'rejected';
      }
      break;
    case 'adjudication.reverted': {
      const targetId = p.revertedAdjudicationId as string;
      const target = state.adjudications.find((a) => a.id === targetId);
      if (target) {
        target.reverted = true;
        if (target.candidateId) {
          const entry = state.candidates.get(target.candidateId);
          if (entry) entry.status = 'active';
        }
      }
      break;
    }
    case 'registration.frozen':
      state.freeze = {
        id: p.lockId as string,
        candidateId: p.candidateId as string,
        eventId: ev.id,
        reconstructionRef: p.reconstructionRef as string,
        active: true,
      };
      break;
    case 'diagnostic.concurrent-freeze':
      if (state.freeze) state.freeze.active = false;
      break;
    default:
      break;
  }
}
