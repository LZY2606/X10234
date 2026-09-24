/**
 * 倾转帧拼合室 —— 领域数据契约
 *
 * 词汇直接来自电子断层 tilt-series 工作组，不压成 name/value。
 * 所有领域量携带单位或坐标基准；导入层保留 raw 表示，派生层才规范化。
 */

// ---------------------------------------------------------------------------
// 单位 / 坐标基准
// ---------------------------------------------------------------------------

/** 角度单位；导入时保留原表示 */
export type AngleUnit = 'degree' | 'radian';
/** 像素尺度单位 */
export type PixelScaleUnit = 'nm_per_pixel' | 'angstrom_per_pixel' | 'um_per_pixel';
/** 剂量单位 */
export type DoseUnit = 'e_per_A2' | 'e_per_nm2';
/** 图像坐标基准（像素原点） */
export type CoordinateFrame =
  | 'pixel_top_left'
  | 'pixel_center';

/** 带单位的量。raw 是导入时的原始表示（可能是字符串/表达式），value 是规范化数值；无法转换时 value 为 null 并附 diagnostic */
export interface Quantified<V extends number = number> {
  /** 原始表示，永远保留，用于反查来源 */
  raw: string | number;
  /** 规范化后的数值（标准单位）；无法转换时为 null */
  value: V | null;
  /** 原始单位 */
  unit: string;
  /** 无法转换时的诊断信息 */
  diagnostic?: string;
}

export interface PixelScale {
  x: Quantified;
  y: Quantified;
  unit: PixelScaleUnit;
  /** 尺度生效的基准面 */
  coordinateFrame: CoordinateFrame;
}

export interface AngleQuantity {
  raw: string | number;
  value: number | null;
  unit: AngleUnit;
  diagnostic?: string;
}

export interface DoseQuantity {
  raw: string | number;
  value: number | null;
  unit: DoseUnit;
  diagnostic?: string;
}

// ---------------------------------------------------------------------------
// 输入实体（来源层，全部版本化、不可变）
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'tilt_series'
  | 'tilt_frame'
  | 'pixel_scale'
  | 'dose'
  | 'fiducial_marker'
  | 'marker_observation'
  | 'tracking_gap'
  | 'manual_exclusion';

export interface TiltSeries {
  kind: 'tilt_series';
  /** 稳定逻辑身份，导入时由来源/槽位决定，重导入保持不变 */
  seriesId: string;
  label: string;
  /** 图像尺寸（像素） */
  imageWidthPx: number;
  imageHeightPx: number;
  coordinateFrame: CoordinateFrame;
  /** 倾转角序列（升/降序按导入），与帧一一对应 */
  tiltAngles: AngleQuantity[];
  /** 帧顺序的槽位索引 0..n-1 */
  frameOrder: string[];
}

export interface TiltFrame {
  kind: 'tilt_frame';
  frameId: string;
  seriesId: string;
  /** 在序列中的槽位（稳定顺序身份） */
  slot: number;
  tiltAngle: AngleQuantity;
  /** 帧像素内容的内容寻址 blob 引用 */
  blobSha256: string;
  /** 原始文件名/来源片段标识 */
  sourcePath: string;
  widthPx: number;
  heightPx: number;
  /** 原始像素编码描述，blob 是原始字节；渲染层才解码 */
  encoding: 'raw_u8';
}

export interface PixelScaleRecord {
  kind: 'pixel_scale';
  pixelScaleId: string;
  seriesId: string;
  scale: PixelScale;
  /** 该尺度对哪些帧生效（槽位）；空表示全序列 */
  appliesToSlots: number[];
}

export interface DoseRecord {
  kind: 'dose';
  doseId: string;
  seriesId: string;
  slot: number;
  /** 该帧曝光剂量（累积或帧剂量由 exposureType 说明） */
  exposure: DoseQuantity;
  exposureType: 'per_frame' | 'cumulative';
}

/** fiducial 标记的物理身份（跨帧）。轨迹可断裂、身份可能交换 */
export interface FiducialMarker {
  kind: 'fiducial_marker';
  markerId: string;
  seriesId: string;
  /** 导入时的物理标签（如金颗粒编号），可能与轨迹身份冲突 */
  physicalLabel: string;
  note?: string;
}

/** 标记在某帧上的一次观测（轨迹点） */
export interface MarkerObservation {
  kind: 'marker_observation';
  observationId: string;
  seriesId: string;
  markerId: string;
  slot: number;
  /** 像素坐标，保留原始表示 */
  x: Quantified;
  y: Quantified;
  /** 观测坐标基准 */
  coordinateFrame: CoordinateFrame;
  /** 该观测是否被导入方标注为低置信 */
  lowConfidence?: boolean;
}

/** 跟踪缺口：某 marker 在某槽位区间没有观测（轨迹可断裂） */
export interface TrackingGap {
  kind: 'tracking_gap';
  gapId: string;
  seriesId: string;
  markerId: string;
  /** 缺口覆盖的槽位（闭区间） */
  fromSlot: number;
  toSlot: number;
  reason: string;
}

/** 手工排除某帧/某观测的原因（版本化，不直接删除来源） */
export interface ManualExclusion {
  kind: 'manual_exclusion';
  exclusionId: string;
  seriesId: string;
  target:
    | { type: 'frame'; slot: number }
    | { type: 'observation'; observationId: string };
  reason: string;
  /** 提出人/来源 */
  author: string;
  /** 排除决定本身也可被后续撤销，但撤销是新事件，不改本记录 */
  proposedAt: string;
}

export type SourceEntity =
  | TiltSeries
  | TiltFrame
  | PixelScaleRecord
  | DoseRecord
  | FiducialMarker
  | MarkerObservation
  | TrackingGap
  | ManualExclusion;

// ---------------------------------------------------------------------------
// 派生实体（解释层，引用具体来源版本）
// ---------------------------------------------------------------------------

export type DerivedKind =
  | 'interpretation_branch'
  | 'parameter_set'
  | 'trajectory_model'
  | 'tilt_axis_model'
  | 'registration_candidate'
  | 'frame_residual';

/** 轨迹片段：断裂的轨迹由多个片段组成，片段可发生身份交换重指 */
export interface TrajectoryFragment {
  markerId: string;
  /** 片段起始/结束槽位 */
  startSlot: number;
  endSlot: number;
  /** 本片段观测点 */
  observationIds: string[];
  /** 与相邻片段是否存在身份交换标记 */
  identitySwapWith: string | null;
  /** 交换置信诊断 */
  swapScore: number | null;
}

export interface TrajectoryModel {
  kind: 'trajectory_model';
  trajectoryId: string;
  branchId: string;
  fragments: TrajectoryFragment[];
  /** 未被任何片段覆盖的观测（疑似交换/离群） */
  orphanObservationIds: string[];
}

/**
 * 倾转轴模型。轴在图像中有位置与方向 —— 不默认固定在图像中心。
 * 坐标基准为 pixel_center。
 */
export interface TiltAxisModel {
  kind: 'tilt_axis_model';
  axisId: string;
  branchId: string;
  /** 轴经过点（像素） */
  interceptX: number;
  interceptY: number;
  /** 轴方向角（度，图像坐标，0=沿 x 轴） */
  angleDeg: number;
  /** 拟合不确定性（度 / 像素），高倾角缺失时上升 */
  angleUncertaintyDeg: number;
  /** 方向是否存在镜像多解（±角度等残差） */
  orientationAmbiguous: boolean;
  /** 高倾角覆盖比例 [0,1] */
  highTiltCoverage: number;
  /** 拟合所用有效观测集合指纹（公平比较用） */
  effectivePointFingerprint: string;
}

export type RegistrationMethod = 'rigid' | 'local_warp' | 'rigid_with_bad_frame_excluded';

/** 候选配准：刚体 / 局部形变 / 排除坏帧，全部显式保留 */
export interface RegistrationCandidate {
  kind: 'registration_candidate';
  candidateId: string;
  branchId: string;
  method: RegistrationMethod;
  /** 有效帧槽位集合（被排除帧不含） */
  effectiveSlots: number[];
  /** 有效观测点集合指纹：不同候选必须用相同有效点集比较 */
  effectivePointFingerprint: string;
  /** 被该候选排除的槽位及原因 */
  excludedSlots: { slot: number; reason: string }[];
  /** 模型自由度（局部形变更高，过拟合检测用） */
  degreesOfFreedom: number;
  /** 全点集（公平基准）RMS 残差（像素），不因删点而降低 */
  residualRmsAllPoints: number;
  /** 有效点集 RMS 残差 */
  residualRmsEffective: number;
  /** 交叉验证 RMS（留出点），局部形变过拟合时显著偏高 */
  crossValidationRms: number;
  /** 是否公平：用少于其他候选的有效点换取低残差 => false */
  fairComparison: boolean;
  /** 过拟合标记：自由度高且 CV 残差显著上升 */
  overfit: boolean;
  /** 平局组：多个合法候选同残差同点集时不可独选 */
  ambiguityGroupId: string | null;
  /** 诊断信息 */
  diagnostics: string[];
  /** 每个有效帧的 2D 刚体参数（局部形变额外有变形系数） */
  frameTransforms: Record<
    number,
    { tx: number; ty: number; rotationDeg: number; scale: number; warpCoeffs?: number[] }
  >;
}

export interface FrameResidual {
  kind: 'frame_residual';
  residualId: string;
  candidateId: string;
  branchId: string;
  slot: number;
  rms: number;
  max: number;
  pointCount: number;
  /** 是否被本候选排除 */
  excluded: boolean;
  perMarker: { markerId: string; residual: number }[];
}

export interface ParameterSet {
  kind: 'parameter_set';
  parameterSetId: string;
  branchId: string;
  /** 高倾角阈值（度） */
  highTiltThresholdDeg: number;
  /** 过拟合判定阈值：CV-RMS / train-RMS 倍数 */
  overfitCvRatio: number;
  /** 身份交换判定阈值（像素） */
  swapScoreThreshold: number;
  /** 坏帧残差倍数（相对中位数） */
  badFrameRmsRatio: number;
  note: string;
}

export interface InterpretationBranch {
  kind: 'interpretation_branch';
  branchId: string;
  seriesId: string;
  /** 父分支（重新解释时新建分支，不覆盖旧分支） */
  parentBranchId: string | null;
  label: string;
  createdAt: string;
  /** 该分支冻结时引用的来源版本集合（seriesId -> revisionId） */
  sourceRevisionRefs: Record<string, string>;
  /** 规则版本 */
  rulesVersion: string;
  parameterSetId: string;
  /** 是否已锁定供重建引用 */
  lockedCandidateId: string | null;
}

export type DerivedEntity =
  | InterpretationBranch
  | ParameterSet
  | TrajectoryModel
  | TiltAxisModel
  | RegistrationCandidate
  | FrameResidual;

// ---------------------------------------------------------------------------
// 裁定 / 事件（append-only）
// ---------------------------------------------------------------------------

export type EventType =
  | 'series_imported'
  | 'source_revised'
  | 'import_failed_rollback'
  | 'branch_created'
  | 'parameter_revision'
  | 'local_source_change'
  | 'trajectory_identity_swap_detected'
  | 'trajectory_gap_recorded'
  | 'tilt_axis_offset'
  | 'missing_high_tilt_frames'
  | 'bad_frame_excluded'
  | 'local_warp_overfit'
  | 'multiple_solutions_retained'
  | 'candidates_compared'
  | 'candidate_accepted'
  | 'candidate_rejected'
  | 'registration_locked'
  | 'lock_revoked'
  | 'decision_conflict'
  | 'concurrent_freeze'
  | 'decision_undone'
  | 'derived_invalidated'
  | 'archive_exported'
  | 'archive_imported';

/** 机器可读的判断依据条目 */
export interface RuleJudgement {
  ruleCode: string;
  passed: boolean;
  detail: Record<string, unknown>;
}

export interface ReviewEvent {
  eventId: string;
  seq: number;
  type: EventType;
  branchId: string | null;
  seriesId: string | null;
  /** 事件发生时引用的来源版本号（不可退回最新版） */
  sourceRevisionRefs: Record<string, string>;
  /** 事件发生时的规则版本 */
  rulesVersion: string;
  /** 事件产出/引用的实体及其版本 */
  entityRefs: { kind: EntityKind | DerivedKind; stableId: string; revision: string }[];
  /** 机器可读判断依据 */
  judgements: RuleJudgement[];
  /** 受影响对象（失效范围） */
  affectedRefs: string[];
  /** 作者/会话 */
  actor: string;
  note: string;
  timestamp: string;
  /** 前一事件哈希，形成链 */
  prevHash: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// 查询返回：稳定身份 + 版本 + 内容摘要
// ---------------------------------------------------------------------------

export interface EntityEnvelope<T = SourceEntity | DerivedEntity> {
  kind: EntityKind | DerivedKind;
  stableId: string;
  revision: string;
  contentSha256: string;
  /** 该实体引用的全部版本号与内容摘要（缺失引用 => CORRUPTED_REF） */
  refs: { kind: string; stableId: string; revision: string; contentSha256: string }[];
  digest: string;
  payload: T;
  /** 是否已因依赖变化而失效（不删除，标记 superseded/invalid） */
  status: 'active' | 'invalidated';
}

export interface SnapshotBundle {
  format: 'tilt-stitch-room-archive';
  formatVersion: 2;
  exportedAt: string;
  rulesVersion: string;
  sourceEntities: { revision: string; contentSha256: string; entity: SourceEntity }[];
  derivedEntities: { revision: string; contentSha256: string; entity: DerivedEntity }[];
  events: ReviewEvent[];
  blobs: { sha256: string; bytesBase64: string }[];
}
