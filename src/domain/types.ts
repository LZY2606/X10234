/**
 * 倾转帧拼合室 领域数据契约
 *
 * 输入实体（来源层，全部版本化、不可变、保留原始表示）：
 *   RawFrame / TiltAngle / PixelScale / Dose / FiducialObservation / TrackGap / ManualExclusionReason
 * 决定实体（解释层）：
 *   TiltAxisModel / TrackFragment / TrackLinkHypothesis / EffectivePointSet / RegistrationCandidate
 * 复核实体：
 *   Adjudication
 * 所有领域量都携带单位或坐标基准。
 */

export type EntityKind =
  | 'material'
  | 'revision'
  | 'raw_frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'dose'
  | 'fiducial_observation'
  | 'track_gap'
  | 'manual_exclusion_reason'
  | 'tilt_axis_model'
  | 'track_fragment'
  | 'track_link_hypothesis'
  | 'effective_point_set'
  | 'registration_candidate'
  | 'adjudication'
  | 'event';

export interface StableId {
  kind: EntityKind;
  key: string;
}

export function sid(kind: EntityKind, key: string): string {
  return `${kind}/${key}`;
}

/** 带坐标基准/单位的量。raw 保留导入时的原始表示；派生层才规范化。 */
export interface Dimensioned {
  value: number | string;
  unit: string;
  /** 规范化后的值与单位（可选）；无法转换时为空并在 diagnostics 记录 */
  normalized?: { value: number; unit: string };
  rawRepresentation: string;
}

/** 像素坐标基准：(0,0) 在左上角，x 向右、y 向下，单位 px */
export interface PixelPoint {
  x: number;
  y: number;
  frame: string;
  basis: 'image_px_top_left';
}

export interface FrameGeometry {
  widthPx: number;
  heightPx: number;
}

export interface RawFrame {
  frameId: string;
  revisionId: string;
  index: number;
  blobId: string;
  sha256: string;
  widthPx: number;
  heightPx: number;
  encoding: string;
  /** 导入原始记录 */
  raw: Record<string, unknown>;
}

export interface TiltAngle {
  angleId: string;
  revisionId: string;
  frameId: string;
  angle: Dimensioned; // unit: degree
  /** 角度递增方向约定，默认 +y 旋转 */
  signConvention: 'ccw_positive_in_xy';
}

export interface PixelScale {
  scaleId: string;
  revisionId: string;
  frameId?: string; // 缺省表示全序列统一尺度
  scale: Dimensioned; // unit: nm_per_px
}

export interface Dose {
  doseId: string;
  revisionId: string;
  frameId: string;
  electronsPerAngstrom2: Dimensioned; // unit: e-/Å²
  cumulative: Dimensioned;
}

/**
 * 跟踪器对某颗 fiducial 在某帧上的观测。
 * observedTrackId 是跟踪器给的标签；标签可在相邻片段间发生身份交换（swap），
 * 真实身份由 track_link_hypothesis 在解释层裁定，导入层不做不可逆清洗。
 */
export interface FiducialObservation {
  observationId: string;
  revisionId: string;
  frameId: string;
  observedTrackId: string;
  point: PixelPoint;
  uncertaintyPx?: number;
  raw: Record<string, unknown>;
}

/** 轨迹断裂：记录某条观测标签在某帧区间内无法跟踪，而非把点删掉。 */
export interface TrackGap {
  gapId: string;
  revisionId: string;
  observedTrackId: string;
  missingFrameIds: string[];
  reason: string;
  raw: Record<string, unknown>;
}

/** 人工排除原因必须落盘、版本化；排除不等于删除原始帧。 */
export interface ManualExclusionReason {
  reasonId: string;
  revisionId: string;
  frameId: string;
  reason: string;
  author: string;
  raw: Record<string, unknown>;
}

/**
 * 倾转轴模型。
 * 关键决定：axis 不默认固定在图像中心。
 * 图像中心 = 初始猜测；(pivotX, pivotY)、角度 angleRad、不确定度必须由数据估计。
 */
export interface TiltAxisModel {
  axisId: string;
  revisionId: string;
  branchId: string;
  /** 轴在图像坐标系中穿过的点，px */
  pivotXPx: number;
  pivotYPx: number;
  /** 轴方向角（相对图像 y 轴），rad */
  angleRad: number;
  assumedCenterXPx: number;
  assumedCenterYPx: number;
  /** 相对图像中心的偏心，px */
  eccentricityXPx: number;
  eccentricityYPx: number;
  fitDiagnostics: string[];
  basedOn: string[]; // 引用的 observation / 事件稳定身份
}

/** 轨迹片段：同一物理 fiducial 在连续帧上的一段可信观测。轨迹可断裂。 */
export interface TrackFragment {
  fragmentId: string;
  revisionId: string;
  branchId: string;
  physicalTrackId: string;
  frameIds: string[];
  observationIds: string[];
  broken: boolean;
}

/**
 * 轨迹连接假设：显式保存“标签一致”和“身份交换”两种解释，
 * 无法唯一决定时保留全部合法候选，导入时不静默改写标签。
 */
export interface TrackLinkHypothesis {
  hypothesisId: string;
  revisionId: string;
  branchId: string;
  kind: 'identity' | 'swap';
  fragmentA: string;
  fragmentB: string;
  /** swap 时：observedTrackId -> physicalTrackId */
  relabel: Record<string, string>;
  evidence: number; // 轨迹连续性代价，越小越可信
  accepted: boolean;
}

export type RegistrationStrategy = 'rigid' | 'local_warp' | 'rigid_excluding_bad_frames';

export type FrameExclusionKind = 'none' | 'missing' | 'manual' | 'bad_frame_diagnosed';

/**
 * 有效点集：不同候选必须使用相同的有效点集比较。
 * “排除坏帧”候选必须单独声明它用的帧子集，且报告帧数差异，
 * 不能用少帧换低残差。
 */
export interface EffectivePointSet {
  pointSetId: string;
  revisionId: string;
  branchId: string;
  observationIds: string[];
  frameIds: string[];
  excludedFrames: { frameId: string; kind: FrameExclusionKind; reason: string }[];
  frameCount: number;
  pointCount: number;
}

export interface PerFrameResidual {
  frameId: string;
  rmsPx: number;
  maxPx: number;
  usedPoints: number;
  excluded: FrameExclusionKind;
}

export interface RegistrationCandidate {
  candidateId: string;
  revisionId: string;
  branchId: string;
  strategy: RegistrationStrategy;
  pointSetId: string;
  /** 每帧仿射/刚体参数：帧 -> {a,b,c,d,e,f}，映射 fiducial 坐标到参考帧 */
  frameTransforms: Record<string, AffineLike>;
  perFrameResidual: PerFrameResidual[];
  aggregateRmsPx: number;
  aggregateMaxPx: number;
  /** 与基准点集对比时的公平残差（相同有效点集上） */
  fairRmsPxOnBaselineSet?: number;
  degreesOfFreedom: number;
  overfit: boolean;
  overfitDiagnostics: string[];
  degeneracyDiagnostics: string[];
  basedOn: string[];
}

export interface AffineLike {
  a: number; b: number; c: number;
  d: number; e: number; f: number;
}

export type AdjudicationVerdict = 'accepted' | 'rejected';

export interface Adjudication {
  adjudicationId: string;
  revisionId: string;
  branchId: string;
  candidateId: string;
  verdict: AdjudicationVerdict;
  note: string;
  author: string;
  /** 被锁定供重建引用的候选；同一材料至多一个 locked（新锁定撤销旧锁定） */
  lockedForReconstruction: boolean;
  /** 撤销：生成新事件恢复前一分支，不删除旧裁定 */
  undone: boolean;
  parentAdjudicationId?: string;
  correlationId: string;
  createdAt: string;
  /** 乐观并发：保存时世界版本 */
  expectedWorldVersion: number;
  actualWorldVersion?: number;
}

/** 查询实体时返回：稳定身份 + 版本号 + 内容摘要 + 引用；引用缺失即损坏 */
export interface EntityEnvelope<T = unknown> {
  id: string;
  kind: EntityKind;
  version: number;
  contentHash: string;
  summary: string;
  createdAt: string;
  refs: string[];
  payload: T;
}

export interface CorruptionReport {
  corrupted: boolean;
  missingRefs: { from: string; ref: string; atVersion: number }[];
  danglingBlobs: string[];
  hashMismatches: string[];
}

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  entityId?: string;
}

/** 失效范围：参数/参考版本变化后沿依赖边计算受影响对象，不允许全局静默替换 */
export interface InvalidationScope {
  triggerEventId: string;
  changedSource: string;
  directlyAffected: string[];
  transitivelyAffected: string[];
  unaffected: string[];
  localOnly: boolean;
}
