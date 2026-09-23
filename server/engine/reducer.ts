import type {
  AdjudicationContent, DomainEvent, RegistrationCandidateContent,
  RegistrationLockContent, RuleJudgementContent, SourceEntityKind,
  TiltAxisRuleContent, TrackSegmentContent, VersionedEnvelope
} from '../core/types.ts';
import { contentVersionId, summarize } from '../core/identity.ts';
import type { ProjectionState, SourceBundle, SourceKind } from './state.ts';

export class Corruption extends Error {
  constructor(public code: 'CORRUPT_REFERENCE' | 'CORRUPT_BLOB' | 'CORRUPT_ORDER',
              message: string, public missingRef: string, public holderEventSeq?: number) {
    super(message);
    this.name = 'Corruption';
  }
}

type UpsertKind = SourceEntityKind | 'tiltAxisRule' | 'trackSegmentRule' | 'registrationCandidate'
  | 'adjudication' | 'registrationLock' | 'ruleJudgement';

function upsert(
  state: ProjectionState,
  event: DomainEvent,
  kind: UpsertKind,
  stableId: string,
  content: unknown,
  blobRefs: string[] = [],
  status: VersionedEnvelope['status'] = 'active'
): void {
  const versionId = contentVersionId(kind, stableId, content);
  const prev = state.entities.get(stableId)?.envelope ?? null;
  const envelope: VersionedEnvelope = {
    stableId,
    kind,
    versionId,
    seq: event.seq,
    branch: event.branch,
    status,
    predecessorVersionId: prev?.versionId ?? null,
    content,
    contentSummary: summarize(content),
    blobRefs,
    createdByEventId: event.eventId
  };
  state.entities.set(stableId, { envelope });
  const list = state.history.get(stableId) ?? [];
  list.push(envelope);
  state.history.set(stableId, list);
}

const VERSION_PREFIXES = ['obs:', 'tilt:', 'dose:', 'scale:', 'frame:', 'axis:', 'seg:',
  'candidate:', 'adjudication:', 'exclusion:', 'gap:', 'marker:'];

function verifyRefs(state: ProjectionState, event: DomainEvent): void {
  // 损坏检测：缺少引用必须报损坏，不能退回当前最新版。
  // 版本引用编码为 stableId@versionId，必须精确命中历史中的那一版，而非当前最新版。
  for (const [key, ref] of Object.entries(event.dependencyRefs)) {
    if (ref === null || ref === undefined || ref === '') {
      throw new Corruption('CORRUPT_REFERENCE',
        `event ${event.eventId} has empty dependency ref "${key}"`, String(ref), event.seq);
    }
    if (key.startsWith('blob:')) {
      const sha = String(ref);
      if (!state.blobs.has(sha)) {
        throw new Corruption('CORRUPT_BLOB',
          `event ${event.eventId} references missing blob ${sha}`, sha, event.seq);
      }
      continue;
    }
    if (VERSION_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      const at = String(ref).indexOf('@');
      if (at < 0) {
        throw new Corruption('CORRUPT_REFERENCE',
          `event ${event.eventId} malformed version ref ${key}=${ref}`, String(ref), event.seq);
      }
      const stableId = String(ref).slice(0, at);
      const versionId = String(ref).slice(at + 1);
      const list = state.history.get(stableId);
      if (!list || !list.some((e) => e.versionId === versionId)) {
        throw new Corruption('CORRUPT_REFERENCE',
          `event ${event.eventId} references missing version ${ref} (no fallback to latest)`,
          String(ref), event.seq);
      }
    }
  }
}

function applySourceImport(state: ProjectionState, event: DomainEvent): void {
  const bundle = event.payload as { batch: unknown; source: SourceBundle };
  const source = bundle.source;
  const kindMap: Array<[SourceKind, { stableId: (x: never) => string; rows: unknown[]; blobOf?: (x: never) => string[] }]> = [
    ['rawFrame', { stableId: (x) => (x as { frameId: string }).frameId, rows: source.frames, blobOf: (x) => [(x as { contentRef: { sha256: string } }).contentRef.sha256] }],
    ['tiltAngle', { stableId: (x) => `tilt_${(x as { frameId: string }).frameId}`, rows: source.tilts }],
    ['pixelScale', { stableId: (x) => `scale_${(x as { frameId?: string }).frameId ?? 'series'}`, rows: source.scales }],
    ['dose', { stableId: (x) => `dose_${(x as { frameId: string }).frameId}`, rows: source.doses }],
    ['fiducialMarker', { stableId: (x) => (x as { markerId: string }).markerId, rows: source.markers }],
    ['markerObservation', { stableId: (x) => (x as { observationId: string }).observationId, rows: source.observations }],
    ['trackingGap', { stableId: (x) => (x as { gapId: string }).gapId, rows: source.gaps }],
    ['manualExclusion', { stableId: (x) => (x as { exclusionId: string }).exclusionId, rows: source.exclusions }]
  ];
  for (const [kind, spec] of kindMap) {
    for (const row of spec.rows as never[]) {
      const id = spec.stableId(row);
      upsert(state, event, kind, id, row, spec.blobOf?.(row) ?? []);
    }
  }
}

function applySourceRevised(state: ProjectionState, event: DomainEvent): void {
  const p = event.payload as { kind: SourceKind; stableId: string; content: unknown; blobRefs?: string[] };
  upsert(state, event, p.kind, p.stableId, p.content, p.blobRefs ?? [], 'active');
}

export function applyEvent(state: ProjectionState, event: DomainEvent): void {
  if (event.seq !== state.headSeq + 1) {
    throw new Corruption('CORRUPT_ORDER',
      `expected seq ${state.headSeq + 1} got ${event.seq}`, event.eventId, event.seq);
  }
  verifyRefs(state, event);

  switch (event.type) {
    case 'archive.created':
      break;
    case 'source.imported':
      applySourceImport(state, event);
      break;
    case 'source.revised':
      applySourceRevised(state, event);
      break;
    case 'axis.rule_revised':
      upsert(state, event, 'tiltAxisRule', (event.payload as { axisId: string }).axisId,
        event.payload as TiltAxisRuleContent);
      break;
    case 'track.segment_revised': {
      const payload = event.payload as TrackSegmentContent;
      upsert(state, event, 'trackSegmentRule', payload.segmentId, payload);
      break;
    }
    case 'frame.exclusion_changed': {
      const payload = event.payload as { exclusionId: string };
      // 排除规则引用已存在的手工排除实体，状态标记 excluded
      const existing = state.entities.get(payload.exclusionId);
      if (existing) {
        upsert(state, event, existing.envelope.kind as SourceEntityKind, payload.exclusionId,
          { ...existing.envelope.content, exclusionChangedAt: event.eventId },
          existing.envelope.blobRefs, 'excluded');
      }
      break;
    }
    case 'registration.computed': {
      const payload = event.payload as RegistrationCandidateContent;
      upsert(state, event, 'registrationCandidate', payload.candidateId, payload);
      break;
    }
    case 'rule.judged': {
      const payload = event.payload as RuleJudgementContent;
      upsert(state, event, 'ruleJudgement', payload.judgementId, payload);
      break;
    }
    case 'ambiguity.resolved_set':
      // 仅记录决定集合，不抹掉其他候选
      break;
    case 'adjudication.recorded': {
      const payload = event.payload as AdjudicationContent;
      upsert(state, event, 'adjudication', payload.adjudicationId, payload);
      if (payload.decision === 'accepted' && !payload.revoked) {
        state.acceptedCandidate.set(event.branch, payload.adjudicationId);
      }
      break;
    }
    case 'adjudication.revoked': {
      const payload = event.payload as { adjudicationId: string };
      const env = state.entities.get(payload.adjudicationId);
      if (env) {
        upsert(state, event, 'adjudication', payload.adjudicationId,
          { ...env.envelope.content, revoked: true } as AdjudicationContent,
          env.envelope.blobRefs, 'superseded');
      }
      if (state.acceptedCandidate.get(event.branch) === payload.adjudicationId) {
        state.acceptedCandidate.delete(event.branch);
      }
      break;
    }
    case 'registration.locked': {
      const payload = event.payload as RegistrationLockContent;
      upsert(state, event, 'registrationLock', payload.lockId, payload);
      state.locks.set(payload.lockId, payload);
      break;
    }
    case 'registration.lock_released': {
      const payload = event.payload as { lockId: string };
      const current = state.locks.get(payload.lockId);
      if (current) {
        const released = { ...current, active: false };
        upsert(state, event, 'registrationLock', payload.lockId, released);
        state.locks.set(payload.lockId, released);
      }
      break;
    }
    case 'branch.created': {
      const payload = event.payload as { branch: string; parentBranch: string };
      state.branches.set(payload.branch, {
        branch: payload.branch,
        parentBranch: payload.parentBranch,
        createdAtEventSeq: event.seq,
        headSeq: event.seq,
        tipEventId: event.eventId
      });
      break;
    }
    case 'probe.opened': {
      const payload = event.payload as { probeId: string; code: string };
      state.probes.set(payload.probeId, {
        probeId: payload.probeId, code: payload.code, open: true,
        openedAtSeq: event.seq, closedAtSeq: null
      });
      break;
    }
    case 'probe.closed': {
      const payload = event.payload as { probeId: string };
      const probe = state.probes.get(payload.probeId);
      if (probe) state.probes.set(payload.probeId, { ...probe, open: false, closedAtSeq: event.seq });
      break;
    }
  }

  state.events.push(event);
  state.headSeq = event.seq;
  const branch = state.branches.get(event.branch);
  if (branch) {
    branch.headSeq = event.seq;
    branch.tipEventId = event.eventId;
  }
}

/** 从事件流重放到指定 seq；回放到旧事件即恢复当时依赖版本与可见结论 */
export function replay(events: DomainEvent[], archiveId: string, upToSeq = Number.POSITIVE_INFINITY): ProjectionState {
  const state = createState(archiveId);
  for (const event of events) {
    if (event.seq > upToSeq) break;
    applyEvent(state, event);
  }
  return state;
}
