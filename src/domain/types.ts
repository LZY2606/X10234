import type { ContentHash } from './identity.js';

/**
 * Domain vocabulary for the 倾转帧拼合室 (tilt-frame assembly room).
 *
 * The contract deliberately uses electron-tomography terms rather than a
 * generic name/value bag. Every imported field keeps its raw representation;
 * normalization happens only in the derived layer. Quantities carry either a
 * unit or a coordinate frame. Values that cannot be converted stay in place
 * with a diagnostic — they are never silently dropped for plotting.
 */

export type AngleUnit = 'degree' | 'radian' | 'gon';
export type LengthUnit = 'nm' | 'um' | 'pixel' | 'mm';
export type DoseUnit = 'e-/A^2' | 'e/nm^2' | 'e-/nm^2';
export type PixelCoordinateFrame = 'image-pixel' | 'binned-pixel' | 'stage';

export interface DomainQuantity<R = string, N = number> {
  /** exact representation as imported, e.g. "-67.5°", "0.02 nm" */
  raw: R;
  /** normalized value used by derived calculations */
  value?: N;
  unit?: string;
  /** retained in place when conversion is impossible */
  diagnostic?: string;
}

export interface PixelCoordinate {
  x: DomainQuantity;
  y: DomainQuantity;
  frame: PixelCoordinateFrame;
  /** true when the marker was not observed on this frame (tracking gap) */
  gap?: boolean;
}

/** 原始帧 raw tilt frame — pixel bytes are addressed by content hash. */
export interface RawFrame {
  kind: 'raw-frame';
  frameId: string;
  sequenceIndex: number;
  acquisitionRef: string;
  width: number;
  height: number;
  pixelFormat: string;
  blob: ContentHash;
  byteLength: number;
  /** synthetic renderer recipe used by the bundled offline case pack */
  syntheticRecipe?: FrameRecipe;
}

export interface FrameRecipe {
  base: number;
  tiltAngleDeg: number;
  axisAngleDeg: number;
  pivotXPx: number;
  pivotYPx: number;
  doseFactor: number;
  driftXPx: number;
  driftYPx: number;
  noise: number;
  missing?: boolean;
  bad?: boolean;
  deformation?: { cx: number; cy: number; amp: number; sigma: number };
}

/** 倾角 tilt angle per frame. */
export interface TiltAngleReading {
  kind: 'tilt-angle';
  readingId: string;
  frameId: string;
  angle: DomainQuantity;
  nominalSignConvention: '+CCW';
}

/** 像素尺度 pixel scale per frame (or shared calibration). */
export interface PixelScaleCalibration {
  kind: 'pixel-scale';
  calibrationId: string;
  frameId: string | '*';
  pixelSize: DomainQuantity;
}

/** 曝光剂量 exposure dose per frame. */
export interface ExposureDose {
  kind: 'exposure-dose';
  doseId: string;
  frameId: string;
  dose: DomainQuantity;
  cumulativeDose?: DomainQuantity;
}

/** fiducial 标记点坐标 — one observation of one marker on one frame. */
export interface FiducialObservation {
  kind: 'fiducial-observation';
  observationId: string;
  trackId: string;
  frameId: string;
  sequenceIndex: number;
  coordinate: PixelCoordinate;
  residual?: DomainQuantity;
}

/** 跟踪缺口 tracked gap: a marker unobserved or the track broken. */
export interface TrackingGap {
  kind: 'tracking-gap';
  gapId: string;
  trackId: string;
  fromSequenceIndex: number;
  toSequenceIndex: number;
  reason:
    | 'marker-out-of-field'
    | 'occluded'
    | 'below-contrast'
    | 'untrackable-high-tilt'
    | 'identity-ambiguous'
    | 'unknown';
  note?: string;
}

/** 手工排除原因 manual frame exclusion with operator rationale. */
export interface ManualExclusion {
  kind: 'manual-exclusion';
  exclusionId: string;
  frameId: string;
  reason:
    | 'too-much-motion'
    | 'cracked-fiducial'
    | 'beam-blocked'
    | 'high-tilt-unusable'
    | 'preferred-count-bias'
    | 'other';
  operator: string;
  rationale: string;
}

export type SourceEntity =
  | RawFrame
  | TiltAngleReading
  | PixelScaleCalibration
  | ExposureDose
  | FiducialObservation
  | TrackingGap
  | ManualExclusion;

export type SourceEntityKind = SourceEntity['kind'];

/**
 * 倾转轴 tilt axis. The pivot is an *estimated* coordinate, never assumed to be
 * the image center. `centerFixed` marks the legacy "axis through image center"
 * assumption so the review UI can show why it is rejected.
 */
export interface TiltAxisModel {
  kind: 'tilt-axis';
  axisId: string;
  angleRad: number;
  angleDeg: number;
  pivotXPx: number;
  pivotYPx: number;
  imageCenterXPx: number;
  imageCenterYPx: number;
  eccentricityPx: number;
  centerFixed: boolean;
  supportObservations: number;
  ruleVersion: string;
  indeterminate?: boolean;
  legalAlternatives?: Array<{ angleDeg: number; pivotXPx: number; pivotYPx: number }>;
}

export type CandidateFamily =
  | 'rigid'
  | 'local-deformation'
  | 'bad-frame-exclusion'
  | 'center-fixed-axis-legacy';

export type CandidateStatus =
  | 'legal'
  | 'diagnostic'
  | 'ambiguous'
  | 'rejected'
  | 'accepted'
  | 'negated'
  | 'frozen';

export interface FrameTransform {
  frameId: string;
  sequenceIndex: number;
  /** rigid part */
  rotationRad: number;
  translationXPx: number;
  translationYPx: number;
  /** local deformation coefficients (bilinear around centroid) */
  local?: { a: number; b: number; c: number; d: number };
  excluded?: boolean;
}

export interface PerFrameResidual {
  frameId: string;
  sequenceIndex: number;
  usedObservations: number;
  rmsPx: number;
  maxPx: number;
  excluded?: boolean;
}

export interface RegistrationCandidate {
  kind: 'registration-candidate';
  candidateId: string;
  caseId: string;
  scenarioId: string;
  family: CandidateFamily;
  branchId: string;
  serial: number;
  status: CandidateStatus;
  ruleVersion: string;
  axis: TiltAxisModel;
  transforms: FrameTransform[];
  perFrameResiduals: PerFrameResidual[];
  /**
   * Effective point set signature — candidates may only be compared when these
   * match. "不用少帧换低残差": a candidate using fewer frames can never win on
   * residual against a candidate evaluated on the full set.
   */
  effectivePointSetSignature: string;
  effectiveFrameIds: string[];
  effectiveObservationCount: number;
  rmsPx: number;
  degreesOfFreedom: number;
  overfitScore?: number;
  diagnostics: CandidateDiagnostic[];
  dependsOn: DependencyRef[];
  createdAtEventSeq: number;
}

export interface CandidateDiagnostic {
  code:
    | 'axis-center-assumption'
    | 'track-identity-swap'
    | 'track-break'
    | 'missing-high-tilt-frame'
    | 'bad-frame-excluded'
    | 'preferred-count-bias'
    | 'local-deformation-overfit'
    | 'multi-solution'
    | 'unconvertible-quantity'
    | 'concurrent-conflict';
  severity: 'info' | 'warning' | 'error';
  message: string;
  frameIds?: string[];
  trackIds?: string[];
}

export interface DependencyRef {
  kind: SourceEntityKind | 'rule' | 'parameter-revision' | 'candidate';
  refId: string;
  version: number;
  contentHash: ContentHash;
}

/**
 * Machine-readable decision record. These are the append-only events the
 * archive replays; querying any entity returns the event versions it cites.
 */
export type ArchiveEvent =
  | ImportCommittedEvent
  | InterpretationBranchedEvent
  | CandidateRegisteredEvent
  | CandidateNegatedEvent
  | CandidateAcceptedEvent
  | DecisionUndoneEvent
  | ParameterRevisedEvent
  | ConflictRejectedEvent
  | RegistrationFrozenEvent;

export interface EventBase {
  eventId: string;
  seq: number;
  caseId: string;
  branchId: string;
  at: string;
  actor: string;
  prevHash: ContentHash | 'GENESIS';
  hash: ContentHash;
}

export interface ImportCommittedEvent extends EventBase {
  type: 'import.committed';
  importBatchId: string;
  sourceRecordIds: string[];
  blobHashes: ContentHash[];
  rollbackToken: string;
}

export interface InterpretationBranchedEvent extends EventBase {
  type: 'interpretation.branched';
  interpretationIds: string[];
  fromBranchId: string | null;
  subjectSourceIds: string[];
  note: string;
}

export interface CandidateRegisteredEvent extends EventBase {
  type: 'candidate.registered';
  candidateId: string;
  family: CandidateFamily;
  scenarioId: string;
  effectivePointSetSignature: string;
  rmsPx: number;
}

export interface CandidateNegatedEvent extends EventBase {
  type: 'candidate.negated';
  candidateId: string;
  reason: string;
}

export interface CandidateAcceptedEvent extends EventBase {
  type: 'candidate.accepted';
  candidateId: string;
  forReconstructionRef: string;
}

export interface DecisionUndoneEvent extends EventBase {
  type: 'decision.undone';
  undoneEventId: string;
  restoredBranchId: string;
}

export interface ParameterRevisedEvent extends EventBase {
  type: 'parameter.revised';
  ruleVersionFrom: string;
  ruleVersionTo: string;
  scope: string[];
}

export interface ConflictRejectedEvent extends EventBase {
  type: 'conflict.rejected';
  attemptedCandidateId: string;
  expectedBranchVersion: number;
  actualBranchVersion: number;
  diff: string[];
}

export interface RegistrationFrozenEvent extends EventBase {
  type: 'registration.frozen';
  candidateId: string;
  forReconstructionRef: string;
  lockToken: string;
}

export interface BranchHead {
  branchId: string;
  caseId: string;
  name: string;
  parentBranchId: string | null;
  version: number;
  headSeq: number;
  frozenCandidateId: string | null;
}

export interface CounterexampleArchive {
  scenarioId: ScenarioCode;
  label: string;
  minimalInputId: string;
  combinedInputId: string;
}

export type ScenarioCode =
  | 'axis-off-center'
  | 'track-identity-swap'
  | 'missing-high-tilt'
  | 'bad-frame-exclusion'
  | 'local-deformation-overfit'
  | 'multi-solution'
  | 'concurrent-freeze';

export interface CasePackManifest {
  packFormat: 'tilt-assembly-room/case-pack';
  packVersion: 1;
  caseId: string;
  title: string;
  narrative: string;
  frames: Array<{
    frameId: string;
    sequenceIndex: number;
    angle: string;
    pixelScale: string;
    dose: string;
    synthetic: FrameRecipe;
  }>;
  tracks: Record<string, Array<[number, number, number] | [number, null, null]>>;
  trackSwaps?: Array<{ atSequenceIndex: number; trackA: string; trackB: string }>;
  gaps: TrackingGap[];
  exclusions: ManualExclusion[];
  counterexamples: CounterexampleArchive[];
  replayPlan: Array<{ step: number; action: string; scenario?: ScenarioCode; expect: string }>;
  parameterRevision?: { fromRule: string; toRule: string; scope: string[] };
  conflictingDecisions?: Array<{ branchId: string; candidateFamily: CandidateFamily; verdict: 'accept' | 'negate' }>;
}
