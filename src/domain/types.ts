/**
 * 倾转帧拼合室 —— 领域词汇与数据契约。
 *
 * 这里的类型直接使用电子断层领域的词汇：原始帧、倾角、像素尺度、剂量、
 * fiducial 标记点坐标、跟踪缺口、手工排除原因；决定层则表达倾转轴、
 * 轨迹片段（可断裂、可身份交换）、配准候选、裁定与失效范围。
 *
 * 所有领域量都携带单位/坐标基准；导入时保留原始表示（rawText/rawUnit），
 * 派生层才做规范化；无法转换的值留在原位置并附诊断。
 */

export type UUID = string;

/** 坐标基准：所有派生坐标都显式声明，禁止隐式假设图像中心。 */
export type CoordinateBasis =
  | "frame-pixel"        // 像素坐标，原点为帧左上角，x 向右，y 向下
  | "stage-unbinned-nm"  // 未合并像素物理坐标（nm）
  | "reconstructed-voxel"; // 重建体素坐标

export type AngleUnit = "deg" | "rad";
export type LengthUnit = "nm" | "um" | "pixel";
export type DoseUnit = "e-/A^2" | "e-/nm^2" | "unknown";

/** 带原始表示的领域量：规范化结果与原始文本同时存在。 */
export interface DomainQuantity<U extends string> {
  value: number | null;          // 派生层规范化值；无法转换时为 null
  unit: U;                       // 规范化目标单位
  rawText: string;               // 原始表示（逐字保留）
  rawUnit: string | null;        // 原始单位标记
  basis?: CoordinateBasis;
  conversionDiagnostic?: ConversionDiagnostic;
}

export interface ConversionDiagnostic {
  code:
    | "unit-unrecognized"
    | "value-unparseable"
    | "unit-mismatch"
    | "non-finite"
    | "kept-at-source";
  message: string;
}

export const DOSE_TO_E_PER_A2: Record<string, number> = {
  "e-/A^2": 1,
  "e-/angstrom^2": 1,
  "e-/nm^2": 0.01, // 1 nm^2 = 100 A^2
  "e/nm^2": 0.01,
};

export const ANGLE_TO_DEG: Record<string, number> = {
  deg: 1,
  degree: 1,
  degrees: 1,
  rad: 180 / Math.PI,
  radian: 180 / Math.PI,
};

export const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  um: 1000,
  "µm": 1000,
  pixel: Number.NaN, // 像素→nm 必须依赖 pixelScale，缺失时不可转换
};

// ---------------------------------------------------------------------------
// 输入实体：原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、手工排除原因
// ---------------------------------------------------------------------------

export interface RawFrame {
  kind: "raw-frame";
  frameId: string;        // 稳定身份，如 frame-000
  sequenceIndex: number;  // 采集顺序（稳定）
  acquisitionId: string;  // 采集会话标识
  blobUri: string;        // 内容寻址片段 URI：urn:sha256:...
  widthPx: number;
  heightPx: number;
  pixelFormat: string;    // 例如 "pgm-u8"
  exposureMs: DomainQuantity<"ms">;
}

export interface TiltAngle {
  kind: "tilt-angle";
  frameId: string;
  angle: DomainQuantity<AngleUnit>; // 目标单位 deg
}

export interface PixelScale {
  kind: "pixel-scale";
  scope: string;                     // 适用范围："all" 或 frameId
  pixelSize: DomainQuantity<LengthUnit>; // 目标单位 nm/像素
  basis: CoordinateBasis;
}

export interface FrameDose {
  kind: "frame-dose";
  frameId: string;
  dose: DomainQuantity<DoseUnit>;   // 目标单位 e-/A^2
}

export interface MarkerCoordinate {
  kind: "marker-coordinate";
  frameId: string;
  markerId: string;     // 观测侧稳定标记身份
  segmentId: string;    // 轨迹片段身份；同 marker 可有多个断裂片段
  x: DomainQuantity<"pixel">;
  y: DomainQuantity<"pixel">;
  basis: CoordinateBasis;
}

export interface TrackingGap {
  kind: "tracking-gap";
  markerId: string;
  segmentId: string;
  missingFrameIds: string[];
  reason: "out-of-field" | "low-dose-occluded" | "not-tracked" | "identity-ambiguous";
}

export type ExclusionReason =
  | "motion-blur"
  | "too-large-residual"
  | "dose-monitor-fault"
  | "high-tilt-missing"
  | "manual-review";

export interface ManualExclusion {
  kind: "manual-exclusion";
  frameId: string;
  reason: ExclusionReason;
  note: string;
  decidedBy: string;
}

export type InputEntity =
  | RawFrame
  | TiltAngle
  | PixelScale
  | FrameDose
  | MarkerCoordinate
  | TrackingGap
  | ManualExclusion;

export const INPUT_KINDS = [
  "raw-frame",
  "tilt-angle",
  "pixel-scale",
  "frame-dose",
  "marker-coordinate",
  "tracking-gap",
  "manual-exclusion",
] as const;

// ---------------------------------------------------------------------------
// 决定实体：倾转轴、轨迹片段身份、配准候选、裁定、锁
// ---------------------------------------------------------------------------

/**
 * 倾转轴。注意：originX/originY 是必须显式给出的——系统绝不默认把轴固定
 * 在图像中心；"center-assumed" 仅作为一个被显式标记的候选先验存在。
 */
export interface TiltAxisModel {
  kind: "tilt-axis";
  axisId: string;
  /** 轴方向角（deg），在 frame-pixel 基准下相对图像 +x 轴。 */
  directionDeg: DomainQuantity<"deg">;
  /** 轴线穿过的点（像素）。偏心正是相对图像中心的偏移。 */
  originX: DomainQuantity<"pixel">;
  originY: DomainQuantity<"pixel">;
  basis: CoordinateBasis;
  originPrior: "fitted" | "center-assumed" | "stage-reported";
  /** 相对图像中心的偏心量（像素），派生诊断值。 */
  eccentricityPx: number | null;
}

/** 轨迹片段的身份解释：断裂片段可能对应同一物理颗粒，也可能交换。 */
export interface TrackSegmentIdentity {
  kind: "track-segment-identity";
  markerId: string;
  segmentId: string;
  physicalParticleId: string;
  confidence: number;
  ambiguity: "unique" | "swapped-possible" | "ambiguous";
}

export type RegistrationMethod = "rigid" | "local-warp" | "rigid-excluded";

export type FrameResidualStatus = "inlier" | "excluded" | "missing";

export interface FrameResidual {
  frameId: string;
  tiltDeg: number | null;
  residualPx: number | null;
  status: FrameResidualStatus;
}

export interface RegistrationCandidate {
  kind: "registration-candidate";
  candidateId: string;
  method: RegistrationMethod;
  branchId: UUID;
  axis: TiltAxisModel;
  /** 实际用于拟合的有效点集（点 = frameId+markerId+segmentId 观测）。 */
  effectivePointSetId: string;
  effectivePointCount: number;
  usedFrameIds: string[];
  excludedFrameIds: string[];
  missingFrameIds: string[];
  segmentIdentities: TrackSegmentIdentity[];
  frameResiduals: FrameResidual[];
  /** 全部有效帧的残差 RMS；所有候选的唯一比较口径。 */
  rmsAllFramesPx: number;
  /**
   * 跨“共同有效点集”的 RMS：候选间比较只允许用同一集合，
   * 禁止用“排除帧/少帧”换取表面低残差。
   */
  rmsCommonPx: number;
  /** 留出交叉验证误差（局部形变过拟合检测）。 */
  crossValidationPx: number;
  degreesOfFreedom: number;
  dofPerPoint: number;
  warpAmplitudePx: number | null;
  diagnoses: Diagnosis[];
  isLegallyAmbiguous: boolean;
  ambiguityGroupId: string | null;
}

export type DiagnosisCode =
  | "axis-offset-from-center"
  | "identity-swap-suspected"
  | "high-tilt-frame-missing"
  | "bad-frame-excluded"
  | "local-warp-overfit"
  | "multiple-solutions"
  | "concurrent-frozen"
  | "unconvertible-value-kept"
  | "fewer-frames-not-allowed"
  | "reference-missing-corrupt";

export interface Diagnosis {
  code: DiagnosisCode;
  severity: "info" | "warning" | "error";
  message: string;
  affectedIds: string[];
}

export type AdjudicationDecision = "accepted" | "rejected";

export interface Adjudication {
  kind: "adjudication";
  adjudicationId: UUID;
  candidateId: string;
  decision: AdjudicationDecision;
  decidedBy: string;
  rationaleCode:
    | "axis-not-center"
    | "tracks-may-break-and-swap"
    | "same-effective-point-set"
    | "no-fewer-frames-for-low-residual";
  note: string;
  /** 可撤销：撤销动作自身是新事件，不删除旧事件。 */
  undone: boolean;
}

export interface ReviewLock {
  kind: "review-lock";
  lockId: UUID;
  branchId: UUID;
  studyId: string;
  holder: string;
  /** 冻结时记录的基础版本（乐观并发）。 */
  basisEventId: UUID;
}

// ---------------------------------------------------------------------------
// 版本包装与事件
// ---------------------------------------------------------------------------

export interface EntityRef {
  kind: InputEntity["kind"] | RegistrationCandidate["kind"] | TiltAxisModel["kind"] | Adjudication["kind"];
  stableId: string;
  version: number;
}

export interface VersionedEntity<T = InputEntity | RegistrationCandidate | TiltAxisModel | Adjudication> {
  ref: EntityRef;
  entity: T;
  /** 内容摘要（规范化 JSON 后的 sha256 前 16 位），用于损坏检测与显示。 */
  contentDigest: string;
  createdAt: string;
  branchId: UUID;
  /** 该实体直接依赖的版本引用（失效范围传播边）。 */
  dependsOn: EntityRef[];
}

export type EventType =
  | "import-began"
  | "import-rolled-back"
  | "entity-version-recorded"
  | "interpretation-branched"
  | "parameter-revised"
  | "source-data-patched-local"
  | "candidates-computed"
  | "adjudication-decided"
  | "adjudication-undone"
  | "registration-locked"
  | "lock-stolen-conflict"
  | "concurrent-save-conflict"
  | "invalidated-by-dependency"
  | "corrupt-reference-detected";

export interface EventRecord {
  eventId: UUID;
  seq: number;
  studyId: string;
  branchId: UUID;
  type: EventType;
  at: string;
  actor: string;
  basisEventId: UUID | null;
  /** 机器可读判断依据（规则 → 结论）。 */
  rationale?: MachineRationale;
  payload?: Record<string, unknown>;
  prevEventId: UUID | null;
}

/** 机器可读事件依据：规则代码 + 涉及实体 + 结论，供自动断言与重放。 */
export interface MachineRationale {
  ruleCode:
    | "AXIS_NOT_CENTER"
    | "TRACKS_BREAK_AND_SWAP"
    | "SAME_EFFECTIVE_POINT_SET"
    | "NO_FEWER_FRAMES_FOR_LOW_RESIDUAL"
    | "KEEP_ALL_LEGAL_CANDIDATES"
    | "DEPENDENCY_INVALIDATION"
    | "REFERENCE_RESOLUTION_NO_SILENT_LATEST"
    | "IMPORT_ATOMIC"
    | "UNCONVERTIBLE_STAYS_IN_PLACE";
  subjectRefs: EntityRef[];
  verdict: string;
  evidence: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 研究 / 分支 / 有效点集 / 快照
// ---------------------------------------------------------------------------

export interface Branch {
  branchId: UUID;
  studyId: string;
  name: string;
  parentBranchId: UUID | null;
  parentEventId: UUID | null;
  createdAt: string;
  archived: boolean;
}

export interface EffectivePointSet {
  pointSetId: string;
  frameIds: string[];
  pointCount: number;
  key: string; // 排序后稳定键
}

/** 历史时刻快照：回到任意旧事件时恢复当时的依赖版本与可见结论。 */
export interface StudySnapshot {
  asOfEventSeq: number;
  studyId: string;
  inputs: VersionedEntity<InputEntity>[];
  branches: Branch[];
  currentBranchId: UUID;
  axes: VersionedEntity<TiltAxisModel>[];
  candidates: VersionedEntity<RegistrationCandidate>[];
  adjudications: VersionedEntity<Adjudication>[];
  events: EventRecord[];
  invalidatedRefs: EntityRef[];
  lockedCandidateRef: EntityRef | null;
  lock: (ReviewLock & { version: number }) | null;
  diagnoses: Diagnosis[];
  parameters: AlignmentParameters;
}

export interface AlignmentParameters {
  parameterSetId: string;
  version: number;
  /** 排除候选允许的最大坏帧比例；防止“少帧换低残差”。 */
  maxExcludedFrameFraction: number;
  /** 高倾角阈值（deg）。 */
  highTiltThresholdDeg: number;
  /** 局部形变允许的最大每点自由度。 */
  maxDofPerPoint: number;
  /** CV 残差相对刚体改善低于该比例视为过拟合。 */
  overfitCvPenalty: number;
  /** 轴原点先验：不允许导入时默认 center；只能显式选择。 */
  axisOriginPrior: "fitted" | "center-assumed";
  residualSigmaThreshold: number;
}

export const DEFAULT_PARAMETERS: AlignmentParameters = {
  parameterSetId: "params-standard",
  version: 1,
  maxExcludedFrameFraction: 0.15,
  highTiltThresholdDeg: 55,
  maxDofPerPoint: 1.0,
  overfitCvPenalty: 1.0,
  axisOriginPrior: "fitted",
  residualSigmaThreshold: 2.5,
};
