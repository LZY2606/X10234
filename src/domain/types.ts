/**
 * 领域词汇表：倾转帧拼合室（tilt-series alignment review room）
 * 这里刻意不使用通用 name/value，全部采用电子断层成像自己的实体与量纲。
 */

export type AngleUnit = "deg" | "rad";
export type PixelScaleUnit = "nm/px" | "um/px" | "A/px";
export type DoseUnit = "e-/A^2" | "e-/nm^2" | "e-/A^2/frame" | "unknown";
export type CoordinateBasis =
  | "image:top-left:x-right-y-down:px"
  | "image:center:x-right-y-up:px"
  | "stage:unknown";

export interface Diagnostic {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}

/** 导入时保留原始表示；value 无法转换时为 null，诊断挂在原位置，派生层才做规范化 */
export interface Measured<U extends string> {
  raw: string;
  unit: U | "unknown";
  value: number | null;
  normalized?: { value: number; unit: string };
  diagnostics: Diagnostic[];
}

export type FrameStatus = "present" | "missing";

export interface RawFrame {
  frameId: string; // 稳定身份，如 frame:000
  version: number;
  acquisitionIndex: number;
  fileStem: string;
  status: FrameStatus;
  /** 图像坐标基准；像素坐标的解释以此为准 */
  coordinateBasis: CoordinateBasis;
  /** 不可变像素字节的内容寻址引用（原始帧片段只存一份） */
  blobId: string | null;
  checksumSha256: string | null;
  width: number | null;
  height: number | null;
  diagnostics: Diagnostic[];
}

export interface TiltAngle {
  frameId: string;
  version: number;
  angle: Measured<AngleUnit>; // 归一化单位 deg
}

export interface PixelScale {
  scopeLevel: "series";
  version: number;
  scale: Measured<PixelScaleUnit>; // 归一化单位 nm/px
}

export interface ExposureDose {
  frameId: string;
  version: number;
  dose: Measured<DoseUnit>; // 归一化单位 e-/A^2
}

export type TrackStatus = "continuous" | "broken" | "identity_swapped";

export interface TrackSegment {
  segmentId: string;
  frameIdFrom: string;
  frameIdTo: string;
  note?: string;
}

export interface FiducialTrack {
  trackId: string; // 如 track:A
  version: number;
  status: TrackStatus;
  /** 断裂时的分段；身份交换时与另一轨迹交换后的段在这里显式记录 */
  segments: TrackSegment[];
  swappedWith: string | null;
  diagnostics: Diagnostic[];
}

export interface FiducialObservation {
  observationId: string; // 如 obs:A@frame:003
  version: number;
  trackId: string;
  frameId: string;
  /** 像素坐标（坐标基准随帧） */
  x: Measured<"px">;
  y: Measured<"px">;
  present: boolean; // 缺口处无观测
  diagnostics: Diagnostic[];
}

export type GapReason = "out-of-field" | "occluded" | "untracked" | "not-acquired";

export interface TrackingGap {
  gapId: string;
  version: number;
  trackId: string;
  frameIdFrom: string;
  frameIdTo: string;
  reason: Measured<GapReason>;
}

export interface ManualExclusion {
  exclusionId: string;
  version: number;
  targetKind: "frame" | "observation";
  targetId: string;
  reason: Measured<string>;
  actor: string;
  active: boolean;
}

/** 倾转轴参数（解释层）。禁止默认固定在图像中心，除非显式声明 fixedCenter=true */
export interface TiltAxisParams {
  axisParamsId: string;
  version: number;
  /** 零倾转角时轴线在图像 x 方向的截距（px），允许偏心 */
  interceptX: number;
  /** 轴线相对图像 y 轴的夹角（deg） */
  axisAngleDeg: number;
  fixedCenter: boolean;
  assumedImageCenterX: number | null;
  diagnostics: Diagnostic[];
}

export type CandidateKind = "rigid" | "local_warp" | "frame_exclusion";

export interface PerFrameResidual {
  frameId: string;
  pointCount: number;
  rmsPx: number | null;
  excluded: boolean;
}

export interface RegCandidate {
  candidateId: string;
  version: number;
  branchId: string;
  kind: CandidateKind;
  label: string;
  /** 该候选实际使用的有效点集（observationId 排序），不同候选必须用同一集合比较 */
  effectivePointSet: string[];
  effectivePointSetHash: string;
  usedFrames: string[];
  comparedOnCommonSet: boolean;
  frameExclusions: string[];
  params: Record<string, unknown>;
  perFrameResidual: PerFrameResidual[];
  inSampleRmsPx: number | null;
  /** 留出点 RMS：局部形变是否过拟合据此判定 */
  heldOutRmsPx: number | null;
  warpPenalty: number | null;
  overfit: boolean;
  coverage: { framesPresent: number; framesUsed: number; highTiltMissing: string[] };
  diagnostics: Diagnostic[];
  status: "proposed" | "accepted" | "rejected" | "superseded";
}

export type BranchLabel = "main" | "axis-eccentric" | string;

export interface Branch {
  branchId: string;
  parentBranchId: string | null;
  label: BranchLabel;
  createdAt: string;
}

export type DecisionKind = "accept" | "reject" | "revert" | "param_revision";

export interface Adjudication {
  decisionId: string;
  version: number;
  branchId: string;
  candidateId: string | null;
  kind: DecisionKind;
  actor: string;
  note: string;
  revertsDecisionId: string | null;
  eventId: string;
}

export interface RegistrationLock {
  lockId: string;
  version: number;
  candidateId: string;
  active: boolean;
  actor: string;
  purpose: "reconstruction-reference";
  eventId: string;
}

/** 机器可读事件类型（判断依据） */
export type EventType =
  | "source.imported"
  | "source.revised"
  | "source.local_change"
  | "source.import_rollback"
  | "axis.center_assumption_rejected"
  | "axis.params_revised"
  | "track.broken"
  | "track.identity_swapped"
  | "frame.high_tilt_missing"
  | "frame.excluded"
  | "frame.exclusion_revoked"
  | "candidate.proposed"
  | "candidate.overfit_flagged"
  | "candidate.ambiguous_multiple_solutions"
  | "candidate.compared_common_pointset"
  | "decision.accepted"
  | "decision.rejected"
  | "decision.reverted"
  | "registration.locked"
  | "registration.unlocked"
  | "invalidation.scope_computed"
  | "conflict.concurrent_save"
  | "archive.exported"
  | "archive.imported";

export interface VersionRef {
  kind: string;
  id: string;
  version: number;
}

export interface DomainEvent {
  eventId: string;
  seq: number;
  branchId: string;
  type: EventType;
  occurredAt: string;
  actor: string;
  parentEventId: string | null;
  /** 该事件引用的全部实体版本；读回实体时必须能解析，否则报损坏 */
  refs: VersionRef[];
  /** 受影响对象（输入片段/候选/帧） */
  affected: string[];
  payload: Record<string, unknown>;
  contentSha256: string;
}

export interface InvalidationScope {
  scopeId: string;
  causeEventId: string;
  /** 依赖计算得到的失效范围（不是全局替换） */
  invalidatedRefs: VersionRef[];
  preservedRefs: VersionRef[];
  note: string;
}

export interface EntityEnvelope<T = unknown> {
  kind: string;
  id: string;
  version: number;
  contentSummary: string;
  refs: VersionRef[];
  body: T;
}

export class CorruptionError extends Error {
  constructor(
    public readonly missingRef: VersionRef | string,
    public readonly fromEntity: string,
  ) {
    super(
      `档案损坏：${fromEntity} 引用的 ${
        typeof missingRef === "string" ? missingRef : `${missingRef.kind}:${missingRef.id}@v${missingRef.version}`
      } 缺失；拒绝回退到最新版`,
    );
    this.name = "CorruptionError";
  }
}
