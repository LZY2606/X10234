// 领域词汇表 —— 电子断层 / 倾转序列 / fiducial 配准
// 注意：所有领域量携带单位或坐标基准；原始表示(original)与派生规范化(normalized)分开保存。
// 严禁把一切压成 name/value。

/** 带单位/坐标基准的量：原始表示 + 规范化后的 SI 派生值 */
export interface Measured<T = number> {
  /** 导入时保留的原始文本表示 */
  original: string;
  /** 规范化数值（无法转换时为 null，诊断见 diagnostic） */
  normalized: T | null;
  /** 原始单位，如 "degree" | "nm/pixel" | "e-/A^2" */
  unit: string;
  /** 无法转换时的诊断；可转换为 null */
  diagnostic: string | null;
}

export type CoordinateBasis = "image_pixel_origin_topleft";

export interface ImagePoint {
  /** 图像像素坐标，原点左上角，x 向右、y 向下 */
  basis: CoordinateBasis;
  x: number;
  y: number;
}

export interface FrameRef {
  frameId: string;
  index: number;
}

/** 原始帧（内容寻址，不可变） */
export interface RawFrame {
  frameId: string;
  seriesId: string;
  index: number;
  /** 内容哈希引用 raw_blob.blobId */
  blobId: string;
  width: number;
  height: number;
  pixelFormat: string;
}

export interface TiltAngleRecord {
  tiltId: string;
  frameId: string;
  index: number;
  angle: Measured; // degree
}

export interface PixelScaleRecord {
  pixelScaleId: string;
  seriesId: string;
  /** 可为逐帧覆盖；frameId=null 表示序列级 */
  frameId: string | null;
  scale: Measured; // 物理长度 / pixel
}

export interface DoseRecord {
  doseId: string;
  frameId: string;
  index: number;
  exposure: Measured; // e-/A^2 或原单位
}

/** fiducial 标记点观测（某条轨迹在某帧上的坐标）；缺失即轨迹缺口 */
export interface MarkerObservation {
  observationId: string;
  trackId: string;
  frameId: string;
  index: number;
  point: ImagePoint;
  /** 本次观测的解释版本来源（不同分支可重新指派 trackId） */
  residual?: number | null;
}

/** fiducial 轨迹：可断裂、可能身份交换 */
export interface FiducialTrack {
  trackId: string;
  seriesId: string;
  colorHint?: string;
}

/** 跟踪缺口：track 在 [fromIndex..toIndex] 区间无观测 */
export interface TrackingGap {
  gapId: string;
  trackId: string;
  fromFrameId: string;
  toFrameId: string;
  reason: string;
}

/** 手工排除原因 */
export interface ManualExclusion {
  exclusionId: string;
  frameId: string;
  reason: string;
  reviewer: string;
}

/** 倾转轴假设；不能默认固定在图像中心 */
export interface TiltAxisProposal {
  axisId: string;
  /** 轴与图像 x 轴夹角 */
  angleDeg: number;
  /** 轴线经过点（单位像素），默认中心仅作为搜索初值，结论自由拟合 */
  centerX: number;
  centerY: number;
  /** 是否把中心强制固定在图像中心（对照实验） */
  centerPinnedToImageCenter: boolean;
  basis: CoordinateBasis;
}

export type RegistrationScheme = "rigid" | "local_warp" | "bad_frame_excluded";

/** 每帧刚体修正（平移），rotation 以角度给出 */
export interface FrameTransform {
  frameId: string;
  shiftX: number; // pixel
  shiftY: number; // pixel
  rotationDeg: number;
  /** 局部形变网格控制点（仅 local_warp 使用），否则为空 */
  warpControlPoints: { x: number; y: number; dx: number; dy: number }[];
  excluded: boolean;
}

/** 注册候选：同一有效点集上比较，多解全部保留 */
export interface RegistrationCandidate {
  candidateId: string;
  seriesId: string;
  branchId: string;
  scheme: RegistrationScheme;
  axis: TiltAxisProposal;
  transforms: FrameTransform[];
  /** 参与拟合的有效帧集合（不同方案公平比较时取并集/共同集） */
  effectiveFrameIds: string[];
  /** 实际有观测的轨迹点集合，相同有效点集比较用 */
  effectiveObservationIds: string[];
  /** 同一共同有效点集上的 RMS（pixel），禁止用少帧换低残差 */
  commonSetRms: number;
  /** 各方案自身有效集 RMS */
  ownSetRms: number;
  perFrameResidual: { frameId: string; rms: number; count: number; excluded: boolean }[];
  /** 局部形变过拟合指标：训练/交叉验证残差比 */
  overfitRatio: number | null;
  /** 是否多解（存在另一合法候选无法区分） */
  ambiguous: boolean;
  ambiguityWith: string[];
  /** 依赖的输入版本，供失效范围计算 */
  dependencies: { kind: string; version: string }[];
  diagnostic: string[];
}

export type DecisionKind = "accept" | "reject" | "parameter_revision" | "conflict" | "note";

export interface ReviewDecision {
  decisionId: string;
  branchId: string;
  candidateId: string | null;
  kind: DecisionKind;
  rationale: string;
  reviewer: string;
  /** 撤销后指向前一分支状态 */
  supersedesDecisionId: string | null;
}

/** 锁定供重建引用的一版配准 */
export interface LockedRegistration {
  lockId: string;
  seriesId: string;
  branchId: string;
  candidateId: string;
  decisionId: string;
}

export interface Branch {
  branchId: string;
  seriesId: string;
  parentBranchId: string | null;
  name: string;
  /** 分支起点事件序号 */
  fromEventSeq: number;
  lockedCandidateId: string | null;
}

/** 机器可读事件（溯源链，顺序不可变） */
export interface LedgerEvent {
  seq: number;
  eventId: string;
  branchId: string;
  type: string;
  /** 结构化载荷（领域字段，不使用 name/value） */
  payload: Record<string, unknown>;
  /** 引用的版本号与内容摘要；缺引用即为损坏 */
  refs: { kind: string; id: string; version: number; sha256: string }[];
  parentEventId: string | null;
  /** 逻辑时钟，来自输入内容（重放确定），非墙钟 */
  logicalTime: number;
  /** 墙钟仅作显示，不参与身份 */
  recordedAt: string;
}

export interface EntityRef {
  kind: string;
  id: string;
  version: number;
  sha256: string;
}
