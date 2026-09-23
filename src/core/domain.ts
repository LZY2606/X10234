/**
 * 数据契约：电子断层倾转序列配准审阅
 * 直接采用领域词汇，禁止压成 name/value。
 * 所有领域量携带单位或坐标基准；raw 字段保留导入时的原始表示。
 */

// ---------- 量纲 / 坐标基准 ----------
export type AngleUnit = 'degree' | 'radian';
export type LengthUnit = 'nm' | 'um' | 'pixel' | 'A';
export type DoseUnit = 'e-/A^2' | 'e-/nm^2';

/** 带单位/坐标基准的领域量。raw 保存导入原文，无法转换时 value=null 并带诊断。 */
export interface Quantity<V = number> {
  value: V | null;
  unit: string;
  raw: string;
  /** 坐标基准，例如 image-px(原点左上,y 向下)、specimen-nm(原点轴点)。 */
  frame?: string;
  diagnostics?: Diagnostic[];
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

// ---------- 原始来源实体（不可变，全部版本化） ----------

/** 原始帧：原始字节按内容寻址只存一份。 */
export interface RawFrame {
  kind: 'rawFrame';
  frameId: string; // 帧序号身份，如 frame-007（稳定，不随重解释变）
  index: number;
  width: number;
  height: number;
  encoding: 'raw-uint8';
  bytesContentHash: string; // 指向 bytes 表的内容哈希
  nominalLabel?: string;
}

/** 倾角（每帧），保留原始表示，允许不可转换。 */
export interface TiltAngle {
  kind: 'tiltAngle';
  frameId: string;
  angle: Quantity<number>; // 单位 degree/radian + frame 约定 signed
  sourceOrder: number;
}

/** 像素尺度：图像像素到物理长度。 */
export interface PixelScale {
  kind: 'pixelScale';
  pixelSize: Quantity<number>; // 单位 nm/um/A
  calibratedFrom?: string;
}

/** 曝光剂量（每帧或累计），保留原始表示。 */
export interface ExposureDose {
  kind: 'exposureDose';
  frameId: string;
  dose: Quantity<number>;
  cumulative: boolean;
}

/** fiducial 标记点观测：某轨迹在某帧上的坐标；可缺失（跟踪缺口）。 */
export interface FiducialObservation {
  kind: 'fiducialObservation';
  frameId: string;
  trackId: string; // 导入方给定的轨迹身份（后续可被解释层改判）
  x: Quantity<number>; // 坐标基准 image-px
  y: Quantity<number>;
  confidence: number | null;
}

/** 跟踪缺口：轨迹在某帧断裂/缺失的记录。 */
export interface TrackingGap {
  kind: 'trackingGap';
  trackId: string;
  frameId: string;
  reason: Quantity<string>;
}

/** 手工排除原因：审阅者对帧/点的人工排除（来源层原始记录）。 */
export interface ManualExclusion {
  kind: 'manualExclusion';
  target: { type: 'frame' | 'track' | 'observation'; frameId?: string; trackId?: string };
  reason: Quantity<string>;
  author: string;
}

export type SourceEntity =
  | RawFrame
  | TiltAngle
  | PixelScale
  | ExposureDose
  | FiducialObservation
  | TrackingGap
  | ManualExclusion;

export const SOURCE_KINDS = [
  'rawFrame',
  'tiltAngle',
  'pixelScale',
  'exposureDose',
  'fiducialObservation',
  'trackingGap',
  'manualExclusion'
] as const;

// ---------- 解释层参数（修订产生新版本，失效范围显式传播） ----------

/** 配准参数：倾转轴中心模式不得隐式固定；修订即新版本。 */
export interface AlignmentParams {
  kind: 'alignmentParams';
  revision: number;
  /** explicit-estimate: 由 fiducial 估计轴线位置（规则 R1）；forced-center 仅用于反例对比。 */
  tiltCenterMode: 'explicit-estimate' | 'forced-center';
  minTiltPoints: number;
  warpDegreesOfFreedom: number;
  overfitCvRatioThreshold: number;
  rmsTolerancePx: number;
  note: string;
}

// ---------- 解释层实体（可分支、可多候选） ----------

/** 倾转轴假设：明确不允许默认固定在图像中心；偏心量是待估量。 */
export interface TiltAxisHypothesis {
  kind: 'tiltAxis';
  /** 轴线方向（度，图像坐标，0=沿 x）。null 表示当前材料不足以唯一决定。 */
  directionDeg: number | null;
  /** 轴线上一点（image-px）。null 表示不可定位。 */
  anchorX: number | null;
  anchorY: number | null;
  /** 相对图像中心的偏心（image-px），显式展示而非假设为 0。 */
  eccentricityX: number | null;
  eccentricityY: number | null;
  determined: boolean;
  alternatives: { directionDeg: number; anchorX: number; anchorY: number; residual: number }[];
  note: string;
}

/** 轨迹身份裁定：fiducial 轨迹可断裂且可能身份交换。 */
export interface TrackIdentityDecision {
  kind: 'trackIdentity';
  /** 导入轨迹 -> 规范轨迹的映射；未出现的 track 表示无重判。 */
  mapping: { importedTrackId: string; canonicalTrackId: string; swapWith?: string; joinedAcrossGap?: boolean }[];
  brokenTracks: { trackId: string; gapFrameIds: string[] }[];
}

/** 每帧刚体配准：旋转 + 平移（图像坐标基准）。 */
export interface RigidTransform {
  kind: 'rigidTransform';
  frameId: string;
  rotationDeg: number;
  shiftX: number; // image-px
  shiftY: number;
}

/** 局部形变（薄板样条网格），并带过拟合诊断。 */
export interface LocalWarp {
  kind: 'localWarp';
  frameId: string;
  /** 控制点位移（image-px）。 */
  controlPoints: { x: number; y: number; dx: number; dy: number }[];
  bendingEnergy: number;
  overfit: boolean;
  overfitDiagnostic?: string;
}

/** 配准候选：不同候选必须用相同有效点集比较。 */
export interface AlignmentCandidate {
  kind: 'alignmentCandidate';
  candidateId: string;
  scheme: 'rigid' | 'local-warp' | 'rigid-with-exclusions';
  frameTransforms: (RigidTransform | LocalWarp)[];
  /** 有效点集（frameId|trackId），候选间比较的公平性基准。 */
  effectivePointSet: string[];
  /** 被排除的帧及原因来源。 */
  excludedFrameIds: { frameId: string; reasonEventId?: string }[];
  perFrameResidual: { frameId: string; residualPx: number; nPoints: number; included: boolean }[];
  totalResidualPx: number;
  comparableWith: string[]; // 有效点集相同的其他候选
  warnings: string[];
}

/** 裁定分支：接受 / 否定，可撤销并恢复前一分支。 */
export interface Adjudication {
  kind: 'adjudication';
  decision: 'accept' | 'reject';
  candidateId: string;
  reason: string;
  supersedesAdjudicationId: string | null;
}

/** 锁定：供重建管线引用的一版配准。 */
export interface RegistrationLock {
  kind: 'registrationLock';
  candidateId: string;
  reference: string; // 供重建读回的稳定引用 LCK-...
  released: boolean;
}

export type InterpretationEntity =
  | AlignmentParams
  | TiltAxisHypothesis
  | TrackIdentityDecision
  | AlignmentCandidate
  | Adjudication
  | RegistrationLock;

// ---------- 事件（机器可读取的判断依据） ----------

export type EventType =
  | 'ingest.commit'
  | 'ingest.rollback'
  | 'parameter.revision'
  | 'source.patch-local'
  | 'decision.axis-assumptions'
  | 'decision.track-identity'
  | 'decision.frame-exclusion'
  | 'candidate.generated'
  | 'candidate.multiplicity'
  | 'candidate.overfit'
  | 'decision.adjudicate'
  | 'decision.revert'
  | 'decision.lock'
  | 'decision.unlock'
  | 'conflict.detected'
  | 'conflict.resolved'
  | 'diagnostic.point-set-mismatch'
  | 'diagnostic.missing-high-tilt'
  | 'diagnostic.unconvertible'
  | 'branch.forked';

/** 判断依据代码（对应需求里三条硬性规则）。 */
export const RATIONALE = {
  AXIS_NOT_CENTER: 'R1: tilt-axis 不得默认固定图像中心，偏心必须由 fiducial 估计',
  TRACKS_BREAK_AND_SWAP: 'R2: fiducial 轨迹可断裂且可能身份交换，缺口与换标必须显式建模',
  SAME_POINT_SET_FAIR_COMPARE: 'R3: 候选必须用相同有效点集比较，禁止用少帧换低残差'
} as const;

export type ScenarioCode =
  | 'axis-eccentric'
  | 'track-identity-swap'
  | 'missing-high-tilt'
  | 'bad-frame-exclusion'
  | 'local-warp-overfit'
  | 'multiplicity'
  | 'concurrent-freeze';

export interface DomainEvent {
  eventId: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  type: EventType;
  scenario?: ScenarioCode;
  rationaleCode?: keyof typeof RATIONALE;
  timestamp: string;
  author: string;
  /** 该事件写入或依赖的内容版本（contentId -> role）。 */
  refs: { contentId: string; role: string }[];
  payload: unknown;
  /** 依赖失效范围参数修订时显式计算。 */
  invalidatesScope?: { kinds: string[]; branches: string[]; reason: string };
}

// ---------- 实体信封：查询返回稳定身份 + 版本号 + 摘要 ----------

export interface EntityEnvelope<T = unknown> {
  stableId: string;
  kind: string;
  branch: string;
  version: number;
  contentId: string; // 内容哈希
  contentSummary: string;
  body: T;
  refs: { contentId: string; role: string; version: number; summary: string }[];
  createdByEvent: string;
}

export class CorruptArchiveError extends Error {
  constructor(message: string, public readonly missingRefs: string[]) {
    super(message);
    this.name = 'CorruptArchiveError';
  }
}

export function stableId(prefix: string, key: string): string {
  return `${prefix}:${key}`;
}
