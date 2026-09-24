/**
 * 领域数据契约：电子断层 / 倾转序列 / 配准审阅。
 * 所有领域量都携带单位或坐标基准；原始表示在导入层保留，派生层才做规范化。
 */

export interface UnitValue<U extends string = string> {
  value: number;
  unit: U;
}

/** 无法转换的值：留在原位置并附诊断，不为画图而丢弃。 */
export interface UnconvertibleValue {
  raw: string;
  unit: string;
}

export type MaybeValue<U extends string = string> = UnitValue<U> | UnconvertibleValue;

export function isUnitValue(v: MaybeValue<string>): v is UnitValue {
  return typeof (v as UnitValue).value === 'number' && Number.isFinite((v as UnitValue).value);
}

/* ---------------------------------- 输入实体 ---------------------------------- */

export type EntityKind =
  | 'raw-frame-set'
  | 'tilt-angle-set'
  | 'pixel-size-calibration'
  | 'dose-record'
  | 'fiducial-coordinate-set'
  | 'tracking-gap-set'
  | 'manual-exclusion-set';

export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  'raw-frame-set': '原始帧',
  'tilt-angle-set': '倾角',
  'pixel-size-calibration': '像素尺度',
  'dose-record': '剂量',
  'fiducial-coordinate-set': '标记点坐标',
  'tracking-gap-set': '跟踪缺口',
  'manual-exclusion-set': '手工排除原因',
};

export interface FrameMeta {
  frameId: string;
  widthPx: number;
  heightPx: number;
  /** 原始帧像素内容的内容寻址摘要（演示数据为合成内容）。 */
  contentHash: string;
}

export interface RawFrameSetContent {
  kind: 'raw-frame-set';
  frames: FrameMeta[];
}

export interface TiltAngleEntry {
  frameId: string;
  /** 导入时保留原始表示；规范化在派生层完成。 */
  angle: MaybeValue<'deg'>;
}

export interface TiltAngleSetContent {
  kind: 'tilt-angle-set';
  expectedRange: { minDeg: number; maxDeg: number; stepDeg: number };
  angles: TiltAngleEntry[];
}

export interface PixelSizeCalibrationContent {
  kind: 'pixel-size-calibration';
  pixelSize: MaybeValue<'angstrom/pixel'>;
  detectorBasis: 'specimen-plane';
}

export interface DoseEntry {
  frameId: string;
  cumulativeDose: MaybeValue<'electron/angstrom^2'>;
}

export interface DoseRecordContent {
  kind: 'dose-record';
  doses: DoseEntry[];
}

export interface MarkerObservation {
  frameId: string;
  x: UnitValue<'pixel'>;
  y: UnitValue<'pixel'>;
}

export interface FiducialTrajectory {
  markerId: string;
  observations: MarkerObservation[];
}

export interface FiducialCoordinateSetContent {
  kind: 'fiducial-coordinate-set';
  coordinateBasis: 'image-pixel';
  trajectories: FiducialTrajectory[];
}

export interface TrackingGap {
  markerId: string;
  afterFrameId: string;
  resumeFrameId: string | null;
  reason: string;
}

export interface TrackingGapSetContent {
  kind: 'tracking-gap-set';
  gaps: TrackingGap[];
}

export interface ManualExclusion {
  frameId: string;
  reason: string;
  decidedBy: string;
}

export interface ManualExclusionSetContent {
  kind: 'manual-exclusion-set';
  exclusions: ManualExclusion[];
}

export type EntityContent =
  | RawFrameSetContent
  | TiltAngleSetContent
  | PixelSizeCalibrationContent
  | DoseRecordContent
  | FiducialCoordinateSetContent
  | TrackingGapSetContent
  | ManualExclusionSetContent;

/* ---------------------------------- 决定实体 ---------------------------------- */

export type CandidateModel = 'rigid' | 'local-deformation' | 'exclude-bad-frames';

export const CANDIDATE_MODEL_LABELS: Record<CandidateModel, string> = {
  rigid: '刚体',
  'local-deformation': '局部形变',
  'exclude-bad-frames': '排除坏帧',
};

export interface TiltAxisEstimate {
  /** 倾转轴相对图像中心的偏移；不允许默认固定为 0。 */
  offset: UnitValue<'pixel'>;
  angle: UnitValue<'deg'>;
  imageCenter: { x: UnitValue<'pixel'>; y: UnitValue<'pixel'> };
  estimatedFrom: 'fiducial-fit' | 'parameter';
}

export interface FrameResidual {
  frameId: string;
  rms: UnitValue<'pixel'>;
  pointCount: number;
}

export interface IdentitySwapHypothesis {
  markerA: string;
  markerB: string;
  atFrameId: string;
  confidence: number;
  adopted: boolean;
}

export interface TrajectoryBreak {
  markerId: string;
  afterFrameId: string;
  resumeFrameId: string | null;
  reason: string;
}

export interface EffectivePointRef {
  frameId: string;
  markerId: string;
}

export type CandidateStatus = 'proposed' | 'adopted' | 'rejected' | 'undecided' | 'stale';

export interface DependencyRef {
  entityId: string;
  version: number;
}

/* ---------------------------------- 复核实体 ---------------------------------- */

export interface ReviewFrameOverlay {
  frameId: string;
  tiltAngle: MaybeValue<'deg'>;
  dose: MaybeValue<'electron/angstrom^2'>;
  markers: { markerId: string; x: number; y: number }[];
}

export interface ReviewData {
  caseId: string;
  imageCenter: { x: number; y: number };
  overlay: ReviewFrameOverlay[];
  axis: TiltAxisEstimate | null;
  breaks: TrajectoryBreak[];
  candidates: CandidateSummary[];
  diagnostics: DiagnosticRecord[];
  lockedCandidateId: string | null;
}

export interface CandidateSummary {
  id: string;
  model: CandidateModel;
  version: number;
  status: CandidateStatus;
  axis: TiltAxisEstimate;
  residuals: FrameResidual[];
  effectivePointSet: EffectivePointRef[];
  pointSetKey: string;
  breaks: TrajectoryBreak[];
  swaps: IdentitySwapHypothesis[];
  dependsOn: DependencyRef[];
  staleReason: string | null;
}

export interface DiagnosticRecord {
  id: string;
  subjectId: string;
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  originalValue: unknown;
}

/* ---------------------------------- 事件 ---------------------------------- */

export type EventKind =
  | 'case_imported'
  | 'source_version_added'
  | 'invalidation_computed'
  | 'axis_not_centered'
  | 'identity_swap_hypothesis'
  | 'identity_swap_adopted'
  | 'missing_high_tilt_frames'
  | 'bad_frame_exclusion_branch'
  | 'fewer_frames_lower_residual_rejected'
  | 'local_deformation_overfit'
  | 'multiple_solutions_retained'
  | 'candidate_comparison'
  | 'adjudication'
  | 'adjudication_undone'
  | 'alignment_locked'
  | 'alignment_unlocked'
  | 'concurrent_save_conflict'
  | 'manual_decision_conflict'
  | 'unconvertible_value'
  | 'scenario_replay';

export interface EventRecord {
  id: string;
  caseId: string | null;
  seq: number;
  kind: EventKind;
  payload: Record<string, unknown>;
  dependsOn: DependencyRef[];
  createdAt: string;
}

/* ---------------------------------- 档案 ---------------------------------- */

export interface ArchiveBlob {
  hash: string;
  mediaType: string;
  content: string;
}

export interface ArchiveEntityVersion {
  version: number;
  blobHash: string;
  digest: string;
  summary: string;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export interface ArchiveEntity {
  id: string;
  kind: EntityKind;
  caseId: string;
  versions: ArchiveEntityVersion[];
}

export interface Archive {
  format: 'tilt-frame-chamber.archive/1';
  exportedAt: string;
  blobs: ArchiveBlob[];
  entities: ArchiveEntity[];
  candidates: unknown[];
  adjudications: unknown[];
  locks: unknown[];
  events: unknown[];
  diagnostics: unknown[];
}
