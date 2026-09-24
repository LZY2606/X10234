/**
 * 领域数据契约：电子断层 / 倾转序列 / fiducial 配准。
 * 直接使用领域词汇，禁止压成 name/value。
 * 所有领域量携带单位或坐标基准；导入层保留原始表示(raw*)，规范化只发生在派生层。
 */

export const RULESET_ID = "tilt-align-rules";
/** 推导规则版本：改规则必须升版本，旧事件引用的规则继续可读。 */
export const RULESET_VERSIONS = ["1.0.0", "1.1.0"] as const;
export const CURRENT_RULESET_VERSION = "1.1.0";
export const SCHEMA_ID = "tilt-align-review-archive";
export const ARCHIVE_FORMAT_VERSION = 1;

export type AngleUnit = "degrees";
export type LengthUnit = "nm" | "angstrom";
export type PixelScaleUnit = "nm/pixel" | "angstrom/pixel";
export type DoseUnit = "electrons/angstrom^2";

/** 坐标基准：探测器像素 / 倾转轴对齐坐标 / 归一化图像坐标。 */
export type CoordinateBasis = "detector_pixels" | "axis_aligned_pixels" | "normalized_image";

export interface Quantity<TUnit extends string> {
  value: number;
  unit: TUnit;
  /** 导入时的原始表示（可能是 "0.55 nm/px"、"60.0d"、"N/A" 等），永不覆盖。 */
  raw: string;
  /** 无法转换/解析时把诊断留在原值旁边，不丢值、不静默替换。 */
  diagnostic?: string;
}

export interface Point<B extends CoordinateBasis = CoordinateBasis> {
  x: number;
  y: number;
  basis: B;
  unit: "pixel" | "normalized";
}

export interface RawFrame {
  frameId: string;
  index: number;
  mediaType: "application/x-tilt-raw-u8";
  width: number;
  height: number;
  bytesDigest: string;
  byteLength: number;
  /** 原始记录描述（如文件名字段），保留原貌。 */
  provenanceNote: string;
}

export interface TiltAngleRecord {
  frameIndex: number;
  angle: Quantity<AngleUnit>;
}

export interface PixelScaleRecord {
  scaleX: Quantity<PixelScaleUnit>;
  scaleY: Quantity<PixelScaleUnit>;
  coordinateBasis: "detector";
}

export interface DoseRecord {
  frameIndex: number;
  frameDose: Quantity<DoseUnit>;
  cumulativeDose?: Quantity<DoseUnit>;
}

/** 跟踪缺口：轨迹在某帧区间没有观测，不允许用插值冒充观测。 */
export interface TrackingGap {
  fromFrameIndex: number;
  toFrameIndex: number;
  reason: "occluded" | "out_of_field" | "untracked" | "manual";
  note?: string;
}

export interface FiducialObservation extends Point<"detector_pixels"> {
  frameIndex: number;
  /** 观测置信度，由跟踪软件给出；缺失帧不以观测身份出现。 */
  confidence?: number;
}

/**
 * fiducial 轨迹：可断裂（gaps），并可能与另一条轨迹身份交换。
 * identitySwaps 记录在某帧与哪条 track 交换标签的嫌疑，配准候选必须显式处理。
 */
export interface FiducialTrack {
  trackId: string;
  observations: FiducialObservation[];
  gaps: TrackingGap[];
  identitySwapSuspectedAt?: {
    frameIndex: number;
    withTrackId: string;
    evidence: string;
  };
}

export type ExclusionReasonCode =
  | "motion_smeared"
  | "dose_too_low"
  | "tracking_lost"
  | "high_tilt_missing"
  | "operator_judgment";

export interface ManualExclusion {
  frameIndex: number;
  reasonCode: ExclusionReasonCode;
  reasonText: string;
  author: string;
  decidedAt: string;
}

/** 倾转轴：显式带截距/偏心，禁止默认固定在图像中心。 */
export interface TiltAxisEstimate {
  axisId: string;
  /** 轴在图像中的方向角（度，相对探测器 x 轴）。 */
  angle: Quantity<AngleUnit>;
  /** 轴在参考帧中心行处的横向位置（探测器像素）；与 width/2 之差即偏心。 */
  interceptX: Quantity<"pixel">;
  referenceFrameIndex: number;
  /** true 仅当来源材料显式声明轴在中心；缺省不得当作 true。 */
  fixedAtImageCenter: boolean;
  basis: "measured" | "operator_declared" | "derived";
}

export type AlignmentKind = "rigid" | "local_deformation" | "bad_frame_exclusion";

export interface PerFrameResidual {
  frameIndex: number;
  residualPx: number;
  observationCount: number;
  excluded: boolean;
}

export interface LocalWarpPatch {
  center: Point<"detector_pixels">;
  /** 每帧平移（像素），局部形变自由度。 */
  perFrameShift: Record<number, { dx: number; dy: number }>;
}

export interface AlignmentCandidate {
  candidateId: string;
  kind: AlignmentKind;
  ruleSetVersion: string;
  axis: TiltAxisEstimate;
  /** 该候选实际使用的帧（坏帧排除候选可能更小）。 */
  effectiveFrameIndices: number[];
  excludedFrames: ManualExclusion[];
  identitySwapsHandled: Array<{ frameIndex: number; trackId: string; withTrackId: string }>;
  perFrameResiduals: PerFrameResidual[];
  rmsResidualPx: number;
  /** 同样的有效点集上，刚体基线的 RMS，用于公平对照。 */
  rigidBaselineRmsOnSamePointSetPx: number;
  localWarpPatches?: LocalWarpPatch[];
  /** ambiguous 时保留全部合法解，唯一解为 unique。 */
  status: "unique" | "ambiguous" | "invalid";
  ambiguityDegreesOfFreedom?: number;
  ambiguityCompanions?: string[];
  diagnostics: string[];
}

export type AdjudicationDecision =
  | "accepted"
  | "rejected"
  | "parameter_revision_requested";

export interface Adjudication {
  adjudicationId: string;
  decision: AdjudicationDecision;
  candidateId: string;
  candidateVersion: number;
  parentAdjudicationId: string | null;
  author: string;
  note: string;
  at: string;
  /** 乐观并发：基于的分支头，后提交者冲突时双方差异都给出。 */
  baseHeadEventId: string | null;
}

export interface ReconstructionLock {
  lockId: string;
  candidateId: string;
  candidateVersion: number;
  adjudicationId: string;
  lockedAt: string;
}

/** 机器可读事件码：判定依据以事件而非口头说明保存。 */
export type EventCode =
  | "MATERIAL_VERSIONED"
  | "INTERPRETATION_BRANCH_CREATED"
  | "RULESET_APPLIED"
  | "AXIS_ECCENTRICITY_DETECTED"
  | "TRACK_IDENTITY_SWAP_SUSPECTED"
  | "HIGH_TILT_FRAME_MISSING"
  | "BAD_FRAME_EXCLUDED"
  | "CANDIDATE_COMPARED_ON_SAME_POINT_SET"
  | "LOCAL_DEFORM_OVERFIT_DIAGNOSED"
  | "MULTIPLE_SOLUTIONS_RETAINED"
  | "CONCURRENT_FREEZE_CONFLICT"
  | "ADJUDICATION_RECORDED"
  | "ADJUDICATION_UNDONE"
  | "ALIGNMENT_LOCKED_FOR_RECONSTRUCTION"
  | "DEPENDENCY_INVALIDATION_COMPUTED"
  | "ARCHIVE_EXPORTED"
  | "ARCHIVE_IMPORTED"
  | "CORRUPTION_DETECTED";

export interface DomainEvent {
  eventId: string;
  seq: number;
  branchId: string;
  at: string;
  code: EventCode;
  message: string;
  payload: Record<string, unknown>;
  /** 该事件直接依赖的实体版本，溯源链逐跳保存。 */
  refs: Array<{ entityId: string; version: number; digest: string }>;
  baseHeadEventId: string | null;
}

export type EntityKind =
  | "tilt_series"
  | "tilt_axis"
  | "alignment_candidate"
  | "adjudication"
  | "reconstruction_lock";

/** 查询任一实体返回的信封：版本号 + 内容摘要 + 引用版本，缺引用即损坏。 */
export interface EntityEnvelope<T = unknown> {
  entityId: string;
  kind: EntityKind;
  version: number;
  digest: string;
  createdAt: string;
  branchId: string;
  body: T;
  refs: Array<{ entityId: string; version: number; digest: string; role: string }>;
  derivedFromRuleSetVersion?: string;
}

export interface BranchState {
  branchId: string;
  label: string;
  materialId: string;
  materialVersion: number;
  headEventId: string | null;
  createdAt: string;
  status: "active" | "frozen" | "conflicted";
}

export interface ArchiveManifest {
  schemaId: typeof SCHEMA_ID;
  formatVersion: number;
  archiveId: string;
  createdAt: string;
  note: string;
}

export interface ArchiveFile {
  manifest: ArchiveManifest;
  fragments: Array<{ digest: string; mediaType: string; byteLength: number; bytesBase64: string }>;
  entities: Array<{
    entityId: string;
    kind: EntityKind;
    version: number;
    digest: string;
    branchId: string;
    createdAt: string;
    bodyJson: string;
    derivedFromRuleSetVersion: string | null;
    refs: Array<{ entityId: string; version: number; digest: string; role: string }>;
  }>;
  branches: BranchState[];
  events: DomainEvent[];
  locks: ReconstructionLock[];
}

export class CorruptionError extends Error {
  constructor(
    public readonly missing: Array<{ entityId: string; version?: number }>,
    message: string
  ) {
    super(message);
    this.name = "CorruptionError";
  }
}

export class VersionConflictError extends Error {
  constructor(
    public readonly serverHeadEventId: string,
    public readonly clientBaseHeadEventId: string,
    public readonly serverDiff: unknown,
    public readonly clientDiff: unknown
  ) {
    super("VERSION_CONFLICT");
    this.name = "VersionConflictError";
  }
}

/** 领域判断依据：候选对比必须共享同一有效点集，不允许用少帧换低残差。 */
export const JUDGMENT_MAXIMS = [
  {
    id: "axis-not-center",
    text: "倾转轴不能被默认固定在图像中心",
    eventCodes: ["AXIS_ECCENTRICITY_DETECTED"]
  },
  {
    id: "tracks-can-break-and-swap",
    text: "fiducial 轨迹可断裂且可能身份交换",
    eventCodes: ["TRACK_IDENTITY_SWAP_SUSPECTED"]
  },
  {
    id: "same-effective-point-set",
    text: "不同候选用相同有效点集比较，不用少帧换低残差",
    eventCodes: ["CANDIDATE_COMPARED_ON_SAME_POINT_SET", "BAD_FRAME_EXCLUDED"]
  }
] as const;
