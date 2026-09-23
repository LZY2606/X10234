export type Unit =
  | 'deg'
  | 'pixel'
  | 'nm/pixel'
  | 'e-/A^2'
  | 'frame'
  | 'dimensionless'
  | 'text';

export interface Quantity {
  value: number | string | null;
  unit: Unit;
  raw: string | number;
  rawUnit: string;
  basis: string;
  convertible: boolean;
  diagnostics: string[];
}

export interface PointPx {
  x: number;
  y: number;
  frame: string;
  coordinateSystem: 'detector-pixels';
}

export interface MarkerObservation extends PointPx {
  markerId: string;
  segmentId: string;
  quality: number;
}

export interface TrackGap {
  markerId: string;
  missingFrameIds: string[];
  reason: 'occluded' | 'out-of-field' | 'tracking-lost' | 'excluded-frame' | 'not-acquired';
  note: string;
}

export interface ManualExclusion {
  frameId: string;
  reason: string;
  operator: string;
}

export interface FrameInput {
  frameId: string;
  index: number;
  planned: boolean;
  acquired: boolean;
  tiltAngleDeg: number;
  dose: number;
  blobSha: string | null;
  width: number;
  height: number;
}

export interface RawInputBundle {
  seriesId: string;
  name: string;
  frames: FrameInput[];
  tracks: Record<string, MarkerObservation[]>;
  gaps: TrackGap[];
  exclusions: ManualExclusion[];
  axisHintDeg: number | null;
  axisHintOffsetPx: number | null;
  truth: {
    axisAngleDeg: number;
    axisOffsetPx: { x: number; width: number };
    width: number;
    height: number;
  };
  notes: string;
}

export type RuleCode =
  | 'RULE_AXIS_NOT_CENTER'
  | 'RULE_TRACK_BREAKABLE_SWAPPABLE'
  | 'RULE_COMMON_VALID_POINT_SET'
  | 'RULE_NO_FRAME_DROPPING_FOR_RESIDUAL'
  | 'RULE_KEEP_ALL_LEGAL_CANDIDATES'
  | 'RULE_CONCURRENT_VERSION_CONFLICT'
  | 'RULE_NO_IRREVERSIBLE_CLEANUP'
  | 'RULE_UNITS_PRESERVED'
  | 'RULE_SCOPED_INVALIDATION'
  | 'RULE_DECISION_REVERSIBLE';

export interface CandidateReport {
  candidateId: string;
  kind:
    | 'rigid-free-axis'
    | 'rigid-center-fixed'
    | 'rigid-identity-swapped'
    | 'local-warp'
    | 'rigid-exclusion'
    | 'rigid-ambiguous';
  axisAngleDeg: number;
  axisOffsetPx: { x: number; y: number };
  frameResiduals: { frameId: string; rmsPx: number; observations: number }[];
  trainRmsPx: number;
  heldoutRmsPx: number;
  commonSetRmsPx: number;
  framesUsed: number;
  framesPlanned: number;
  observationsUsed: number;
  diagnostics: { code: RuleCode | string; severity: 'info' | 'warn' | 'fail'; message: string; refs?: string[] }[];
  legal: boolean;
  ambiguityPeaks?: { axisAngleDeg: number; rmsPx: number }[];
  basis: string[];
}
