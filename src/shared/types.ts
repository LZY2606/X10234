import type { Quantity } from "./units";

/** 坐标基准：所有坐标都显式声明基准，避免把像素坐标和对齐后坐标混用。 */
export type CoordinateBasis = "raw-frame-pixels" | "aligned-pixels" | "nm";

export interface PointCoordinate {
  basis: CoordinateBasis;
  x: number;
  y: number;
}

/** ===== 来源层实体：原始材料，全部版本化、不可变 ===== */

export interface RawFrame {
  id: string;
  indexOrder: number;
  width: number;
  height: number;
  bytesDigest: string;
  encoding: "uint8-raw";
  rawFileName: string;
}

export interface TiltAngle {
  id: string;
  frameId: string;
  indexOrder: number;
  angle: Quantity;
  sourceLabel: string;
}

export interface PixelScale {
  id: string;
  frameId: string | null;
  indexOrder: number;
  scale: Quantity;
  sourceLabel: string;
}

export interface FrameDose {
  id: string;
  frameId: string;
  indexOrder: number;
  dose: Quantity;
  exposureSeconds: number | null;
  sourceLabel: string;
}

export interface FiducialObservation {
  id: string;
  frameId: string;
  trackLabel: string;
  at: PointCoordinate;
  sourceLabel: string;
}

export interface TrackGap {
  id: string;
  trackLabel: string;
  missingFrameIds: string[];
  reason: "tracking-lost" | "occluded" | "out-of-field" | "untrusted";
  note: string;
}

export interface ManualFrameExclusion {
  id: string;
  frameId: string;
  reasonCode: "motion-blur" | "too-many-fiducials-lost" | "crack-in-film" | "wrong-tilt" | "duplicate-exposure" | "custom";
  reason: string;
  decidedBy: string;
}

export interface IngestCommit {
  id: string;
  indexOrder: number;
  materialVersion: string;
  parentCommitId: string | null;
  rationale: string;
  importedAt: string;
  entityIds: string[];
}

export interface RuleVersion {
  id: string;
  version: string;
  parameters: RegistrationParameters;
  note: string;
  createdAt: string;
}

/** 倾转轴：anchor 必须显式给。规则禁止把轴默认钉在图像中心。 */
export interface TiltAxisSpec {
  /** 轴线上一点（像素，未对齐基准）。null 表示本规则版本拒绝提供中心假设。 */
  anchorX: number | null;
  anchorY: number | null;
  /** 轴线方向角（度，图像坐标，y 向下为正）。 */
  directionDeg: number;
  assumedImageCenter: boolean;
  estimationMethod: string;
}

export interface RegistrationParameters {
  model: "rigid" | "local-deform" | "rigid-drop-frames";
  tiltAxis: TiltAxisSpec;
  /** 允许的每帧平移上限（像素）；超过则标记异常而非硬裁剪。 */
  maxShiftPx: number;
  /** local-deform 模型的网格间距（像素）。 */
  warpGridSpacingPx: number;
  /** local-deform 每帧自由参数数量，用于复杂度惩罚。 */
  warpDegreesOfFreedom: number;
  /** 被剔除帧 id；只有该规则明确排除才进入有效点集。 */
  droppedFrameIds: string[];
}

export interface InterpretationBranch {
  id: string;
  name: string;
  commitId: string;
  ruleVersionId: string;
  headEventId: string | null;
  supersededBy: string | null;
  createdAt: string;
}

export interface IdentitySwap {
  trackLabelA: string;
  trackLabelB: string;
  frameIds: string[];
  confidence: number;
}

export interface TrackIdentityMap {
  /** 观测标签 -> 跨帧稳定轨迹 id（"trk_..."）。未列出的标签映射到自身。 */
  assignments: Record<string, string>;
  swaps: IdentitySwap[];
  ambiguity: boolean;
  ambiguousAlternatives?: Record<string, string>[];
}

export interface FrameResidual {
  frameId: string;
  used: boolean;
  excludedReason: string | null;
  shiftX: number;
  shiftY: number;
  rotationRad: number;
  residualPx: number;
  nPoints: number;
  localWarpNorm: number | null;
  crossValidationPx: number | null;
}

export interface RegistrationCandidate {
  id: string;
  branchId: string;
  ruleVersionId: string;
  label: string;
  model: RegistrationParameters["model"];
  validFrameIds: string[];
  pointSetDigest: string;
  identityMap: TrackIdentityMap;
  perFrame: FrameResidual[];
  rmsPx: number;
  maxPx: number;
  cvRmsPx: number | null;
  complexityPenalty: number;
  score: number;
  diagnostics: string[];
  /** 比较组：同一比较组内承诺使用相同有效点集。 */
  comparisonGroup: string;
}

export type DecisionKind =
  | "candidate-accepted"
  | "candidate-rejected"
  | "parameter-revised"
  | "source-revised-local"
  | "conflicting-decision"
  | "registration-locked"
  | "lock-revoked"
  | "bad-frames-excluded"
  | "bad-frames-restored"
  | "ambiguity-resolved"
  | "ambiguity-reopened"
  | "conflict-frozen";

export interface DecisionEvent {
  id: string;
  branchId: string;
  seq: number;
  kind: DecisionKind;
  prevEventId: string | null;
  at: string;
  actor: string;
  summary: string;
  /** 事实引用：事件引用的版本号（规则版本、候选 id、commit id 等）。 */
  refs: Record<string, string | string[]>;
  payload: Record<string, unknown>;
  /** 该事件依赖的实体 id -> 版本摘要；重放到此事件时按此还原视图。 */
  dependencySnapshot: Record<string, string>;
}

export interface DependencyEdge {
  branchId: string;
  eventId: string;
  dependsOn: string;
  dependsOnDigest: string;
  scope: "global" | "local";
  localityKey: string | null;
}

export interface LockedRegistration {
  id: string;
  branchId: string;
  candidateId: string;
  eventId: string;
  forReconstructionRef: string;
  revoked: boolean;
  lockedAt: string;
}

export interface ConflictRecord {
  id: string;
  branchId: string;
  at: string;
  expectedHeadEventId: string | null;
  submittedSummary: string;
  actualHeadEventId: string;
  incomingDigest: string;
  baseDigest: string;
  headDigest: string;
  actors: [string, string];
  resolved: boolean;
  resolutionEventId: string | null;
}

/** 反例档案条目：一个情形同时保留最小输入与组合输入。 */
export interface DossierEntry {
  id: string;
  caseCode: string;
  title: string;
  ruleStatement: string;
  minimalInput: DossierInputRef;
  combinedInput: DossierInputRef;
  adopted: { eventId: string; summary: string }[];
  rejected: { eventId: string; summary: string }[];
  affectedEntityIds: string[];
  invalidationScope: { scope: "global" | "local"; localityKey: string | null; frameIds: string[] };
}

export interface DossierInputRef {
  commitId: string;
  sharedObjectIds: string[];
  interpretationVersionId: string;
  eventIds: string[];
  diagnostics: string[];
  humanDecision: string | null;
}

export interface EntityEnvelope<T = unknown> {
  id: string;
  kind: string;
  versionDigest: string;
  content: T;
  summary: Record<string, string | number | null>;
  refs: Record<string, string | string[]>;
}

export interface ProvenanceResult {
  entityId: string;
  referencedVersions: { ref: string; versionDigest: string }[];
  chain: { eventId: string; kind: DecisionKind; at: string; summary: string }[];
  corruption: { code: string; message: string; missingRef: string } | null;
}
