/**
 * 领域词汇表：电子断层 / tilt-series / fiducial / 配准。
 *
 * 设计约束：
 *  - 输入实体与解释实体分离（来源事实不可变，解释可版本化/分支）。
 *  - 所有领域量携带单位或坐标基准；导入时保留原始表示（rawText），规范化只在派生层。
 *  - 无法转换的值留在原位置并附 Diagnostic，绝不为画图而丢弃。
 *  - 每个实体都有稳定身份（StableId）与单调版本号。
 */

export type StableId = string;
export type Version = number;
export type Digest = string; // sha256 hex，内容寻址

// ---------- 量、单位、坐标基准 ----------

export type AngleUnit = "degree" | "radian";
export type LengthUnit = "pixel" | "nm" | "um";
export type DoseUnit = "e-/A^2" | "e-/nm^2" | "counts";

/** 图像坐标基准：原点、x/y 方向。序列内所有标记点坐标都声明基准。 */
export interface CoordinateBasis {
  readonly id: StableId;
  readonly origin: "top-left" | "image-center";
  readonly xAxis: "right";
  readonly yAxis: "down";
  /** 像素间距基准（可为空，表示仅以 pixel 为单位）。 */
  readonly pixelScaleRef?: StableId;
}

export interface Angle {
  readonly value: number;
  readonly unit: AngleUnit;
  /** 导入时的原始文本表示，规范化前保留。 */
  readonly rawText?: string;
  /** 无法可靠规范化时（如越界/未知单位），诊断留在原位置。 */
  readonly diagnostics?: readonly Diagnostic[];
}

export interface Length {
  readonly value: number;
  readonly unit: LengthUnit;
  readonly rawText?: string;
  readonly diagnostics?: readonly Diagnostic[];
}

export interface PixelScaleValue {
  readonly x: Length;
  readonly y: Length;
  /** 像素尺度各向异性时 x/y 可不同；不做静默平均。 */
  readonly isotropicAssumed: boolean;
}

export interface DoseValue {
  readonly value: number;
  readonly unit: DoseUnit;
  readonly rawText?: string;
  readonly diagnostics?: readonly Diagnostic[];
}

export interface Point2D {
  readonly x: number;
  readonly y: number;
  readonly unit: "pixel";
  readonly basisId: StableId;
  readonly rawText?: string;
  readonly diagnostics?: readonly Diagnostic[];
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly atFrameId?: StableId;
  readonly atObservationId?: StableId;
}

// ---------- 输入（来源）实体：全部版本化、不可变 ----------

export type SourceKind =
  | "raw-frame"
  | "tilt-angle"
  | "pixel-scale"
  | "dose"
  | "marker-observation"
  | "track-gap"
  | "manual-exclusion";

export interface RawFrame {
  readonly kind: "raw-frame";
  readonly id: StableId;
  /** 采集顺序（从 0 起），决定回放顺序，不随倾角排序改变。 */
  readonly acquisitionIndex: number;
  readonly width: number;
  readonly height: number;
  readonly blobDigest: Digest;
  readonly mediaType: "image/raw-gray8";
  readonly checksum: Digest;
  /** 原始表示：例如 MRC/EM 中的 dtype 字符串，原样保留。 */
  readonly rawRepresentation: string;
}

export interface TiltAngleFact {
  readonly kind: "tilt-angle";
  readonly id: StableId;
  readonly frameId: StableId;
  readonly angle: Angle;
}

export interface PixelScaleFact {
  readonly kind: "pixel-scale";
  readonly id: StableId;
  readonly appliesToFrameIds: readonly StableId[];
  readonly scale: PixelScaleValue;
}

export interface DoseFact {
  readonly kind: "dose";
  readonly id: StableId;
  readonly frameId: StableId;
  readonly dose: DoseValue;
  readonly cumulative: boolean;
}

export interface MarkerObservationFact {
  readonly kind: "marker-observation";
  readonly id: StableId;
  readonly frameId: StableId;
  /** 跟踪器给出的“暂定”轨迹身份；解释层允许断裂与身份交换。 */
  readonly tentativeTrackId: StableId;
  readonly point: Point2D;
}

export type GapReason =
  | "missing-high-tilt-frame"
  | "not-detected"
  | "occluded"
  | "tracking-lost"
  | "manual";

export interface TrackGapFact {
  readonly kind: "track-gap";
  readonly id: StableId;
  readonly trackId: StableId;
  readonly fromFrameId: StableId;
  readonly toFrameId: StableId;
  readonly reason: GapReason;
  readonly note?: string;
}

export type ExclusionTarget =
  | { readonly targetType: "frame"; readonly targetId: StableId }
  | { readonly targetType: "observation"; readonly targetId: StableId };

export interface ManualExclusionFact {
  readonly kind: "manual-exclusion";
  readonly id: StableId;
  readonly target: ExclusionTarget;
  readonly reasonCode:
    | "motion-during-exposure"
    | "too-large-drift"
    | "dose-too-low"
    | "ice-contamination"
    | "other";
  readonly note?: string;
  readonly author: string;
}

export type SourceFact =
  | RawFrame
  | TiltAngleFact
  | PixelScaleFact
  | DoseFact
  | MarkerObservationFact
  | TrackGapFact
  | ManualExclusionFact;

// ---------- 解释实体 ----------

/** 倾转轴解：轴角 + 相对图像中心的垂直偏心。绝不默认固定在图像中心。 */
export interface TiltAxisSolution {
  readonly kind: "tilt-axis";
  readonly id: StableId;
  readonly axisAngleDeg: number;
  /** 轴线相对图像中心的垂直偏移（pixel），为 0 也必须是拟合/裁定结果。 */
  readonly perpendicularOffsetPx: number;
  readonly centerBasisId: StableId;
  readonly assumedCenter: boolean;
  readonly residualRms: number;
  readonly diagnostics: readonly Diagnostic[];
}

/** fiducial 轨迹：由多段组成，可断裂；记录身份交换。 */
export interface TrackSegment {
  readonly observationIds: readonly StableId[];
}

export interface IdentitySwap {
  readonly atFrameId: StableId;
  readonly otherTrackId: StableId;
  readonly evidence: string;
}

export interface TrackInterpretation {
  readonly kind: "track";
  readonly id: StableId;
  readonly segments: readonly TrackSegment[];
  readonly swaps: readonly IdentitySwap[];
  readonly diagnostics: readonly Diagnostic[];
}

export type CandidateKind = "rigid" | "local-warp" | "rigid-exclude";

/** 刚体：每帧仅平移（可选面内角，案例使用平移）。 */
export interface FrameRigidTransform {
  readonly frameId: StableId;
  readonly shiftX: number;
  readonly shiftY: number;
}

/** 局部形变：每帧 6 仿射参数，自由度高，可能过拟合。 */
export interface FrameAffineTransform {
  readonly frameId: StableId;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface PerFrameResidual {
  readonly frameId: StableId;
  readonly rms: number;
  readonly maxAbs: number;
  readonly pointCount: number;
}

export interface AlignmentCandidate {
  readonly kind: "candidate";
  readonly id: StableId;
  readonly candidateKind: CandidateKind;
  readonly paramsVersion: Version;
  readonly axisSolutionId: StableId;
  readonly trackInterpretationIds: readonly StableId[];
  readonly rigidTransforms?: readonly FrameRigidTransform[];
  readonly affineTransforms?: readonly FrameAffineTransform[];
  readonly usedFrameIds: readonly StableId[];
  readonly excludedFrameIds: readonly StableId[];
  readonly usedObservationIds: readonly StableId[];
  readonly perFrameResiduals: readonly PerFrameResidual[];
  /** 全部使用点上的 RMS（原始口径）。 */
  readonly rms: number;
  /** 与对手在相同有效帧+相同有效点集上的 RMS（公平口径）。 */
  readonly commonSetRms: number;
  /** 覆盖：使用帧占可比对有效帧比例。 */
  readonly coverage: number;
  readonly overfit: boolean;
  readonly exclusionJustified: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ParameterRules {
  readonly kind: "params";
  readonly id: StableId;
  readonly fairCompare: boolean;
  readonly overfitPointThreshold: number;
  readonly rmsTieTolerance: number;
  readonly note: string;
}

// ---------- 事件 / 分支 / 锁定 ----------

export type EventType =
  | "import"
  | "rollback"
  | "parameter-revision"
  | "source-revision-local"
  | "candidate-computed"
  | "decision"
  | "revert"
  | "lock"
  | "conflict"
  | "branch-fork";

export type RuleId =
  | "tilt.axis.not-defaulted-to-center"
  | "fiducial.track.may-break-and-swap-identity"
  | "candidate.compare.same-effective-point-set"
  | "candidate.compare.no-fewer-frames-for-lower-residual"
  | "candidate.ambiguity.preserve-all-legal"
  | "dependency.invalidation.local-scope"
  | "import.no-irreversible-cleanup"
  | "decision.optimistic-concurrency";

/** 对某版本实体的引用：查询时必须解析到该精确版本，缺失即损坏。 */
export interface VersionRef {
  readonly kind: string;
  readonly id: StableId;
  readonly version: Version;
  readonly digest: Digest;
}

export interface ProvenanceEvent {
  readonly id: StableId;
  readonly seq: number;
  readonly branchId: StableId;
  readonly type: EventType;
  readonly ruleId?: RuleId;
  readonly author: string;
  readonly createdAt: string;
  readonly refs: readonly VersionRef[];
  /** 失效范围（对象稳定身份列表）；无失效时为空数组，表示“显式零影响”。 */
  readonly invalidated: readonly StableId[];
  readonly payload: Record<string, unknown>;
  readonly baseRevision: number;
  readonly afterRevision: number;
}

export interface Branch {
  readonly id: StableId;
  readonly name: string;
  readonly parentBranchId?: StableId;
  readonly forkFromEventId?: StableId;
  readonly headEventId?: StableId;
  readonly headRevision: number;
}

export interface LockedAlignment {
  readonly kind: "lock";
  readonly id: StableId;
  readonly candidateRef: VersionRef;
  readonly reconstructionRef: string;
  readonly lockedBy: string;
  readonly lockedAt: string;
}

// ---------- 查询结果 ----------

export interface EntityView<T> {
  readonly kind: string;
  readonly id: StableId;
  readonly version: Version;
  readonly digest: Digest;
  readonly data: T;
  readonly refs: readonly VersionRef[];
  readonly status: "active" | "stale" | "rejected" | "locked";
}

export class CorruptionError extends Error {
  constructor(
    message: string,
    readonly missing?: VersionRef
  ) {
    super(message);
    this.name = "CorruptionError";
  }
}

export class ConflictError extends Error {
  constructor(
    message: string,
    readonly baseRevision: number,
    readonly currentRevision: number,
    readonly diff: {
      readonly base: Record<string, unknown>;
      readonly ours: Record<string, unknown>;
      readonly theirs: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = "ConflictError";
  }
}
