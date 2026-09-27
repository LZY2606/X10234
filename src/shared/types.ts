// 领域数据契约：直接使用电子断层/倾转序列词汇，禁止压成 name/value。
// 所有领域量携带单位或坐标基准；原始表示在导入层保留，派生层才规范化。

export type Author = string;

// ---- 单位与坐标基准 ----
export type AngleUnit = 'deg' | 'rad' | 'unknown';
export type LengthUnit = 'nm' | 'um' | 'A' | 'pixel' | 'unknown';
export type PixelScaleUnit = 'nm_per_px' | 'A_per_px' | 'um_per_px' | 'unknown';
export type DoseUnit = 'e_per_nm2' | 'e_per_A2' | 'unknown';
export type CoordinateBasis =
  | 'frame_pixel_xy'        // 原始帧像素坐标，左上原点，x 右 y 下
  | 'stage_uncalibrated'    // 未标定台坐标系
  | 'reference_view_xy';    // 已配准到参考视图的坐标

export interface ConversionDiagnostic {
  code: 'UNCONVERTIBLE_UNIT' | 'UNPARSEABLE_NUMBER' | 'MISSING_BASIS';
  message: string;
  rawRepresentation: string;
}

export interface Angle {
  raw: string;
  unit: AngleUnit;
  normalizedDeg?: number;
  conversionDiagnostic?: ConversionDiagnostic;
}

export interface Length {
  raw: string;
  unit: LengthUnit;
  basis?: CoordinateBasis;
  normalizedNm?: number;
  conversionDiagnostic?: ConversionDiagnostic;
}

export interface PixelScale {
  raw: string;
  unit: PixelScaleUnit;
  normalizedNmPerPx?: number;
  conversionDiagnostic?: ConversionDiagnostic;
}

export interface Dose {
  raw: string;
  unit: DoseUnit;
  normalizedEPerNm2?: number;
  conversionDiagnostic?: ConversionDiagnostic;
}

// ---- 稳定引用：任何实体引用都必须含版本号，缺引用=损坏，不允许回退最新版 ----
export type Ref = string; // 'entity/{entityId}/v/{version}' 或 'blob/sha256/{hex}'

export type EntityKind =
  | 'tilt_series'
  | 'raw_frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'dose_measurement'
  | 'fiducial_coordinate'
  | 'tracking_gap'
  | 'manual_exclusion_reason'
  | 'tilt_axis'
  | 'track_fragment'
  | 'registration_candidate'
  | 'effective_point_set'
  | 'parameter_set'
  | 'adjudication'
  | 'registration_lock'
  | 'scenario_case'
  | 'import_manifest';

export type Origin = 'source' | 'derived' | 'decision';

export interface VersionedEntity<T = unknown> {
  entityId: string;
  version: number;
  kind: EntityKind;
  origin: Origin;
  value: T;
  refs: Ref[];
  contentDigest: string;
  createdAt: string;
  branchId: string;
  /** 由哪条事件写入，用于按事件回溯历史视图 */
  producedByEventSeq: number;
}

// ---- 输入实体 ----
export interface TiltSeries {
  seriesId: string;
  label: string;
  widthPx: number;
  heightPx: number;
  frameRefs: Ref[];          // 采集顺序稳定，不随解释改变
  acquisitionOrder: number[];
}

export interface RawFrameValue {
  frameIndex: number;
  acquisitionIndex: number;
  widthPx: number;
  heightPx: number;
  pixelsBlob: Ref;           // 内容寻址，不可变
  nominalDwellUs: number;
}

export interface TiltAngleValue {
  frame: Ref;
  angle: Angle;
  stageReported: boolean;
}

export interface PixelScaleValue {
  scope: 'series' | Ref;
  scale: PixelScale;
}

export interface DoseValue {
  frame: Ref;
  perExposure: Dose;
  cumulativeEPerNm2?: number;
}

export interface FiducialCoordinateValue {
  trackId: string;
  fragmentId: string;        // 轨迹可断裂：坐标属于某个片段
  frame: Ref;
  x: Length;
  y: Length;
  observed: boolean;         // false = 缺口推断位，不参与配准
}

export type GapReason = 'occluded' | 'out_of_field' | 'identity_ambiguous' | 'missing_frame';

export interface TrackingGapValue {
  trackId: string;
  fragmentIdBefore: string;
  fragmentIdAfter: string;
  frames: Ref[];
  reason: GapReason;
  /** 片段间可能的身份对应；identity_swap 场景下会出现多个候选对应 */
  possibleIdentityLinks: { fromFragment: string; toFragment: string; likelihood: number }[];
}

export interface ManualExclusionReasonValue {
  frame: Ref;
  reasonCode: 'drift_blur' | 'pre_damage' | 'beam_blocked' | 'acquisition_failure';
  note: string;
  author: Author;
}

// ---- 决定实体：倾转轴显式偏心 ----
export interface TiltAxisValue {
  /** 轴线与图像平面交点；不允许默认等于图像中心 */
  intersectionPx: { x: number; y: number };
  axisAngleDeg: number;
  angleBasis: CoordinateBasis;
  assumedCenter: { x: number; y: number };
  eccentricPx: number;       // 到图像中心距离，0 也必须显式记录
  evidence: Ref[];
}

export interface TrackFragmentValue {
  trackId: string;
  fragmentId: string;
  frames: Ref[];
  status: 'continuous' | 'broken' | 'identity_swapped';
  swapCounterpart?: { trackId: string; fragmentId: string };
}

export type RegistrationStrategy = 'rigid' | 'local_warp' | 'rigid_with_exclusions';

export interface FrameTransform {
  frame: Ref;
  // 参考视图坐标 = R(theta)*(x,y)+t 的相似变换
  rotationDeg: number;
  txPx: number;
  tyPx: number;
  scale: number;
}

export interface PointResidual {
  frame: Ref;
  trackId: string;
  residualPx: number;
  included: boolean;
}

export interface CandidateDiagnostic {
  code:
    | 'AXIS_ECCENTRIC'
    | 'IDENTITY_SWAP_SUSPECTED'
    | 'MISSING_HIGH_TILT_FRAME'
    | 'BAD_FRAME_EXCLUDED'
    | 'LOCAL_WARP_OVERFIT'
    | 'MULTIPLE_SOLUTIONS'
    | 'CONCURRENT_FREEZE'
    | 'NONCOMPARABLE_POINT_SETS'
    | 'STALE_DEPENDENCY';
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidenceRefs: Ref[];
}

export interface EffectivePointSet {
  pointSetDigest: string;
  frames: Ref[];
  points: { frame: Ref; trackId: string; fragmentId: string; xPx: number; yPx: number }[];
}

export interface RegistrationCandidateValue {
  candidateId: string;
  strategy: RegistrationStrategy;
  parameterSet: Ref;
  pointSet: Ref;
  axis: Ref;
  transforms: FrameTransform[];
  perFrameResidualPx: { frame: Ref; residualPx: number; included: boolean }[];
  pointResiduals: PointResidual[];
  rmsResidualPx: number;
  /** 与其它候选在共同有效点集上的比较结果 */
  comparisonBasisDigest?: string;
  excludedFrames: Ref[];
  diagnostics: CandidateDiagnostic[];
  status: 'legal' | 'rejected_overfit' | 'ambiguous' | 'invalid';
}

export interface ParameterSetValue {
  parameterSetId: string;
  label: string;
  rigidModel: 'similarity2d';
  localWarpGrid: number;          // 每维网格数
  overfitDoFRatio: number;        // 自由度/观测数阈值
  exclusionResidualSigma: number;
  axisMayBeEccentric: true;       // 规则：轴线不默认居中
  allowFragmentIdentitySwap: true;
}

export type AdjudicationAction = 'accept' | 'reject' | 'revise_parameters' | 'reopen';

export interface AdjudicationValue {
  candidate?: Ref;
  action: AdjudicationAction;
  rationale: string;
  ruleCitations: string[];
  author: Author;
  supersededBy?: Ref;
}

export interface RegistrationLockValue {
  candidate: Ref;
  series: Ref;
  reconstructionRef: string;      // 供重建读回的稳定句柄
  revoked: boolean;
}

// ---- 反例档案场景 ----
export type ScenarioCode =
  | 'axis_eccentric'
  | 'track_identity_swap'
  | 'missing_high_tilt'
  | 'bad_frame_exclusion'
  | 'local_warp_overfit'
  | 'multiple_solutions'
  | 'concurrent_freeze';

export interface ScenarioCaseValue {
  scenario: ScenarioCode;
  minimalInputRefs: Ref[];
  combinedInputRefs: Ref[];
  sharedBlobRefs: Ref[];          // 最小输入与组合输入共享的不可变片段
  adoptedResultRef?: Ref;
  rejectedResultRefs: Ref[];      // 未采纳结果同样保留
  expectedInvalidationScope: { kind: EntityKind; entityIdContains: string }[];
}

// ---- 事件 ----
export type EventType =
  | 'source.committed'
  | 'import.rolled_back'
  | 'interpretation.branched'
  | 'candidate.produced'
  | 'rule.evaluated'
  | 'scenario.replayed'
  | 'adjudication.decided'
  | 'registration.locked'
  | 'registration.lock_revoked'
  | 'parameter.revised'
  | 'dependency.invalidated'
  | 'conflict.detected'
  | 'archive.exported'
  | 'archive.imported';

export interface RuleEvaluationPayload {
  ruleId:
    | 'tilt_axis_not_centered'
    | 'fiducial_track_can_break_and_swap'
    | 'candidates_compare_same_effective_points'
    | 'no_fewer_frames_for_lower_residual';
  verdict: 'holds' | 'violated' | 'ambiguous';
  subjectRefs: Ref[];
  evidence: Record<string, unknown>;
}

export interface TimelineEvent {
  seq: number;
  type: EventType;
  branchId: string;
  author: Author;
  at: string;
  payload: unknown;
  refs: Ref[];
  prevDigest: string;
  digest: string;
}

// ---- 分支 ----
export interface Branch {
  branchId: string;
  name: string;
  parentBranchId?: string;
  forkFromSeq: number;
  headSeq: number;
}

// ---- 损坏 ----
export class CorruptReferenceError extends Error {
  constructor(public missingRef: Ref, public accessedFrom: Ref | null) {
    super(`损坏的引用：${missingRef} 不存在（访问自 ${accessedFrom ?? 'query'}）；禁止回退到最新版`);
    this.name = 'CorruptReferenceError';
  }
}

export interface ImportDiagnostic {
  path: string;
  diagnostic: ConversionDiagnostic;
}
