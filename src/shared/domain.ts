export type Uid = string;

/**
 * 所有领域量都携带单位或坐标基准。
 * raw 保留原始表示；value 是派生层规范化结果；无法转换时 value 缺失并带 diagnostic，
 * 异常值留在原位置，不为了画图而丢弃。
 */
export interface Measured {
  raw: string;
  value: number | null;
  unit: string;
  basis: string;
  diagnostic?: string;
}

export type EntityKind =
  | "frame"
  | "tilt_observation"
  | "pixel_scale"
  | "dose_observation"
  | "fiducial_point"
  | "track_gap"
  | "missing_frame"
  | "manual_exclusion"
  | "track"
  | "track_segment"
  | "track_link"
  | "axis_estimate"
  | "registration_candidate"
  | "adjudication"
  | "registration_lock"
  | "invalidation";

export const SOURCE_KINDS = [
  "frame",
  "tilt_observation",
  "pixel_scale",
  "dose_observation",
  "fiducial_point",
  "track_gap",
  "missing_frame",
  "manual_exclusion",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const INTERPRETATION_KINDS = [
  "track",
  "track_segment",
  "track_link",
  "axis_estimate",
  "registration_candidate",
  "adjudication",
  "registration_lock",
  "invalidation",
] as const;

export interface Vec2 {
  x: number;
  y: number;
}

/** 机器可读判断依据 */
export interface Judgment {
  code: JudgmentCode;
  ruleVersion: string;
  evidence: string[];
  refIds: Uid[];
}

export type JudgmentCode =
  | "AXIS_NOT_CENTER"
  | "AXIS_AMBIGUITY_KEPT"
  | "TRACK_BROKEN"
  | "TRACK_IDENTITY_SWAP"
  | "SAME_EFFECTIVE_POINT_SET"
  | "FEWER_FRAMES_NO_LOWER_RESIDUAL_ADVANTAGE"
  | "MISSING_HIGH_TILT_FRAME"
  | "BAD_FRAME_EXCLUDED"
  | "LOCAL_WARP_OVERFIT"
  | "MULTIPLE_LEGAL_CANDIDATES"
  | "CONCURRENT_FREEZE_CONFLICT"
  | "UNCONVERTIBLE_VALUE_KEPT"
  | "IMPORT_ROLLBACK"
  | "DEPENDENCY_SCOPED_INVALIDATION";

export interface Ref {
  kind: EntityKind;
  id: Uid;
  version: number;
  relation: "depends" | "revises" | "locks" | "compares" | "links" | "rejects";
}

export interface EventEnvelope<T = unknown> {
  eventId: Uid;
  branchId: Uid;
  seq: number;
  type: string;
  at: string;
  actor: string;
  basis: { ruleVersion: string; judgments: Judgment[] };
  refs: Ref[];
  payload: T;
}

export interface CandidateMetrics {
  rms: number;
  maxPerFrameResidual: number;
  coverage: number;
  validFrameCount: number;
  totalFrameCount: number;
  validPointCount: number;
  crossValRms: number | null;
  dof: number;
}

export interface PerFrameResidual {
  frameId: Uid;
  index: number;
  tiltDeg: number | null;
  excluded: boolean;
  rms: number | null;
  drift: Vec2 | null;
}

export interface RegistrationCandidatePayload {
  candidateId: Uid;
  strategy: "rigid" | "local_warp" | "exclude_bad_frames";
  label: string;
  axisId: Uid;
  axis: { angleDeg: number; offset: Vec2; centerAssumed: false; eccentricityPx: number };
  validFrameIds: Uid[];
  excludedFrameIds: Uid[];
  validPointIds: Uid[];
  transforms: Record<Uid, { drift: Vec2 }>;
  metrics: CandidateMetrics;
  flags: string[];
  residualByFrame: PerFrameResidual[];
  ambiguityGroup?: string;
}

export interface CandidateDiff {
  aCandidateId: Uid;
  bCandidateId: Uid;
  commonFrameIds: Uid[];
  commonPointIds: Uid[];
  sameEffectivePointSet: boolean;
  rmsOnCommon: { a: number; b: number } | null;
  coverage: { a: number; b: number };
  comparable: boolean;
  note: string;
}
