/** 领域词汇：直接采用电子断层 / 倾转序列 / 配准的术语，不压成 name/value。 */

export type SourceKind =
  | 'raw_frames'
  | 'tilt_angles'
  | 'pixel_size'
  | 'dose'
  | 'fiducial_coordinates'
  | 'tracking_gaps'
  | 'manual_exclusions';

export const SOURCE_KINDS: SourceKind[] = [
  'raw_frames',
  'tilt_angles',
  'pixel_size',
  'dose',
  'fiducial_coordinates',
  'tracking_gaps',
  'manual_exclusions',
];

export type AlignmentModel = 'rigid' | 'local_deformation' | 'exclude_bad_frames';

export type CandidateStatus =
  | 'proposed'
  | 'adopted'
  | 'rejected'
  | 'undecidable'
  | 'stale';

export interface TiltAxis {
  x_offset_px: number;
  angle_deg: number;
  basis: 'image_px_origin_top_left';
}

export interface FiducialPoint {
  frame: number;
  x: number;
  y: number;
}

export interface FiducialTrajectory {
  trajId: string;
  points: FiducialPoint[];
}

export interface TrackingGap {
  trajId: string;
  fromFrame: number;
  toFrame: number;
}

export interface ManualExclusion {
  frame: number;
  reason: string;
}

export interface IdentitySwap {
  frame: number;
  trajA: string;
  trajB: string;
}

export interface SolverInput {
  frames: { id: string; index: number }[];
  tiltAnglesDeg: number[];
  pixelSizeNm: number | null;
  dosePerFrame: (number | null)[];
  fiducials: FiducialTrajectory[];
  gaps: TrackingGap[];
  exclusions: ManualExclusion[];
  identitySwaps: IdentitySwap[];
  imageCenterX: number;
}

export interface SolverParams {
  model: AlignmentModel;
  regularization?: number;
}

export interface FrameResidual {
  frame: number;
  residual: number;
  pointsUsed: number;
}

export interface CandidateResult {
  model: AlignmentModel;
  tiltAxis: TiltAxis | null;
  effectivePointSet: string[];
  perFrameResiduals: FrameResidual[];
  totalResidual: number;
  diagnostics: string[];
  identitySwapsApplied: IdentitySwap[];
  alternativeAxes?: TiltAxis[];
}

export const RULE_IDS = {
  axisNotCentered: 'axis_not_defaulted_to_center',
  trajectoryBreakSwap: 'trajectory_break_and_identity_swap',
  sameEffectivePointSet: 'same_effective_point_set_comparison',
} as const;

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

export const SCENARIOS = [
  'axis_eccentric',
  'trajectory_identity_swap',
  'missing_high_tilt_frames',
  'bad_frame_exclusion',
  'local_deformation_overfit',
  'multiple_solutions',
  'concurrent_freeze',
] as const;

export type Scenario = (typeof SCENARIOS)[number];
