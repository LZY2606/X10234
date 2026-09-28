import {
  AMBIGUITY_RATIO,
  proposeAxes,
  proposeCandidates,
  type AxisHypothesis,
  type DeriveInput,
} from '../shared/derive';
import { parseDQ, toDegrees } from '../shared/domain';
import type {
  BranchInfo,
  CandidateDiagnostic,
  DomainEvent,
  EntityView,
  ExposureDose,
  ID,
  InputEntity,
  InterpretedEntity,
  LockedRegistration,
  ManualExclusion,
  MarkerObservation,
  PixelScale,
  RawFrame,
  RegistrationCandidate,
  RegistrationDecision,
  SeriesMeta,
  TiltAngle,
  TiltAxisGeometry,
  TrackIdentity,
  TrackingGap,
} from '../shared/types';
import { canonicalJson, sha256Hex, stableId, uid } from './util';

export const RULE_VERSION = 'rules-3.0.0';
export const HIGH_TILT_DEG = 55;

export interface SeriesState {
  meta: SeriesMeta | null;
  frames: Map<ID, RawFrame>;
  tilts: Map<ID, TiltAngle>;
  scales: Map<ID, PixelScale>;
  doses: Map<ID, ExposureDose>;
  observations: Map<ID, MarkerObservation>;
  gaps: Map<ID, TrackingGap>;
  exclusions: Map<ID, ManualExclusion>;
  axes: Map<ID, TiltAxisGeometry>;
  tracks: Map<ID, TrackIdentity>;
  candidates: Map<ID, RegistrationCandidate>;
  decisions: Map<ID, RegistrationDecision>;
  locks: Map<ID, LockedRegistration>;
  /** entityId -> 当前生效事件版本/事件ID */
  entityOrigin: Map<ID, { eventId: ID; version: number; derivation?: DomainEvent['derivation'] }>;
  /** 候选级诊断（最近一次 candidates.proposed 的全局诊断） */
  bundleDiagnostics: CandidateDiagnostic[];
  /** blob 内容索引（sha256 -> mediaType/byteLength），用于引用完整性 */
  blobs: Map<string, { mediaType: string; byteLength: number }>;
  /** 跟踪交换关系（从 tracks.proposed 载荷恢复） */
  badFrameIds: Set<ID>;
  missingAcquisitionIndices: number[];
}

export interface BranchState {
  info: BranchInfo;
  events: DomainEvent[];
  state: SeriesState;
}

export function emptySeriesState(): SeriesState {
  return {
    meta: null,
    frames: new Map(),
    tilts: new Map(),
    scales: new Map(),
    doses: new Map(),
    observations: new Map(),
    gaps: new Map(),
    exclusions: new Map(),
    axes: new Map(),
    tracks: new Map(),
    candidates: new Map(),
    decisions: new Map(),
    locks: new Map(),
    entityOrigin: new Map(),
    bundleDiagnostics: [],
    blobs: new Map(),
    badFrameIds: new Set(),
    missingAcquisitionIndices: [],
  };
}

const PAYLOAD_KIND_MAP: Record<string, keyof SeriesState> = {
  RawFrame: 'frames',
  TiltAngle: 'tilts',
  PixelScale: 'scales',
  ExposureDose: 'doses',
  MarkerObservation: 'observations',
  TrackingGap: 'gaps',
  ManualExclusion: 'exclusions',
  TiltAxisGeometry: 'axes',
  TrackIdentity: 'tracks',
  RegistrationCandidate: 'candidates',
  RegistrationDecision: 'decisions',
  LockedRegistration: 'locks',
};

function idOf(entity: unknown): ID {
  const e = entity as Record<string, unknown>;
  return (
    (e.frameId as ID) ??
    (e.tiltId as ID) ??
    (e.scaleId as ID) ??
    (e.doseId as ID) ??
    (e.observationId as ID) ??
    (e.gapId as ID) ??
    (e.exclusionId as ID) ??
    (e.axisId as ID) ??
    (e.trackId as ID) ??
    (e.candidateId as ID) ??
    (e.decisionId as ID) ??
    (e.lockId as ID) ??
    ''
  );
}

function indexPayload(state: SeriesState, payload: unknown, event: DomainEvent): void {
  if (Array.isArray(payload)) {
    for (const entity of payload) indexOne(state, entity as InputEntity | InterpretedEntity, event);
    return;
  }
  const p = payload as { entities?: unknown[]; badFrameIds?: ID[]; missingAcquisitionIndices?: number[]; diagnostics?: CandidateDiagnostic[] };
  if (Array.isArray(p.entities)) {
    for (const entity of p.entities) indexOne(state, entity as InputEntity | InterpretedEntity, event);
  }
  if (Array.isArray(p.badFrameIds)) state.badFrameIds = new Set(p.badFrameIds);
  if (Array.isArray(p.missingAcquisitionIndices)) state.missingAcquisitionIndices = p.missingAcquisitionIndices;
  if (Array.isArray(p.diagnostics)) state.bundleDiagnostics = p.diagnostics;
}

function indexOne(state: SeriesState, entity: InputEntity | InterpretedEntity, event: DomainEvent): void {
  const bucket = PAYLOAD_KIND_MAP[entity.kind];
  if (!bucket) return;
  const entityId = idOf(entity);
  (state[bucket] as Map<ID, unknown>).set(entityId, entity);
  state.entityOrigin.set(entityId, {
    eventId: event.eventId,
    version: event.version,
    derivation: event.derivation,
  });
}

export function applyEvent(state: SeriesState, event: DomainEvent): SeriesState {
  switch (event.type) {
    case 'series.created': {
      const p = event.payload as SeriesMeta;
      state.meta = p;
      return state;
    }
    case 'frames.imported': {
      const p = event.payload as { entities: RawFrame[]; blobs?: { sha256: string; mediaType: string; byteLength: number }[] };
      for (const b of p.blobs ?? []) state.blobs.set(b.sha256, { mediaType: b.mediaType, byteLength: b.byteLength });
      for (const frame of p.entities) {
        state.frames.set(frame.frameId, frame);
        state.entityOrigin.set(frame.frameId, { eventId: event.eventId, version: event.version, derivation: event.derivation });
      }
      if (state.meta) {
        state.meta.frameCount = state.frames.size;
      }
      return state;
    }
    case 'candidates.proposed': {
      indexPayload(state, event.payload, event);
      return state;
    }
    default:
      indexPayload(state, event.payload, event);
      return state;
  }
}

export function replay(events: DomainEvent[], untilEventId?: ID): SeriesState {
  const state = emptySeriesState();
  for (const event of events) {
    applyEvent(state, event);
    if (untilEventId && event.eventId === untilEventId) break;
  }
  return state;
}
