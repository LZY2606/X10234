// 领域数据契约：电子断层 / 倾转序列 / fiducial 配准审阅
// 所有领域量携带单位或坐标基准；原始表示(rawText/rawTextList)在导入层保留，
// 规范化只发生在派生层，无法转换的值留在原位并附诊断。

export type FrameId = string;
export type TrackId = string;

export type AngleUnit = "deg";
export const ANGLE_UNIT: AngleUnit = "deg";

export interface PhysicalAngle {
  value: number;
  unit: AngleUnit;
}

export interface PixelScale {
  value: number;
  unit: "nm/px";
}

export interface ElectronDose {
  value: number | null; // null => 无法转换，保留 rawText 并附诊断
  unit: "e-/A^2";
}

/** 图像坐标基准：原点、轴向、画幅，本身有稳定 id 并被点坐标引用 */
export interface ImageBasis {
  basisId: string;
  origin: "top-left";
  axes: ["x-right", "y-down"];
  widthPx: number;
  heightPx: number;
}

export interface PixelPoint {
  x: number;
  y: number;
  basisId: string;
}

export interface ConversionDiagnostic {
  code:
    | "dose.unparseable"
    | "angle.out-of-range"
    | "pixel-scale.missing"
    | "observation.outside-basis"
    | "gap.no-observation"
    | "exclusion.unknown-frame";
  at: string; // 字段路径，如 frame#13.dose
  rawText: string;
  message: string;
}

/** 原始帧：像素字节以内容哈希寻址，帧实体只引用不可变片段 */
export interface RawFrame {
  frameId: FrameId;
  order: number;
  widthPx: number;
  heightPx: number;
  encoding: "uint16-le";
  pixelFragmentHash: string;
  quality: "ok" | "motion-blur" | "over-exposed";
}

export interface TiltAngleRecord {
  frameId: FrameId;
  angle: PhysicalAngle;
  rawText: string;
}

export interface PixelScaleRecord {
  scope: "series" | "frame";
  frameId?: FrameId;
  scale: PixelScale;
  rawText: string;
}

export interface DoseRecord {
  frameId: FrameId;
  dose: ElectronDose;
  rawText: string;
}

export interface FiducialObservation {
  segmentId: string; // 原始跟踪器给出的段标签；轨迹身份由链接集解释
  frameId: FrameId;
  position: PixelPoint;
  uncertaintyPx: number;
  rawText: string;
}

export interface TrackingGap {
  gapId: string;
  trackId: TrackId;
  missingFrameId: FrameId;
  reason: "occluded" | "outside-field" | "tracker-lost" | "manual";
  rawText: string;
}

export interface ManualExclusion {
  frameId: FrameId;
  reason: string;
  rawText: string;
  decidedBy: string;
}

/** 同一物理标记点在可见区间内的连续观测段；段之间可能断裂、身份可能交换 */
export interface TrackSegment {
  segmentId: string;
  trackId: TrackId;
  observedFrameIds: FrameId[];
  state: "confirmed" | "proposed";
}

export interface IdentityLinkProposal {
  linkId: string;
  leftSegmentId: string;
  rightSegmentId: string;
  status: "proposed" | "accepted" | "rejected";
  note: string;
}

/** 一版段->轨迹的身份解释（链接集）：同一批观测可有多个竞争链接集 */
export interface LinkSet {
  linkSetId: string;
  label: string;
  links: IdentityLinkProposal[];
  note: string;
}

/**
 * 倾转轴估计。offset 为 null 表示该自由度尚未从数据决定（自由量），
 * 绝不隐式取画幅中心；centeredAssumption=true 仅表示“这一版解释”采用
 * 了居中假设，后续修订是新版本，不覆盖旧版。
 */
export interface TiltAxisEstimate {
  axisId: string;
  basisId: string;
  offsetXPx: number | null;
  offsetYPx: number | null;
  directionDeg: number;
  centeredAssumption: boolean;
  note: string;
}

/** 候选使用的观测集合身份：链接集 + (track,frame) 对的规范化摘要 */
export interface EffectivePointSet {
  linkSetId: string;
  pointsHash: string;
  pairs: Array<{ trackId: TrackId; frameId: FrameId }>;
  frameCount: number;
  trackCount: number;
}

export type CandidateKind = "rigid" | "local-deformation" | "rigid-excluded";

export interface PerFrameResidual {
  frameId: FrameId;
  rmsPx: number;
  used: boolean;
  maxAbsPx: number;
}

export interface AxisSolutionAlternative {
  originXPx: number;
  originYPx: number;
  directionDeg: number;
  rmsResidualPx: number;
}

export interface RegistrationCandidate {
  candidateId: string;
  kind: CandidateKind;
  interpretationId: string;
  linkSetId: string;
  axisRef: { axisId: string; version: number };
  pointSet: EffectivePointSet;
  excludedFrameIds: FrameId[];
  rmsResidualPx: number;
  holdoutRmsPx: number | null;
  degreesOfFreedom: number;
  perFrame: PerFrameResidual[];
  diagnostics: CandidateDiagnostic[];
  ruleChecks: RuleCheckResult[];
  params: CandidateParams;
  alternateSolutions: AxisSolutionAlternative[];
}

export interface CandidateParams {
  axisOffsetXPx: number | null;
  axisOffsetYPx: number | null;
  axisDirectionDeg: number;
  frameShiftsPx: Record<FrameId, { dx: number; dy: number }>;
  localWarpAmplitudePx: number | null;
}

export interface CandidateDiagnostic {
  code:
    | "axis.center-default"
    | "axis.estimated-offset"
    | "track.identity-swap"
    | "coverage.high-tilt-missing"
    | "frame.bad-excluded"
    | "local.overfit"
    | "solution.non-unique"
    | "points.fewer-than-peer";
  severity: "info" | "warning" | "blocker";
  message: string;
  frameIds?: FrameId[];
  trackIds?: TrackId[];
}

export interface RuleCheckResult {
  ruleId: string;
  passed: boolean;
  evidence: string;
}

export type AdjudicationVerdict = "accepted" | "rejected";

export interface RegistrationAdjudication {
  adjudicationId: string;
  candidateId: string;
  verdict: AdjudicationVerdict;
  reason: string;
  decidedBy: string;
  undone: boolean;
}

export interface LockedRegistration {
  lockId: string;
  candidateRef: { candidateId: string; version: number };
  note: string;
  lockedBy: string;
}

/** 解释：同一批原始材料的一次重新理解（轴线、链接集、排除集都是版本化的） */
export interface Interpretation {
  interpretationId: string;
  label: string;
  axisId: string;
  axisVersion: number;
  linkSetId: string;
  excludedFrameIds: FrameId[];
  note: string;
}

export type EventType =
  | "source.imported"
  | "source.reinterpreted"
  | "axis.revised"
  | "identity.links-proposed"
  | "identity.links-decided"
  | "candidate.computed"
  | "candidate.invalidated"
  | "adjudication.recorded"
  | "adjudication.undone"
  | "registration.locked"
  | "registration.unlocked"
  | "branch.conflict-detected"
  | "branch.frozen"
  | "diagnostic.recorded";

export interface EventRef {
  entityId: string;
  version: number;
  kind: string;
  contentSummary: string;
}

export interface ReviewEvent {
  eventId: string;
  branchId: string;
  parentEventId: string | null;
  seq: number;
  at: string;
  actor: string;
  type: EventType;
  summary: string;
  payload: Record<string, unknown>;
  ruleIds: string[];
  refs: EventRef[];
}

export interface Branch {
  branchId: string;
  name: string;
  scenarioCode: string;
  variant: "baseline" | "minimal" | "combined";
  parentBranchId: string | null;
  forkedFromEventSeq: number | null;
  createdAt: string;
  frozen: boolean;
}

export interface EntityView<T = unknown> {
  stableId: string;
  version: number;
  kind: string;
  content: T;
  contentHash: string;
  createdSeq: number;
  createdEventId: string;
  refs: EventRef[];
}
