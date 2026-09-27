export const ENTITY_KINDS = [
  'blob',
  'series',
  'frame',
  'tilt-angle',
  'pixel-scale',
  'dose',
  'marker-observation',
  'tracking-gap',
  'track-swap',
  'manual-exclusion',
  'coordinate-frame',
  'tilt-axis',
  'track-identity',
  'registration-candidate',
  'adjudication',
  'lock',
  'reconstruction-reference',
  'parameter-revision',
  'import-batch',
  'freeze-record'
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface Ref {
  kind: EntityKind;
  id: string;
  version: number;
  digest: string;
  summary: string;
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rawValue?: string;
}

export interface CoordinateFrame {
  id: string;
  kind: 'pixel-image' | 'sample-stage' | 'reconstruction';
  basis: string;
  originPx: [number, number];
  axisUMat: [[number, number], [number, number]];
}

export interface DomainQuantity {
  raw: string | number;
  rawUnit: string;
  normalized?: number;
  normalizedUnit?: string;
  basis?: string;
  diagnostic?: Diagnostic;
}

export interface RawFrame {
  frameId: string;
  seriesId: string;
  blobRef: Ref;
  encoding: string;
  widthPx: number;
  heightPx: number;
  coordinateFrameId: string;
  acquiredAt: string | null;
}

export interface TiltAngle {
  frameId: string;
  seriesId: string;
  angle: DomainQuantity;
  normalizedRad: number | null;
  scheme: 'unidirectional' | 'bidirectional' | 'dose-symmetric' | 'unknown';
  tiltDirection: 'positive' | 'negative' | 'unknown';
}

export interface PixelScale {
  frameId: string;
  seriesId: string;
  scale: DomainQuantity;
  normalizedNmPerPx: number | null;
}

export interface ExposureDose {
  frameId: string;
  seriesId: string;
  dose: DomainQuantity;
  normalizedEPerAngstrom2: number | null;
  cumulativeEPerAngstrom2: number | null;
}

export interface MarkerObservation {
  observationId: string;
  trackId: string;
  frameId: string;
  seriesId: string;
  xPx: number;
  yPx: number;
  coordinateFrameId: string;
  raw: { x: string | number; y: string | number };
  confidence: number | null;
}

export type GapReason =
  | 'occluded'
  | 'out-of-field'
  | 'missing-frame'
  | 'low-contrast'
  | 'manual'
  | 'unknown';

export interface TrackingGap {
  gapId: string;
  trackId: string;
  seriesId: string;
  fromFrameId: string;
  toFrameId: string;
  reasonCode: GapReason;
  note: string;
}

export interface TrackSwap {
  swapId: string;
  seriesId: string;
  trackIdA: string;
  trackIdB: string;
  nearFrameId: string;
  evidence: string;
}

export interface TrackIdentity {
  mappingId: string;
  seriesId: string;
  observationRefs: Ref[];
  assignments: { observationId: string; trackId: string }[];
  unresolvedPairs: { trackIdA: string; trackIdB: string; reason: string }[];
  note: string;
}

export type ExclusionReason =
  | 'drift-jump'
  | 'high-tilt-noise'
  | 'beam-blocked'
  | 'focus-loss'
  | 'contamination'
  | 'operator-choice';

export interface ManualExclusion {
  exclusionId: string;
  frameId: string;
  seriesId: string;
  reasonCode: ExclusionReason;
  reasonText: string;
  actor: string;
  decidedAt: string;
}

export interface TiltAxis {
  axisId: string;
  seriesId: string;
  angle: DomainQuantity;
  normalizedRad: number | null;
  offsetFromCenterXPx: number | null;
  offsetFromCenterYPx: number | null;
  passesThroughImageCenter: boolean;
  assumed: boolean;
  fittedFromTrackIds: string[];
  fitResidualNm: number | null;
  diagnostic: Diagnostic | null;
}

export type TransformKind = 'rigid' | 'local-warp';

export interface FrameTransform {
  frameId: string;
  kind: TransformKind;
  txNm: number;
  tyNm: number;
  rotationRad: number;
  affine?: [[number, number, number], [number, number, number]];
  warpEnergyNm2: number;
}

export interface RegistrationCandidate {
  candidateId: string;
  seriesId: string;
  method: 'rigid' | 'local-warp' | 'rigid-exclusion';
  branchId: string;
  inputsRef: Ref;
  parameterVersion: string;
  axisRef: Ref;
  trackIdentityRef: Ref;
  effectiveFrameIds: string[];
  excludedFrameIds: string[];
  transforms: FrameTransform[];
  rmsResidualNm: number;
  maxPerFrameResidualNm: number;
  perFrameResidualNm: Record<string, number>;
  usedObservationCount: number;
  degreesOfFreedom: number;
  diagnostics: Diagnostic[];
  ambiguity: { familyId: string; equivalentCandidateIds: string[]; reason: string } | null;
  valid: boolean;
  generatedAt: string;
}

export type DecisionKind = 'accepted' | 'rejected' | 'parameter-adjustment';

export interface Adjudication {
  adjudicationId: string;
  seriesId: string;
  branchId: string;
  candidateId: string | null;
  decision: DecisionKind;
  reason: string;
  actor: string;
  decidedAt: string;
  supersedesAdjudicationId: string | null;
}

export interface RegistrationLock {
  lockId: string;
  seriesId: string;
  branchId: string;
  candidateRef: Ref;
  active: boolean;
  note: string;
  actor: string;
  lockedAt: string;
  releasedAt: string | null;
}

export interface ReconstructionReference {
  referenceId: string;
  seriesId: string;
  lockRef: Ref;
  label: string;
  createdAt: string;
}

export interface ParameterRevision {
  revisionId: string;
  seriesId: string;
  changes: { key: string; from: unknown; to: unknown; unit: string | null }[];
  reason: string;
  actor: string;
  revisedAt: string;
}

export interface ImportBatch {
  batchId: string;
  seriesId: string;
  sourceName: string;
  startedAt: string;
  finishedAt: string;
  importedKinds: EntityKind[];
  rollback: boolean;
}

export interface FreezeRecord {
  freezeId: string;
  seriesId: string;
  branchId: string;
  winnerActor: string;
  loserActor: string;
  baseEventId: string;
  winnerEventId: string;
  loserEventKind: string;
  loserPayloadDigest: string;
  diffSummary: string;
  at: string;
}

export type EntityBody =
  | RawFrame
  | TiltAngle
  | PixelScale
  | ExposureDose
  | MarkerObservation
  | TrackingGap
  | TrackSwap
  | TrackIdentity
  | ManualExclusion
  | TiltAxis
  | RegistrationCandidate
  | Adjudication
  | RegistrationLock
  | ReconstructionReference
  | ParameterRevision
  | ImportBatch
  | FreezeRecord
  | CoordinateFrame;

export interface StoredVersion {
  ref: Ref;
  version: number;
  body: EntityBody;
  createdAt: string;
  branchId: string | null;
}

export interface Series {
  seriesId: string;
  name: string;
  createdAt: string;
  frameIds: string[];
}
