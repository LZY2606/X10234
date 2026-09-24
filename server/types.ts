// Domain vocabulary for the tilt-series alignment review tool.
// Domain terms are first-class fields, never flattened into name/value pairs.

export type Vec2 = { x: number; y: number };

export interface TiltAxis {
  /** in-plane angle of the tilt axis, degrees */
  angleDeg: number;
  /** perpendicular offset of the axis from the image center, pixels */
  offsetPx: number;
}

export interface FiducialPoint {
  trackId: string;
  frameIndex: number;
  /** observed marker coordinate in detector pixels */
  positionPx: Vec2;
}

export interface TrackGap {
  trackId: string;
  fromFrame: number;
  toFrame: number;
  reason: string;
}

export interface ManualExclusion {
  frameIndex: number;
  reason: string;
  decidedBy: string;
}

export interface TiltSeriesSource {
  seriesId: string;
  /** detector pixel size, nanometres */
  pixelSizeNm: number;
  /** nominal tilt axis as imported; may be overridden by estimation */
  nominalAxis: TiltAxis;
  frames: TiltFrame[];
  fiducialPoints: FiducialPoint[];
  trackGaps: TrackGap[];
  manualExclusions: ManualExclusion[];
}

export interface TiltFrame {
  index: number;
  tiltAngleDeg: number;
  /** accumulated electron dose, e-/A^2 */
  doseEPerA2: number;
  /** sha256 digest of the immutable raw frame bytes */
  frameDigest: string;
  width: number;
  height: number;
}

export type AlignmentMethod = 'rigid' | 'local-warp' | 'bad-frame-exclusion';

export interface AlignmentParams {
  method: AlignmentMethod;
  /** whether the tilt axis may move away from the image center */
  allowAxisOffset: boolean;
  /** frames excluded by this candidate's own policy */
  excludedFrames: number[];
  /** number of local warp patches (local-warp only) */
  warpPatches?: number;
  /** fiducial identity remap applied on top of the source tracks */
  identityRemap?: Record<string, string>;
}

export interface FrameResidual {
  frameIndex: number;
  rmsPx: number;
  maxPx: number;
  pointsUsed: number;
}

export interface AlignmentCandidate {
  candidateId: string;
  params: AlignmentParams;
  estimatedAxis: TiltAxis;
  /** frames actually contributing to the fit */
  effectiveFrames: number[];
  /** fiducial tracks actually used, after gap/swap handling */
  effectiveTracks: string[];
  perFrameResiduals: FrameResidual[];
  rmsAllPx: number;
  /** RMS computed on the shared effective point set, for fair comparison */
  rmsSharedPx: number | null;
  overfitPenalty: number;
  diagnostics: string[];
}

export type AdjudicationState = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface EntityRef {
  entityId: string;
  version: number;
}

export interface DomainEvent {
  eventId: string;
  seq: number;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface EntityVersion {
  entityId: string;
  version: number;
  kind: string;
  contentDigest: string;
  summary: string;
  payload: unknown;
  refs: EntityRef[];
  createdByEvent: string;
}

export interface VersionConflict {
  entityId: string;
  baseVersion: number;
  currentVersion: number;
  local: unknown;
  current: unknown;
}
