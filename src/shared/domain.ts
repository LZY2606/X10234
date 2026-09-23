/**
 * 领域契约：电子断层 / 倾转序列 / 配准审阅。
 * 所有实体使用领域自身的词汇（tiltSeries / tiltFrame / fiducialObservation / trackSegment ...），
 * 不压成通用 name/value。所有领域量携带单位或坐标基准。
 */

// ---------- 基础量 ----------
export type Unit =
  | 'px'            // 像素（图像坐标基准）
  | 'nm'            // 纳米（样品坐标基准）
  | 'A'             // 埃
  | 'deg'           // 度
  | 'rad'           // 弧度
  | 'e-/A2'         // 电子剂量 每平方埃
  | 'e-/nm2'        // 电子剂量 每平方纳米
  | 'count'         // 计数
  | 'dimensionless';

/** 原始量：导入时保留原始表示（原样数值+原单位），规范化只发生在派生层。 */
export interface RawQuantity {
  value: number;
  unit: Unit;
}

/** 派生层的规范化量（规范单位：nm / deg / e-\/A2）。 */
export interface CanonicalQuantity {
  value: number;
  canonicalUnit: 'nm' | 'deg' | 'e-/A2' | 'px' | 'dimensionless';
}

export interface ConversionDiagnostic {
  code: 'UNIT_UNCONVERTIBLE' | 'VALUE_MISSING' | 'BASIS_UNKNOWN';
  message: string;
  /** 无法转换的值留在原位置，附此诊断，不为画图而丢弃。 */
  keptRaw: RawQuantity | null;
}

// ---------- 坐标基准 ----------
export interface FrameBasis {
  kind: 'frame';
  /** 图像尺寸（像素），坐标原点为左上角，x 向右，y 向下。 */
  widthPx: number;
  heightPx: number;
}
export interface SpecimenBasis {
  kind: 'specimen';
  /** 样品坐标：x 沿倾转轴方向，z 沿光轴，单位 nm。 */
  unit: 'nm';
}
export type CoordinateBasis = FrameBasis | SpecimenBasis;

// ---------- 输入实体（全部版本化） ----------
export interface TiltSeriesMeta {
  seriesId: string;
  instrument: string;
  detector: string;
  frameBasis: FrameBasis;
  specimenBasis: SpecimenBasis;
}

export interface TiltFrame {
  frameId: string;
  seriesId: string;
  tiltIndex: number;
  /** 原始倾角（保留导入原值与原单位）。 */
  tiltAngle: RawQuantity;
  /** 像素尺度（原始表示）。 */
  pixelSize: RawQuantity;
  /** 曝光剂量（原始表示）。 */
  dose: RawQuantity;
  /** 帧图像原始字节（PGM 灰度）的内容寻址哈希。 */
  imageBlobHash: string;
  /** 图像尺寸（像素基准）。 */
  widthPx: number;
  heightPx: number;
}

export interface FiducialObservation {
  observationId: string;
  seriesId: string;
  frameId: string;
  /** 观测所属的轨迹段（身份可断裂、可交换，见 TrackSegment / TrackIdentityLink）。 */
  trackId: string;
  /** 图像坐标基准下的标记点坐标。 */
  position: { x: RawQuantity; y: RawQuantity };
}

export interface TrackingGap {
  gapId: string;
  seriesId: string;
  trackId: string;
  /** 缺口覆盖的倾角序号区间 [fromTiltIndex, toTiltIndex]（含端点）。 */
  fromTiltIndex: number;
  toTiltIndex: number;
  reason: string;
}

export interface ManualExclusion {
  exclusionId: string;
  seriesId: string;
  frameId: string;
  reason: string;
  author: string;
}

// ---------- 解释层实体 ----------
export interface TrackSegment {
  trackId: string;
  seriesId: string;
  /** 该段覆盖的倾角序号区间。 */
  fromTiltIndex: number;
  toTiltIndex: number;
}

/**
 * 轨迹身份链接：表达“两段轨迹其实属于同一个物理标记点”或“身份被交换”。
 * 断裂与身份交换都是显式的一等数据，而不是导入时被清洗掉。
 */
export interface TrackIdentityLink {
  linkId: string;
  seriesId: string;
  trackA: string;
  trackB: string;
  relation: 'same-fiducial' | 'swapped-identity';
  atTiltIndex: number;
}

/** 倾转轴：绝不能默认固定在图像中心，偏移与角度都是显式参数。 */
export interface TiltAxis {
  /** 轴与样品 x 方向的夹角（度）。 */
  azimuthDeg: number;
  /** 轴心相对图像中心的偏移（像素基准）。 */
  offsetX: RawQuantity;
  offsetY: RawQuantity;
  /** 该轴参数的来源：显式拟合 / 人工设定；永远不是“默认居中”。 */
  origin: 'fitted' | 'manual';
}

export interface FrameTransform {
  frameId: string;
  /** 刚体对齐参数：旋转（度）、平移（像素基准）、各向同性缩放。 */
  rotation: RawQuantity;
  shiftX: RawQuantity;
  shiftY: RawQuantity;
  scale: number;
}

export type RegistrationKind = 'rigid' | 'local-warp' | 'exclude-bad-frames';

export interface RegistrationModel {
  modelId: string;
  kind: RegistrationKind;
  axis: TiltAxis;
  transforms: FrameTransform[];
  /** 局部形变模型的每帧仿射扩展（仅 local-warp）。 */
  warps?: FrameWarp[];
}

export interface FrameWarp {
  frameId: string;
  /** 2x3 仿射矩阵（像素基准）。 */
  affine: [number, number, number, number, number, number];
}

export interface FrameResidual {
  frameId: string;
  /** 每帧残差（像素基准的均方根）。 */
  rmsPx: number;
  perObservation: Array<{ observationId: string; residualPx: number }>;
}

export interface AlignmentCandidate {
  candidateId: string;
  branchId: string;
  label: string;
  model: RegistrationModel;
  /** 有效点集：比较不同候选时必须使用相同的有效点集。 */
  effectivePointSetId: string;
  residuals: FrameResidual[];
  /** 多解：无法唯一决定时保留全部合法候选。 */
  solutionSetId: string | null;
  status: 'open' | 'accepted' | 'rejected' | 'superseded';
  /** 依赖失效标记：来源或规则版本变化后被标记，不静默替换。 */
  stale: boolean;
  diagnostics: ConversionDiagnostic[];
  /** 依赖关系：用于来源/规则版本变化后计算失效范围。 */
  dependencies: {
    ruleSetRef: EntityRef;
    frameIds: string[];
    observationIds: string[];
  };
}

/** 推导规则集（版本化）：参数修订产生新版本，旧版本仍可读取。 */
export interface RuleSet {
  ruleSetId: string;
  badFrameFactor: number;     // 帧残差超过中位数该倍数 -> 坏帧
  overfitTolerance: number;   // 局部形变在留出半集上需达到的相对改善
  axisPrior: 'free';          // 轴先验：永远自由拟合，绝不默认居中
  comparisonRule: 'same-effective-point-set';
  multiSolutionZConditioning: number; // 低于该值视为病态，保留多解
}

/** 有效点集：候选之间公平比较的共同基准。 */
export interface EffectivePointSet {
  pointSetId: string;
  seriesId: string;
  observationIds: string[];
  excludedFrameIds: string[];
  rationale: string;
}

// ---------- 复核实体 ----------
export type DecisionVerdict = 'accept' | 'reject' | 'adjust-params';

export interface ReviewDecision {
  decisionId: string;
  branchId: string;
  candidateId: string;
  verdict: DecisionVerdict;
  rationale: string;
  author: string;
  /** 裁定可撤销：记录被撤销时恢复的前一分支状态。 */
  supersededBy: string | null;
}

/** 锁定一版配准供重建引用。 */
export interface AlignmentLock {
  lockId: string;
  branchId: string;
  candidateId: string;
  author: string;
  note: string;
  active: boolean;
}

export interface ReviewBranch {
  branchId: string;
  seriesId: string;
  name: string;
  parentBranchId: string | null;
  /** 乐观并发：保存时携带期望头版本，冲突时返回双方差异。 */
  headEventSeq: number;
}

// ---------- 反例档案（adversarial archive） ----------
export type ScenarioKind =
  | 'axis-offset'          // 轴线偏心
  | 'track-identity-swap'  // 轨迹身份交换
  | 'missing-high-tilt'    // 缺失高倾角帧
  | 'bad-frame-exclusion'  // 坏帧排除
  | 'local-warp-overfit'   // 局部形变过拟合
  | 'multi-solution'       // 多解
  | 'concurrent-freeze';   // 并发冻结

export interface ScenarioCase {
  caseId: string;
  scenario: ScenarioKind;
  /** 最小输入与组合输入共享的原始片段只存一份（内容寻址），解释版本各自独立。 */
  minimalInputRef: string;
  combinedInputRef: string;
  adoptedResultRef: string | null;   // 被采纳结果保留
  rejectedResultRef: string | null;  // 未采纳结果同样保留
  diagnosis: string;
}

// ---------- 机器可读事件 ----------
export type EventKind =
  | 'series-imported'
  | 'source-revised'        // 参数修订 / 源数据改动（局部失效）
  | 'diagnostic-raised'
  | 'candidates-computed'
  | 'multi-solution-kept'
  | 'track-identity-flagged'
  | 'axis-fitted'
  | 'comparison-made'       // 相同有效点集上的候选比较
  | 'decision-made'
  | 'decision-undone'
  | 'branch-created'
  | 'lock-set'
  | 'lock-released'
  | 'conflict-detected'     // 并发冻结：后提交者看到版本冲突及双方差异
  | 'archive-exported'
  | 'archive-imported'
  | 'corruption-detected';

export interface DomainEvent {
  eventId: string;
  seq: number;
  branchId: string;
  kind: EventKind;
  at: string; // ISO 时间
  /** 机器可读的负载：判断依据（如“不用少帧换低残差”的点集身份）必须落在 payload 里。 */
  payload: Record<string, unknown>;
}

// ---------- 查询响应 ----------
export interface EntityRef {
  entityKind: string;
  entityId: string;
  version: number;
  contentHash: string;
}

export interface EntityView {
  ref: EntityRef;
  /** 内容摘要（哈希 + 关键字段），引用版本号显式返回。 */
  summary: Record<string, unknown>;
  /** 该实体引用的其他实体版本。 */
  references: EntityRef[];
}

export class CorruptionError extends Error {
  readonly code = 'CORRUPTION';
  constructor(
    message: string,
    readonly missing: EntityRef[],
  ) {
    super(message);
    this.name = 'CorruptionError';
  }
}

export class ConflictError extends Error {
  readonly code = 'CONFLICT';
  constructor(
    message: string,
    readonly expectedSeq: number,
    readonly actualSeq: number,
    readonly diff: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}
