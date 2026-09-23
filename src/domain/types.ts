import type { DomainQuantity } from './units';

/**
 * 倾转帧拼合室数据契约（v1）。
 *
 * 直接采用电子断层领域词汇：raw_frame / tilt_angle / pixel_scale / dose /
 * fiducial_marker / track / track_gap / identity_swap_question /
 * manual_exclusion / tilt_axis / registration_candidate / comparison /
 * decision。禁止把一切压成 name/value。
 *
 * 每个实体都带稳定身份。来源（raw_*）与解释（*_interpretation / 候选 /
 * 裁定）拆开保存，全部版本化。
 */

export const ENTITY_KINDS = [
  'raw_frame',
  'tilt_angle',
  'pixel_scale',
  'dose',
  'fiducial_marker',
  'track',
  'track_gap',
  'identity_swap_question',
  'manual_exclusion',
  'tilt_axis',
  'registration_candidate',
  'comparison',
  'decision'
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[
  keyof typeof ENTITY_KINDS
];

export type InterpretationLayer = 'source' | 'derived' | 'review';

export type ScenarioKey =
  | 'baseline'
  | 'axis_offset'
  | 'identity_swap'
  | 'missing_high_tilt'
  | 'bad_frames'
  | 'warp_overfit'
  | 'ambiguity'
  | 'concurrent_freeze'
  | 'combined';

export type Point2D = { x: number; y: number };

export interface VersionRef {
  entityId: string;
  kind: EntityKind;
  version: number;
  contentId: string;
}

export interface FrameObservation {
  /** 该轨迹在这一帧中观测到的 marker 坐标，坐标基准固定为 image-pixel。 */
  at: Point2D;
  /** 该观测被本解释视为无效的原因（例如身份交换疑点）；未设置=有效。 */
  invalidReason?: string;
}

/** ---- 来源实体（raw，不可变；原始表示必须保留） ---- */

export interface RawFrame {
  kind: 'raw_frame';
  layer: 'source';
  frameId: string;
  sequenceIndex: number;
  width: number;
  height: number;
  blobContentId: string;
  blobByteLength: number;
  pixelFormat: string;
  acquisitionNote: string;
  /** 来源记录，例如案例包中的原始文件名/行号。 */
  provenance: string;
}

export interface TiltAngle {
  kind: 'tilt_angle';
  layer: 'source';
  frameId: string;
  angle: DomainQuantity;
  sequenceIndex: number;
  provenance: string;
}

export interface PixelScale {
  kind: 'pixel_scale';
  layer: 'source';
  scope: 'series' | { frameId: string };
  scale: DomainQuantity;
  sequenceIndex: number;
  provenance: string;
}

export interface Dose {
  kind: 'dose';
  layer: 'source';
  frameId: string;
  exposure: DomainQuantity;
  sequenceIndex: number;
  provenance: string;
}

/** 单帧中单个 fiducial 标记点的坐标（来源层）。 */
export interface FiducialMarker {
  kind: 'fiducial_marker';
  layer: 'source';
  frameId: string;
  sequenceIndex: number;
  /** 跟踪者给出的“原始标签”，身份交换时会与轨迹身份不一致。 */
  rawLabel: string;
  coordinate: DomainQuantity<Point2D>;
  provenance: string;
}

/** 手工跟踪缺口：某轨迹在连续帧区间内无法被跟踪。 */
export interface TrackGap {
  kind: 'track_gap';
  layer: 'source';
  trackId: string;
  fromSequenceIndex: number;
  toSequenceIndex: number;
  reason: string;
  provenance: string;
}

/** 手工排除原因（来源层的事实陈述，是否用于配准由复核决定）。 */
export interface ManualExclusion {
  kind: 'manual_exclusion';
  layer: 'source';
  frameId: string;
  reason: string;
  sequenceIndex: number;
  provenance: string;
}

/** ---- 解释实体（derived / review，可分支、可版本化） ---- */

/**
 * fiducial 轨迹：可断裂（track_gap），且可能发生身份交换。
 * observations 按帧 sequenceIndex 稀疏排列；缺口=没有观测，不等于坐标为 0。
 */
export interface Track {
  kind: 'track';
  layer: 'derived';
  trackId: string;
  /** sequenceIndex -> 观测。 */
  observations: Record<number, FrameObservation>;
  /** 引用 track_gap 实体，表达断裂区间。 */
  gapRefs: VersionRef[];
  /**
   * 身份映射：原始标签 -> 本解释认定的轨迹身份。
   * 当 identity_swap 被接受时，一个标签区间会改投另一条轨迹。
   */
  identityAssignments: Array<{
    fromSequenceIndex: number;
    toSequenceIndex: number;
    rawLabel: string;
  }>;
  basedOnRefs: VersionRef[];
  note: string;
}

export interface IdentitySwapQuestion {
  kind: 'identity_swap_question';
  layer: 'review';
  swapId: string;
  trackIdA: string;
  trackIdB: string;
  fromSequenceIndex: number;
  toSequenceIndex: number;
  evidence: string;
  /** 未决/成立/驳回。无法唯一决定时保持 open 并保留多候选。 */
  status: 'open' | 'accepted' | 'rejected';
  basedOnRefs: VersionRef[];
}

/**
 * 倾转轴。禁止默认固定在图像中心：必须显式估计并给出偏心量。
 * 角度约定为图像像素坐标系下轴线方向角；位置为轴上一点。
 */
export interface TiltAxis {
  kind: 'tilt_axis';
  layer: 'derived';
  axisId: string;
  angleDeg: number;
  position: Point2D;
  assumedCenter: Point2D;
  /** 轴相对图像中心的偏心像素距离；> 阈值即“轴线偏心”。 */
  offsetFromCenterPx: number;
  centered: boolean;
  basedOnRefs: VersionRef[];
  note: string;
}

export type RegistrationStrategy = 'rigid' | 'local_warp' | 'exclude_bad_frames';

export type CandidateStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'invalidated';

export interface PerFrameResidual {
  sequenceIndex: number;
  frameId: string;
  /** 该帧纳入有效点集。 */
  included: boolean;
  excludedReason?: string;
  rmsResidualPx: number;
  maxResidualPx: number;
  pointCount: number;
}

export interface RegistrationCandidate {
  kind: 'registration_candidate';
  layer: 'derived';
  candidateId: string;
  strategy: RegistrationStrategy;
  label: string;
  axisRef: VersionRef;
  /** 每帧刚体/形变参数（dx,dy 像素，旋转角度）。 */
  frameTransforms: Record<
    number,
    { dx: number; dy: number; rotationDeg: number; warped?: boolean }
  >;
  perFrameResiduals: PerFrameResidual[];
  /** 参与比较的有效点指纹；不同候选必须相同才允许直接比残差。 */
  effectivePointSetFingerprint: string;
  effectiveFrameSequence: number[];
  excludedFrames: Array<{ frameId: string; reason: string }>;
  aggregateRmsPx: number;
  degreesOfFreedom: number;
  pointCount: number;
  status: CandidateStatus;
  diagnostics: string[];
  basedOnRefs: VersionRef[];
  /** 无法唯一决定时的等价族标签；同一 ambiguityGroup 内残差等价。 */
  ambiguityGroup?: string;
}

export interface ComparisonMember {
  candidateRef: VersionRef;
  aggregateRmsPx: number;
  effectivePointSetFingerprint: string;
  effectiveFrameCount: number;
  comparable: boolean;
  comparabilityNote: string;
}

/** 不同候选用相同有效点集比较；不能用少帧换低残差。 */
export interface Comparison {
  kind: 'comparison';
  layer: 'review';
  comparisonId: string;
  members: ComparisonMember[];
  sameEffectivePointSet: boolean;
  winnerCandidateId?: string;
  rule: string;
  note: string;
}

export type DecisionKind =
  | 'accept_candidate'
  | 'reject_candidate'
  | 'parameter_revision'
  | 'source_amendment'
  | 'identity_swap_resolution'
  | 'lock_for_reconstruction';

export interface Decision {
  kind: 'decision';
  layer: 'review';
  decisionId: string;
  decisionKind: DecisionKind;
  targetRef: VersionRef;
  accepted: boolean;
  reason: string;
  /** 撤销时指向被恢复的上一个 decision。 */
  undoesRef?: VersionRef;
  /** 锁定后重建引用句柄：读回必须解析到这一版，不得回退最新。 */
  reconstructionHandle?: string;
  /** 乐观并发：基于的分支头事件号，保存时校验。 */
  basedOnHeadSeq: number;
  parameterPatch?: Record<string, unknown>;
}

export type EntityBody =
  | RawFrame
  | TiltAngle
  | PixelScale
  | Dose
  | FiducialMarker
  | TrackGap
  | ManualExclusion
  | Track
  | IdentitySwapQuestion
  | TiltAxis
  | RegistrationCandidate
  | Comparison
  | Decision;

export interface MaterialSetRevision {
  materialSetId: string;
  version: number;
  /** 本次修订包含的全部来源实体 contentId（全量快照集合）。 */
  sourceContentIds: string[];
  note: string;
}

export interface EntityRecord {
  entityId: string;
  kind: EntityKind;
  version: number;
  contentId: string;
  body: EntityBody;
  branchId: string;
  eventId: string;
  eventSeq: number;
  /** 直接引用（缺失即损坏，不允许退回最新版）。 */
  refs: VersionRef[];
}

export interface ContentSummary {
  contentId: string;
  kind: EntityKind;
  byteLength: number;
  sha256: string;
  createdAt: string;
}
