/**
 * 电子断层 / 倾转序列 / 配准审阅领域词汇表。
 * 这里刻意使用领域自己的名词（tilt angle / pixel scale / dose / fiducial track /
 * tilt axis / alignment candidate ...），而不是通用的 name/value。
 */

export type Unit =
  | "degree"
  | "radian"
  | "pixel"
  | "nanometer"
  | "angstrom"
  | "e_per_angstrom_sq"
  | "e_per_nm_sq"
  | "second"
  | "gray16";

export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  frameId?: string;
  trackId?: string;
}

/** 导入时保留的原始表示；派生层才规范化。无法转换时 parsed 为 null，原值留在原地。 */
export interface SourceValue<T> {
  raw: string;
  unit: string;
  basis: string;
  parsed: T | null;
  diagnostics: Diagnostic[];
}

export interface FrameIndexEntry {
  index: number;
  externalLabel: string;
  tiltAngleDeg: number;
}

/** 原始帧：字节内容与元数据分离，字节按 sha256 内容寻址，只存一份不可变内容。 */
export interface RawFrame {
  frameId: string;
  contentSha256: string;
  contentType: string;
  byteLength: number;
  width: number;
  height: number;
  acquisitionIndex: number;
  externalLabel: string;
  acquiredAt: string;
  tiltAngle: SourceValue<{ degrees: number }>;
  pixelScale: SourceValue<{ pixelSize: number; unit: Unit }>;
  dose: SourceValue<{ electronsPerArea: number; areaUnit: "angstrom^2" | "nm^2" }>;
}

export interface MarkerObservation {
  markerId: string;
  trackId: string;
  frameId: string;
  x: number;
  y: number;
  coordinateBasis: "pixel-origin-top-left";
  confidence: number;
  present: boolean;
}

export interface TrackingGap {
  gapId: string;
  trackId: string;
  fromFrameId: string | null;
  toFrameId: string | null;
  reasonCode: "occluded" | "out-of-field" | "tracking-lost" | "high-tilt-missing" | "unreported";
  note: string;
}

/** fiducial 轨迹可以断裂；每段可带身份标签，相邻段允许身份交换。 */
export interface TrackSegment {
  segmentId: string;
  fromFrameId: string;
  toFrameId: string;
  identity: string;
  breakBefore: boolean;
}

export interface MarkerTrack {
  trackId: string;
  observations: MarkerObservation[];
  gaps: TrackingGap[];
  segments: TrackSegment[];
  identitySwapWith: string | null;
}

export interface ManualExclusion {
  exclusionId: string;
  frameId: string;
  reasonCode: "bad-frame" | "motion-blur" | "dose-skip" | "high-tilt-missing" | "reviewer-other";
  note: string;
}

export type DirectSource =
  | "raw-frame"
  | "tilt-angle"
  | "pixel-scale"
  | "dose"
  | "marker-coordinate"
  | "tracking-gap"
  | "manual-exclusion"
  | "rule-parameter";

export interface SourceRevision {
  revisionId: string;
  archiveId: string;
  branchId: string;
  parentRevisionId: string | null;
  label: string;
  directSource: DirectSource | null;
  frameIds: string[];
  frameById: Record<string, RawFrame>;
  tracks: MarkerTrack[];
  exclusions: ManualExclusion[];
  createdAt: string;
}

export interface AxisModel {
  axisId: string;
  centerX: number;
  centerY: number;
  angleDeg: number;
  fixedAtImageCenter: boolean;
  origin: "fitted" | "assumed-image-center";
}

export interface WarpControlPoint {
  controlPointId: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface FrameTransform {
  frameId: string;
  translationX: number;
  translationY: number;
  rotationDeg: number;
  scale: number;
  excluded: boolean;
  warp: WarpControlPoint[];
}

export interface PerFrameResidual {
  frameId: string;
  rmsePixels: number;
  pointCount: number;
  usedInComparison: boolean;
}

export type CandidateStrategy = "rigid" | "local-warp" | "rigid-exclude-bad";

export interface AlignmentCandidate {
  candidateId: string;
  archiveId: string;
  branchId: string;
  revisionId: string;
  rulesVersion: string;
  strategy: CandidateStrategy;
  label: string;
  axis: AxisModel;
  transforms: Record<string, FrameTransform>;
  validFrameIds: string[];
  excludedFrameIds: string[];
  perFrameResidual: Record<string, PerFrameResidual>;
  metrics: {
    totalRmsePixels: number;
    maxResidualPixels: number;
    validFrames: number;
    validPoints: number;
    warpEnergy: number;
    overfitPenalty: number;
    comparableScore: number;
  };
  diagnostics: Diagnostic[];
  ambiguityGroup: string | null;
  createdAt: string;
}

export type AdjudicationVerdict = "accepted" | "rejected";

export interface Adjudication {
  adjudicationId: string;
  candidateId: string;
  branchId: string;
  verdict: AdjudicationVerdict;
  note: string;
  createdAt: string;
  reverted: boolean;
}

export interface RegistrationLock {
  lockId: string;
  archiveId: string;
  branchId: string;
  candidateId: string;
  revisionId: string;
  rulesVersion: string;
  owner: string;
  createdAt: string;
  active: boolean;
}

export type JudgmentRule =
  | "axis-not-center-default"
  | "tracks-may-break-and-swap"
  | "same-valid-point-set"
  | "no-frame-count-tradeoff"
  | "keep-all-legal-solutions"
  | "no-irreversible-import-cleaning"
  | "invalidation-by-dependency"
  | "content-addressed-single-copy"
  | "stable-identity-acround-export";

export interface MachineBasis {
  rule: JudgmentRule;
  evidenceRefs: string[];
  decision: string;
}

export type EventType =
  | "archive.created"
  | "frame.ingested"
  | "source-revision.committed"
  | "rule.parameters-updated"
  | "candidates.computed"
  | "candidate.adjudicated"
  | "adjudication.reverted"
  | "registration.locked"
  | "registration.lock-released"
  | "branch.forked";

export interface DomainEvent<P = unknown> {
  eventId: string;
  archiveId: string;
  branchId: string;
  seq: number;
  type: EventType;
  actor: "reviewer" | "system" | "case-pack";
  basis: string;
  machineBasis: MachineBasis;
  refs: string[];
  createdAt: string;
  payload: P;
}

export interface BranchInfo {
  branchId: string;
  archiveId: string;
  name: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  createdAt: string;
}

export interface EntityRef {
  kind:
    | "frame"
    | "revision"
    | "track"
    | "candidate"
    | "adjudication"
    | "lock"
    | "event"
    | "branch"
    | "rules"
    | "frame-content";
  id: string;
}

export interface EntityResolution {
  ref: EntityRef;
  exists: boolean;
  versionIds: string[];
  contentDigest: string | null;
  summary: Record<string, unknown>;
  referrerEventIds: string[];
  corrupted: boolean;
  corruptionReason?: string;
}

export interface ArchiveState {
  archiveId: string;
  name: string;
  branches: BranchInfo[];
  revisionsByBranch: Record<string, SourceRevision[]>;
  candidatesByBranch: Record<string, AlignmentCandidate[]>;
  adjudications: Adjudication[];
  locks: RegistrationLock[];
  eventsByBranch: Record<string, DomainEvent[]>;
  rulesVersion: string;
  ruleHistory: { version: string; params: RuleParameters; eventId: string; changedAt: string }[];
}

export interface RuleParameters {
  assumeAxisAtImageCenter: boolean;
  allowTrackBreak: boolean;
  allowIdentitySwap: boolean;
  localWarpControlPoints: number;
  localWarpOverfitThreshold: number;
  badFrameResidualSigma: number;
  requireEqualValidPointsForComparison: boolean;
}

export const RULE_PARAMETERS_V1: RuleParameters = {
  assumeAxisAtImageCenter: false,
  allowTrackBreak: true,
  allowIdentitySwap: true,
  localWarpControlPoints: 4,
  localWarpOverfitThreshold: 1.5,
  badFrameResidualSigma: 2.5,
  requireEqualValidPointsForComparison: true
};

export const RULE_PARAMETERS_V2: RuleParameters = {
  ...RULE_PARAMETERS_V1,
  localWarpControlPoints: 6,
  localWarpOverfitThreshold: 1.2,
  badFrameResidualSigma: 2.0
};
