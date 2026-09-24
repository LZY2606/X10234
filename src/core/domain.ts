/**
 * 数据契约（领域自有词汇，禁止压成 name/value）。
 *
 * 输入实体（全部版本化，来源与解释分离）：
 *   RawFrame / TiltAngle / PixelScale / Dose / MarkerObservation / TrackingGap / ManualExclusion
 * 决定实体：
 *   TiltAxisDecision（轴线可偏心，不默认图像中心）
 *   TrackLinkDecision（fiducial 轨迹可断裂、可身份交换）
 *   RegistrationCandidate / RegistrationLock
 * 复核实体：
 *   ReviewEvent（接受/否定/参数调整/冲突），支撑审阅页叠影、轴线、断点、逐帧残差与候选差分
 */
import type {
  DoseId,
  ExclusionId,
  FrameId,
  GapId,
  ObservationId,
  PixelCoord,
  PixelScaleId,
  Quantity,
  TiltId,
  TrackId,
} from './quantities';

export type EntityKind =
  | 'raw_frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'dose'
  | 'marker_observation'
  | 'tracking_gap'
  | 'manual_exclusion'
  | 'tilt_axis'
  | 'track_link'
  | 'registration_candidate'
  | 'registration_lock';

export interface VersionedEntity {
  id: string;
  kind: EntityKind;
  version: number; // 同一 id 的解释版本，从 1 开始；来源内容用 contentId 锁定
  branchId: string;
  parentVersionId: string | null;
  contentId: string; // 原始字节/载荷摘要
  summary: string; // 内容摘要：查询实体时返回
  createdAt: string;
  createdBy: string;
  payload: EntityPayload;
  references: string[]; // 显式引用的 (entity@version)；缺失即损坏
}

export type EntityPayload =
  | RawFrame
  | TiltAngle
  | PixelScale
  | Dose
  | MarkerObservation
  | TrackingGap
  | ManualExclusion
  | TiltAxisDecision
  | TrackLinkDecision
  | RegistrationCandidate
  | RegistrationLock;

export interface RawFrame {
  frameId: FrameId;
  order: number; // 倾转序列采集顺序（稳定，不靠数组位置）
  widthPx: number;
  heightPx: number;
  encoding: 'pgm-p5';
  contentId: string; // 引用 blob 内容
  byteLength: number;
}

export interface TiltAngle {
  frameId: FrameId;
  angle: Quantity; // degree | radian，规范层 -> degree
  acquisitionOrder: number;
}

export interface PixelScale {
  scope: 'series' | { frameId: FrameId };
  scale: Quantity; // nm/px | angstrom/px -> nm/px
}

export interface Dose {
  frameId: FrameId;
  dose: Quantity; // e-/A^2 | e-/nm^2 -> e-/A^2
  cumulative: Quantity; // 累计剂量
}

export interface MarkerObservation {
  observationId: ObservationId;
  trackId: TrackId | null; // null = 尚未链接（轨迹可断裂）
  frameId: FrameId;
  coord: PixelCoord;
  intensityHint: number;
  observed: boolean; // false = 该帧缺口（缺测点）
}

export interface TrackingGap {
  gapId: GapId;
  trackId: TrackId;
  fromFrameId: FrameId;
  toFrameId: FrameId;
  reason: 'occluded' | 'out-of-field' | 'low-dose-undetectable' | 'unknown';
  note: string;
}

export interface ManualExclusion {
  exclusionId: ExclusionId;
  frameId: FrameId;
  reasonCode:
    | 'motion-blur'
    | 'beam-blocked'
    | 'too-few-fiducials'
    | 'high-tilt-missing'
    | 'other';
  reasonText: string;
  author: string;
}

export interface TiltAxisDecision {
  axisId: string;
  /** 轴线在参考帧像素坐标中的通过点；显式偏心，不允许默认 (W/2,H/2)。 */
  anchorPx: { x: number; y: number };
  angleInPlaneDeg: number; // 轴线方向（面内角）
  assumedCenterByDefault: false;
  estimatedFromVersion: string; // 依据的观测版本 entity@ver
  uncertaintyPx: number;
}

export interface TrackLinkDecision {
  linkId: string;
  /** 相邻两段轨迹身份关系：same / swapped / broken。 */
  edges: Array<{ fromTrackId: TrackId; toTrackId: TrackId; relation: 'same' | 'swapped' | 'broken' }>;
  note: string;
}

export type RegistrationMethod = 'rigid' | 'local-warp' | 'bad-frame-excluded';

export interface PerFrameResidual {
  frameId: FrameId;
  residualPx: number; // 归一化像素
  used: boolean; // 是否进入有效点集
  excludedReason: string | null;
  observations: number;
}

export interface RegistrationCandidate {
  candidateId: string;
  method: RegistrationMethod;
  ruleVersion: string;
  axisVersionRef: string; // tilt_axis@v
  trackVersionRef: string; // track_link@v
  effectiveFrameIds: FrameId[]; // 有效点集（公平比较必须相同）
  perFrame: PerFrameResidual[];
  rmsPx: number;
  maxPx: number;
  warpEnergy: number; // 局部形变动能，过拟合检测
  degeneracy: 'unique' | 'multi-solution';
  equivalentCandidateIds: string[]; // 多解时保留全部合法候选
  diagnostics: string[];
}

export interface RegistrationLock {
  lockId: string;
  candidateVersionRef: string; // registration_candidate@v
  branchId: string;
  lockedBy: string;
  note: string;
}

/** 机器可读取的判断依据事件。 */
export type ReviewEventType =
  | 'import-batch'
  | 'parameter-revision'
  | 'source-patch-local'
  | 'candidate-computed'
  | 'candidate-accepted'
  | 'candidate-rejected'
  | 'parameter-adjusted'
  | 'branch-created'
  | 'conflict-detected'
  | 'lock-set'
  | 'lock-revoked'
  | 'diagnostic-flagged';

export interface ReviewEvent {
  eventId: string;
  seq: number;
  branchId: string;
  parentEventId: string | null;
  type: ReviewEventType;
  at: string;
  actor: string;
  basis: string[]; // 依据的 entity@version / 规则版本 / 原始 contentId
  invalidates: string[]; // 失效范围（显式依赖，不允许全局替换）
  payload: Record<string, unknown>;
}

export interface ScenarioFinding {
  scenario: string;
  contained: boolean; // 影响是否被限制在正确范围
  detail: string;
  affected: string[];
}
