/**
 * 领域数据契约 —— 直接使用电子断层 / tilt-series 的领域词汇，
 * 而不是把一切压成 name/value。
 *
 * 三层：
 *  1. 原始层(raw)：原始帧、倾角、像素尺度、剂量、fiducial 坐标、
 *     跟踪缺口、手工排除原因 —— 全部版本化、不可变、保留原始表示。
 *  2. 解释层(derived)：配准候选、每帧残差、局部形变、诊断、裁定。
 *  3. 事件层(events)：机器可读取的判断依据 / 历史回放。
 */

// ---------------------------------------------------------------------------
// 单位与坐标基准
// ---------------------------------------------------------------------------

export type AngleUnit = "degree" | "radian";
export type LengthUnit = "nm" | "um" | "pixel" | "angstrom/pixel";
export type DoseUnit = "e-/A^2" | "e/nm^2";

export interface AngleQ {
  value: number;
  unit: AngleUnit;
  /** 原始文本表示，导入时保留；无法转换时留在原位置并附诊断。 */
  raw?: string;
}

export interface LengthQ {
  value: number;
  unit: LengthUnit;
  raw?: string;
}

export interface DoseQ {
  value: number;
  unit: DoseUnit;
  raw?: string;
}

/** 坐标基准：像素坐标原点与约定。图像坐标 x 向右、y 向下，原点左上。 */
export interface CoordinateFrame {
  id: string;
  origin: "top-left";
  units: "pixel";
  widthPx: number;
  heightPx: number;
}

// ---------------------------------------------------------------------------
// 稳定身份
// ---------------------------------------------------------------------------

export type ScenarioId =
  | "axis-eccentric"
  | "track-swap"
  | "missing-high-tilt"
  | "bad-frame-exclusion"
  | "local-warp-overfit"
  | "multi-solution"
  | "concurrency-freeze";

export type ScenarioSize = "minimal" | "combined";

/** 内容摘要（sha256 十六进制），查询实体时与版本号一起返回。 */
export type ContentHash = string;

export interface VersionRef {
  /** 被引用实体的稳定身份（全档案范围内保持，导出/再导入不变）。 */
  id: string;
  /** 显式版本号；缺少引用必须报损坏，不允许回退当前最新版。 */
  version: number;
  /** 被引用版本的内容摘要，用于完整性校验。 */
  hash?: ContentHash;
}

export interface Provenance {
  version: number;
  hash: ContentHash;
  /** 该版本直接来源（原始导入 / 参数修订 / 源数据改动 / 人工决定）。 */
  origin: "import" | "parameter-revision" | "source-amendment" | "manual-decision";
  branch: string;
  parentVersion?: number;
  createdAt: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// 原始层实体
// ---------------------------------------------------------------------------

export interface RawFrame {
  id: string;
  seq: number; // 倾转序列顺序，不允许依赖数组下标
  blobId: string; // 指向不可变字节（合成帧也内容寻址）
  widthPx: number;
  heightPx: number;
  /** 帧来源文件名 / 采集序号的原始表示。 */
  rawLabel: string;
}

export interface TiltAngle {
  id: string;
  frameId: string;
  angle: AngleQ;
  /** 倾角方案，如 dose-symmetric / linear / bidirectional。 */
  tiltScheme: string;
}

export interface PixelScale {
  id: string;
  frameId?: string; // 缺省为全序列级
  scale: LengthQ; // 每像素代表的物理长度
  calibratedFrom?: string;
}

export interface ExposureDose {
  id: string;
  frameId: string;
  dose: DoseQ;
  cumulativeDose: DoseQ;
}

/**
 * fiducial 标记点坐标：属于某条轨迹(track)、某帧。
 * 轨迹可断裂(segments)，且可能身份交换 —— 绝不假设 trackId 恒定连通。
 */
export interface FiducialObservation {
  id: string;
  trackId: string;
  segmentId: string;
  frameId: string;
  xPx: number;
  yPx: number;
  /** 原始坐标字符串（保留导入表示）。 */
  rawX?: string;
  rawY?: string;
  /** 人工/跟踪器给出的可信度；不参与静默清洗。 */
  confidence?: number;
}

/** 跟踪缺口：某轨迹在 [fromFrameId..toFrameId] 之间没有观测。 */
export interface TrackingGap {
  id: string;
  trackId: string;
  segmentBeforeId: string;
  segmentAfterId: string;
  fromFrameId: string;
  toFrameId: string;
  reason: string;
}

/** 手工排除原因：绝不允许自动消失，导入时不做不可逆清洗。 */
export interface ManualExclusion {
  id: string;
  frameId: string;
  reason: string;
  excludedBy: string;
  atEvent?: string;
}

export interface ParameterValues {
  /** 关键领域判定：倾转轴是否允许偏离图像中心。 */
  axisMode: "free-eccentric" | "fixed-image-center";
  /** 是否允许轨迹断裂段重新连接 / 交换身份。 */
  allowTrackReidentification: boolean;
  /** 局部形变网格间距（像素）；Infinity 表示刚体。 */
  warpGridSpacingPx: number;
  /** 高倾角阈值（度，规范化层使用）。 */
  highTiltThresholdDeg: number;
  /** 坏帧残差阈值（像素，中位绝对残差的倍数）。 */
  badFrameResidualFactor: number;
  /** 过拟合保护：局部形变自由度相对有效点数的上限比例。 */
  maxWarpDofRatio: number;
  /** 多解：保留残差差距在此倍数内的全部合法候选。 */
  ambiguityBandFactor: number;
}

export interface RuleParameterSet {
  id: string;
  values: ParameterValues;
  rawNote?: string;
}

/** 一次导入 / 修订构成的原始层快照，所有派生实体都显式引用它。 */
export interface SourceSnapshot {
  id: string;
  kind: "initial-import" | "parameter-revision" | "local-source-amendment" | "conflicting-manual-decision";
  scenarioId?: ScenarioId;
  scenarioSize?: ScenarioSize;
  /** 共享原始片段（如帧字节）只存一份：引用公共 bundle 片段 id。 */
  sharedFragmentIds: string[];
  frames: RawFrame[];
  tilts: TiltAngle[];
  pixelScales: PixelScale[];
  doses: ExposureDose[];
  observations: FiducialObservation[];
  gaps: TrackingGap[];
  exclusions: ManualExclusion[];
  parameterSet: RuleParameterSet;
  createdAt: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// 解释层（派生）
// ---------------------------------------------------------------------------

export type CandidateKind = "rigid" | "local-warp" | "rigid-with-exclusions";

export type DiagnosticCode =
  | "AXIS_OFF_CENTER"
  | "AXIS_FIX_TO_CENTER_OVERRIDDEN"
  | "TRACK_IDENTITY_SWAP"
  | "TRACK_SEGMENT_BROKEN"
  | "MISSING_HIGH_TILT_FRAMES"
  | "BAD_FRAME_EXCLUDED"
  | "BAD_FRAME_EXCLUSION_UNFAIR"
  | "LOCAL_WARP_OVERFIT"
  | "AMBIGUOUS_MULTI_SOLUTION"
  | "CONCURRENT_FROZEN"
  | "UNPARSEABLE_VALUE_KEPT"
  | "VALID_POINT_SET_MISMATCH";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  relatedEntityIds: string[];
  data?: Record<string, unknown>;
}

/** 每帧残差（规范化像素单位，同时保留基准说明）。 */
export interface FrameResidual {
  frameId: string;
  rmsPx: number;
  maxPx: number;
  usedPoints: number;
  excluded: boolean;
}

export interface AlignmentCandidate {
  id: string;
  kind: CandidateKind;
  label: string;
  snapshotRef: VersionRef;
  parameterRef: VersionRef;
  /** 该候选实际使用的有效点集身份；不同候选必须用相同有效点集比较。 */
  effectivePointSetId: string;
  effectivePointCount: number;
  usedFrameIds: string[];
  excludedFrameIds: string[];
  /** 倾转轴（像素坐标 + 角度），允许偏心，绝不到图像中心取捷径。 */
  tiltAxis: {
    angleDeg: number;
    /** 轴线穿过的点，显式偏离 (width/2, height/2) 时给出偏心量。 */
    pointXPx: number;
    pointYPx: number;
    eccentricityPx: number;
  };
  /** 每帧 2D 刚体参数（平移；旋转由公共轴线模型承担）。 */
  frameTransforms: Record<string, { txPx: number; tyPx: number }>;
  /** 局部形变网格（local-warp 才有）。 */
  warpDof?: number;
  residuals: FrameResidual[];
  totalRmsPx: number;
  /** 同有效点集口径下的公平分数（不允许少帧换低残差）。 */
  fairScore: number;
  diagnostics: Diagnostic[];
  /** 多解时并列候选的簇 id。 */
  ambiguityGroupId?: string;
  ruleVersion: string;
  createdAt: string;
}

/** 依赖：参数 / 参考版本变化后用它计算失效范围，而不是全局替换。 */
export interface DerivedDependency {
  candidateId: string;
  snapshotId: string;
  parameterId: string;
  ruleVersion: string;
  /** 直接使用到的原始实体 id（局部源改动只失效这些候选）。 */
  dependsOnEntityIds: string[];
}

export type DecisionKind = "accept" | "reject" | "parameter-adjust";
export type DecisionStatus = "active" | "superseded" | "revoked";

export interface ReviewDecision {
  id: string;
  candidateId?: string;
  kind: DecisionKind;
  status: DecisionStatus;
  branch: string;
  /** 乐观锁版本；两个窗口并发保存，后提交者看到冲突与双方差异。 */
  revision: number;
  baseRevision: number;
  snapshotRef: VersionRef;
  comment: string;
  reviewer: string;
  createdAt: string;
  revokedAt?: string;
  /** 被哪个决定撤销/取代。 */
  supersededBy?: string;
}

// ---------------------------------------------------------------------------
// 事件层：机器可读取的判断依据
// ---------------------------------------------------------------------------

export type EventType =
  | "snapshot.created"
  | "candidate.computed"
  | "diagnostic.raised"
  | "decision.accepted"
  | "decision.rejected"
  | "decision.parameter-adjusted"
  | "decision.revoked"
  | "branch.created"
  | "conflict.detected"
  | "candidate.invalidated"
  | "registry.locked"
  | "import.rolled-back"
  | "value.unparseable-kept";

export interface AuditEvent {
  id: string;
  seq: number;
  type: EventType;
  branch: string;
  at: string;
  payload: Record<string, unknown>;
  /** 造成差异的材料 / 规则 / 决定，用于从最终状态反查。 */
  refs: VersionRef[];
}

// ---------------------------------------------------------------------------
// 审阅视图
// ---------------------------------------------------------------------------

export interface FrameOverlay {
  frame: { id: string; seq: number; rawLabel: string };
  angleDeg: number | null;
  dose: { value: number; unit: DoseUnit } | null;
  /** 叠影偏移（当前锁定/选中候选的帧变换）。 */
  shiftPx: { x: number; y: number } | null;
  residual: FrameResidual | null;
  /** 该帧上轨迹断点。 */
  breakOnFrame: boolean;
  excluded: boolean;
}

export interface CandidateDiff {
  aCandidateId: string;
  bCandidateId: string;
  samePointSet: boolean;
  totalRmsDeltaPx: number;
  fairScoreDelta: number;
  axisDelta: { angleDeg: number; pointXPx: number; pointYPx: number };
  frameCountDelta: number;
  notes: string[];
}

export interface EntityLookup {
  entityId: string;
  type: string;
  version: number;
  hash: ContentHash;
  origin: string;
  summary: string;
  refs: VersionRef[];
  corrupted?: string;
}
