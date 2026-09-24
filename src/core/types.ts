/**
 * 倾转帧拼合室 —— 领域数据契约
 *
 * 直接使用电子断层领域词汇，不使用通用 name/value 表。
 * 所有领域量携带单位或坐标基准；导入时保留原始表示（raw*），派生层才规范化。
 * 无法转换的值留在原位置并附诊断，绝不因画图而丢弃。
 */

export type Unit =
  | "deg"
  | "rad"
  | "nm"
  | "um"
  | "pixel"
  | "e-/A^2"
  | "e-/nm^2"
  | "counts"
  | "dimensionless";

/** 带单位与原始表示的领域量。无法转换时 value 为 null 并写诊断。 */
export interface DomainQuantity {
  value: number | null;
  unit: Unit;
  rawText: string;
  rawUnit?: string;
  /** 归一化到 SI/标准单位后的值（角度=deg，距离=nm，剂量=e-/A^2），可能为空 */
  normalized: number | null;
  diagnostics: string[];
}

/** 像素坐标，坐标基准明确声明（image-origin: 左上角，x 右 y 下）。 */
export interface PixelPoint {
  x: number;
  y: number;
  frameId: string;
  frameIndex: number;
  frameRef: string;
  coordinateBasis: "image-origin-px";
}

export type SourceKind = "original-frames" | "tilt-angles" | "pixel-scale" | "dose"
  | "marker-coordinates" | "tracking-gaps" | "manual-exclusions";

export type InterpretationKind = "tilt-axis" | "trajectory" | "candidate";
export type DecisionKind = "adjudication" | "rule-version";
export type SystemKind = "archive-rule-event";

export type EventKind = SourceKind | InterpretationKind | DecisionKind | SystemKind;
export type EventClass = "source" | "interpretation" | "decision" | "system";

/** 一帧原始投影图像（内容寻址；原始字节不可变，只存一份）。 */
export interface FrameImageBlob {
  blobId: string;
  sha256: string;
  byteLength: number;
  encoding: "raw-uint8-mono" | "ppm-p6-rgb" | "unknown";
  width: number | null;
  height: number | null;
  originalFilename: string | null;
  diagnostics: string[];
}

export interface RawFrame {
  frameId: string;
  frameIndex: number;
  blobRef: string;
  exposureLabel: string;
  acquiredAt: string | null;
  diagnostics: string[];
}

export interface TiltAngle {
  frameId: string;
  frameRef: string;
  angle: DomainQuantity;
}

export interface PixelScale {
  frameId: string;
  frameRef: string;
  /** 每像素代表的样品面尺寸，单位必须是长度单位 */
  pixelSize: DomainQuantity;
}

export interface ExposureDose {
  frameId: string;
  frameRef: string;
  frameDose: DomainQuantity;
  cumulativeDose: DomainQuantity | null;
}

export interface MarkerCoordinate {
  markerId: string;
  frameId: string;
  frameRef: string;
  point: PixelPoint;
  residualPx: number | null;
}

export interface TrackingGap {
  trajectoryId: string;
  markerId: string;
  fromFrameIndex: number;
  toFrameIndex: number;
  reasonCode: "out-of-field" | "occluded" | "low-contrast" | "unconverted-unit" | "manual";
  note: string;
  frameRefs: string[];
}

export interface ManualExclusion {
  frameId: string;
  frameRef: string;
  reasonCode: "motion-blur" | "too-few-fiducials" | "crack" | "drift-jump" | "dose-damage" | "reviewer";
  reasonText: string;
  reviewer: string;
}

/**
 * 倾转轴。关键判断：不能默认固定在图像中心。
 * 轴线以“过点 (axisOffsetX, axisOffsetY)、方向角 axisAngleDeg”表示；
 * 若数据无法唯一决定轴线，ambiguous=true 并保留多个合法解。
 */
export interface TiltAxis {
  axisId: string;
  axisAngleDeg: number | null;
  axisOffsetX: number | null;
  axisOffsetY: number | null;
  offsetUnit: "pixel";
  centeredByDefault: boolean;
  ambiguous: boolean;
  ambiguityReason: string | null;
  alternativeAxes: TiltAxis[];
  basedOnRuleVersion: string;
  diagnostics: string[];
}

export interface TrajectorySegment {
  markerId: string;
  startFrameIndex: number;
  endFrameIndex: number;
  coordinateRefs: string[];
}

/**
 * fiducial 轨迹：可断裂（segments + gaps），可能发生身份交换（identitySwaps）。
 */
export interface Trajectory {
  trajectoryId: string;
  segments: TrajectorySegment[];
  gapRefs: string[];
  identitySwaps: IdentitySwap[];
}

export interface IdentitySwap {
  atFrameIndex: number;
  frameRef: string;
  markerIdA: string;
  markerIdB: string;
  evidence: string;
  resolved: boolean;
}

export type TransformModel = "rigid" | "local-warp" | "rigid-drop-bad-frames";

export interface PerFrameResidual {
  frameId: string;
  frameRef: string;
  frameIndex: number;
  rmsPx: number;
  usedPoints: number;
  dropped: boolean;
}

export interface CandidateComparison {
  withCandidateId: string;
  sameEffectivePointSet: boolean;
  effectiveFrameIdsA: string[];
  effectiveFrameIdsB: string[];
  rmsDeltaPx: number | null;
  frameCountDelta: number;
  unfairAdvantage: boolean;
  note: string;
}

export interface RegistrationCandidate {
  candidateId: string;
  label: string;
  model: TransformModel;
  axisRef: string;
  trajectoryRef: string;
  ruleVersionRef: string;
  /** 有效点集：该候选实际使用的 (frameId, markerId) 列表，公平比较的依据 */
  effectivePointSet: string[];
  effectiveFrameIds: string[];
  excludedFrameIds: string[];
  perFrameResiduals: PerFrameResidual[];
  overallRmsPx: number;
  overfit: boolean;
  overfitEvidence: string | null;
  warpControlPoints: number;
  multiSolution: boolean;
  equivalentCandidateIds: string[];
  comparisons: CandidateComparison[];
  diagnostics: string[];
}

export type AdjudicationVerdict = "accepted" | "rejected";

export interface Adjudication {
  adjudicationId: string;
  candidateRef: string;
  verdict: AdjudicationVerdict;
  reviewer: string;
  rationale: string;
  /** 接受时锁定；供重建引用读回 */
  lockedForReconstruction: boolean;
  /** 撤销某条裁定时记录被撤销裁定的引用，形成可回退分支 */
  undoesAdjudicationRef: string | null;
}

export interface RuleVersion {
  ruleVersionId: string;
  semver: string;
  notes: string;
}

/** 机器可读的判断依据事件（领域规则触发记录）。 */
export interface JudgmentEvent {
  code:
    | "AXIS_NOT_CENTERED"
    | "AXIS_AMBIGUOUS_MULTI_SOLUTION"
    | "TRAJECTORY_BROKEN"
    | "IDENTITY_SWAP_DETECTED"
    | "MISSING_HIGH_TILT_FRAMES"
    | "BAD_FRAME_EXCLUDED"
    | "LOCAL_WARP_OVERFIT"
    | "MULTIPLE_SOLUTIONS_RETAINED"
    | "UNFAIR_FEWER_FRAMES_RMS"
    | "CONCURRENT_FREEZE_CONFLICT"
    | "UNCONVERTIBLE_VALUE_PRESERVED"
    | "CORRUPT_MISSING_REFERENCE";
  severity: "info" | "warning" | "error";
  message: string;
  subjectRefs: string[];
  evidence: Record<string, unknown>;
}

export interface ArchiveEvent {
  eventId: string;
  seq: number;
  branchId: string;
  parentEventId: string | null;
  kind: EventKind;
  eventClass: EventClass;
  at: string;
  actor: string;
  payload: Record<string, unknown>;
  judgments: JudgmentEvent[];
  /** 该事件引用的版本号（实体@版本）与内容摘要；查询实体时必须回带 */
  refs: string[];
  contentDigest: string;
}

export interface Branch {
  branchId: string;
  parentBranchId: string | null;
  label: string;
  /** 分支被冻结（多解/冲突挂起）时为 true */
  frozen: boolean;
  freezeReason: string | null;
  headEventId: string | null;
  createdAt: string;
}

export interface VersionedRef {
  ref: string;
  version: number;
  kind: string;
  contentDigest: string;
  summary: string;
}
