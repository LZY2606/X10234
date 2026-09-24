/**
 * 领域数据契约：电子断层 / 倾转序列 / 配准审阅。
 *
 * 设计约束：
 * - 输入实体 = 原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、手工排除原因（全部版本化）。
 * - 决定实体 = 倾转轴（不可默认图像中心）、fiducial 轨迹（可断裂、可身份交换）、
 *   配准候选（刚体 / 局部形变 / 排除坏帧），不同候选必须用相同有效点集比较。
 * - 复核实体 = 帧叠影、轴线、轨迹断点、每帧残差、候选差分、冻结版本。
 * - 所有领域量携带单位或坐标基准，导入时保留原始表示 raw，派生层才规范化。
 */

export type StableId = string;

/** 带原始表示的领域量。无法转换时 value=null 并附 diagnostic，不得为画图丢弃。 */
export interface Quantity {
  raw: string;
  value: number | null;
  unit: string;
  basis: string;
  diagnostic?: string;
}

export type MediaType = 'image/x-portable-graymap';

/* ---------------- 输入实体（原始来源层，全部版本化） ---------------- */

export interface RawFrame {
  id: StableId;
  index: number;
  mediaType: MediaType;
  contentHash: string;
  width: number;
  height: number;
  acquisitionBasis: string;
}

export interface TiltAngleRecord {
  id: StableId;
  frameId: StableId;
  angle: Quantity;
  acquisitionSource: string;
}

export interface PixelScaleRecord {
  id: StableId;
  frameId: StableId | '*';
  scaleX: Quantity;
  scaleY: Quantity;
  basis: string;
}

export interface DoseRecord {
  id: StableId;
  frameId: StableId;
  cumulativeDose: Quantity;
  exposureTime: Quantity | null;
}

export interface MarkerCoordinate {
  markerId: StableId;
  frameId: StableId;
  x: Quantity;
  y: Quantity;
  present: boolean;
  identityLabel: string;
  source: string;
}

export interface TrackGap {
  id: StableId;
  markerId: StableId;
  firstMissingFrameId: StableId;
  lastMissingFrameId: StableId;
  reason: string;
}

export type ExclusionReasonCode =
  | 'excessive-drift'
  | 'stage-motion-artifact'
  | 'low-dose-noise'
  | 'other';

export interface ManualExclusion {
  id: StableId;
  frameId: StableId;
  reasonText: string;
  reasonCode: ExclusionReasonCode;
  decidedBy: string;
}

/* ---------------- 决定实体（解释层，多候选、可分支） ---------------- */

export interface TiltAxisEstimate {
  id: StableId;
  x: number;
  y: number;
  angleDeg: number;
  assumedCenter: boolean;
  basis: string;
  supportingMarkerIds: StableId[];
  ambiguityWith: StableId | null;
}

export interface TrackSegment {
  markerId: StableId;
  segmentIndex: number;
  frameIds: StableId[];
}

export interface IdentitySwap {
  atFrameId: StableId;
  fromMarkerId: StableId;
  toMarkerId: StableId;
  basis: string;
}

export interface FiducialTrackInterpretation {
  id: StableId;
  physicalMarkerKey: StableId;
  segments: TrackSegment[];
  identitySwaps: IdentitySwap[];
}

export type RegistrationModelKind = 'rigid' | 'local-warp' | 'rigid-exclusion';

export interface FrameTransform {
  frameId: StableId;
  tx: number;
  ty: number;
  rotRad: number;
  included: boolean;
  excludedReason: string | null;
}

export interface MarkerResidual {
  markerId: StableId;
  dx: number;
  dy: number;
}

export interface FrameResidual {
  frameId: StableId;
  included: boolean;
  rms: number;
  max: number;
  perMarker: MarkerResidual[];
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  affectedIds: StableId[];
}

export type DiagnosticCode =
  | 'axis-assumed-center'
  | 'axis-offset'
  | 'identity-swap'
  | 'track-gap'
  | 'missing-high-tilt-frame'
  | 'bad-frame-excluded'
  | 'unjustified-frame-exclusion'
  | 'local-warp-overfit'
  | 'multi-solution'
  | 'point-set-mismatch'
  | 'unconvertible-quantity'
  | 'concurrent-freeze-conflict';

export interface CandidateScore {
  rms: number;
  max: number;
  weightedRms: number;
}

export interface RegistrationCandidate {
  id: StableId;
  branchId: StableId;
  modelKind: RegistrationModelKind;
  label: string;
  axisId: StableId;
  transforms: FrameTransform[];
  effectiveFrameIds: StableId[];
  effectiveMarkerSet: StableId[];
  effectivePointSetFingerprint: string;
  frameResiduals: FrameResidual[];
  score: CandidateScore;
  degreeOfFreedom: number;
  diagnostics: Diagnostic[];
  basedOnParameterVersion: number;
  basedOnSourceVersion: number;
}

export interface CandidateDifference {
  id: StableId;
  fromCandidateId: StableId;
  toCandidateId: StableId;
  sharedPointSet: boolean;
  perFrameDeltaRms: { frameId: StableId; delta: number }[];
  rmsDelta: number;
  note: string;
}

export type AdjudicationDecision =
  | 'accept'
  | 'reject'
  | 'parameter-adjust';

export interface Adjudication {
  id: StableId;
  branchId: StableId;
  decision: AdjudicationDecision;
  candidateId: StableId | null;
  reason: string;
  revertedAdjudicationId: StableId | null;
}

export interface FrozenRegistration {
  id: StableId;
  candidateId: StableId;
  eventId: StableId;
  reconstructionRef: StableId;
}

/* ---------------- 事件（机器可读的判断依据） ---------------- */

export type EventCode =
  | 'raw.ingested'
  | 'tilt.ingested'
  | 'pixelscale.ingested'
  | 'dose.ingested'
  | 'marker.ingested'
  | 'gap.ingested'
  | 'exclusion.ingested'
  | 'import.rolled-back'
  | 'branch.created'
  | 'interpretation.axis-offset'
  | 'interpretation.identity-swap'
  | 'interpretation.track-gap'
  | 'parameter.revised'
  | 'source.local-patched'
  | 'reference.changed'
  | 'dependency.invalidated'
  | 'candidate.created'
  | 'candidate.comparison'
  | 'diagnostic.missing-high-tilt'
  | 'diagnostic.bad-frame'
  | 'diagnostic.local-warp-overfit'
  | 'diagnostic.multi-solution'
  | 'diagnostic.concurrent-freeze'
  | 'adjudication.accepted'
  | 'adjudication.rejected'
  | 'adjudication.parameter-adjusted'
  | 'adjudication.reverted'
  | 'registration.frozen';

export interface EventRef {
  kind: string;
  id: StableId;
  version: number;
  contentSummary: string;
}

export interface EventRecord {
  id: StableId;
  caseId: StableId;
  branchId: StableId;
  seq: number;
  parentEventId: StableId | null;
  timestamp: string;
  code: EventCode;
  payload: unknown;
  refs: EventRef[];
  baseBranchHead: StableId | null;
}

export interface VersionedEntity<T = unknown> {
  kind: string;
  id: StableId;
  version: number;
  contentSummary: string;
  createdByEventId: StableId;
  supersededByEventId: StableId | null;
  data: T;
}

/* ---------------- 反例场景 ---------------- */

export type ScenarioKind =
  | 'axis-offset'
  | 'identity-swap'
  | 'missing-high-tilt'
  | 'bad-frame'
  | 'local-warp-overfit'
  | 'multi-solution'
  | 'concurrent-freeze';

export interface ScenarioRecord {
  kind: ScenarioKind;
  minimalInputRef: string;
  combinedInputRef: string;
  diagnosticCodes: DiagnosticCode[];
  adoptedResultId: StableId | null;
  rejectedResultIds: StableId[];
}

/* ---------------- 查询与损坏 ---------------- */

export class ReferenceCorruptionError extends Error {
  constructor(
    public readonly missing: EventRef,
    public readonly fromEventId: StableId,
  ) {
    super(
      `损坏的引用：事件 ${fromEventId} 引用 ${missing.kind}:${missing.id}@v${missing.version}，该版本不存在（不允许退回最新版）`,
    );
    this.name = 'ReferenceCorruptionError';
  }
}

export class ConflictError extends Error {
  constructor(
    public readonly branchId: StableId,
    public readonly expectedHead: StableId,
    public readonly actualHead: StableId,
    public readonly baseEventId: StableId,
    public readonly competingEventId: StableId,
  ) {
    super(`版本冲突：分支 ${branchId} 已被并发提交推进`);
    this.name = 'ConflictError';
  }
}
