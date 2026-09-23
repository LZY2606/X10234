import type {
  AdjudicationContent, DomainEvent, DoseV1, FiducialMarkerV1, ManualExclusionV1,
  MarkerObservationV1, PixelScaleV1, RawFrameV1, RegistrationCandidateContent,
  RegistrationLockContent, RuleJudgementContent, TiltAngleV1, TiltAxisRuleContent,
  TrackSegmentContent, TrackingGapV1, VersionedEnvelope
} from '../core/types.ts';

export interface EntityRecord<T = unknown> {
  envelope: VersionedEnvelope<T>;
}

export interface BranchState {
  branch: string;
  parentBranch: string | null;
  createdAtEventSeq: number;
  headSeq: number;
  tipEventId: string | null;
}

export interface ProjectionState {
  archiveId: string;
  headSeq: number;
  events: DomainEvent[];
  entities: Map<string, EntityRecord>;
  history: Map<string, VersionedEnvelope[]>;
  blobs: Map<string, { bytes: number; storedOnce: true }>;
  branches: Map<string, BranchState>;
  probes: Map<string, { probeId: string; code: string; open: boolean; openedAtSeq: number; closedAtSeq: number | null }>;
  locks: Map<string, RegistrationLockContent>;
  acceptedCandidate: Map<string, string>;
  lastImportDiagnostics: { batchId: string; diagnostics: unknown[] } | null;
  conflict: { sinceSeq: number; branches: string[]; diff: unknown } | null;
}

export function createState(archiveId: string): ProjectionState {
  return {
    archiveId,
    headSeq: 0,
    events: [],
    entities: new Map(),
    history: new Map(),
    blobs: new Map(),
    branches: new Map([['main', { branch: 'main', parentBranch: null, createdAtEventSeq: 0, headSeq: 0, tipEventId: null }]]),
    probes: new Map(),
    locks: new Map(),
    acceptedCandidate: new Map(),
    lastImportDiagnostics: null,
    conflict: null
  };
}

export interface SourceBundle {
  frames: RawFrameV1[];
  tilts: TiltAngleV1[];
  scales: PixelScaleV1[];
  doses: DoseV1[];
  markers: FiducialMarkerV1[];
  observations: MarkerObservationV1[];
  gaps: TrackingGapV1[];
  exclusions: ManualExclusionV1[];
}

export type SourceKind =
  | 'rawFrame' | 'tiltAngle' | 'pixelScale' | 'dose'
  | 'fiducialMarker' | 'markerObservation' | 'trackingGap' | 'manualExclusion';

export type {
  TiltAxisRuleContent, TrackSegmentContent, RegistrationCandidateContent,
  AdjudicationContent, RegistrationLockContent, RuleJudgementContent
};
