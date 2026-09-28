/**
 * 倾转帧拼合室 —— 领域数据契约
 *
 * 输入实体（全部版本化，原始表示与解释分离）：
 *   RawFrame        原始帧（内容寻址、不可变字节）
 *   TiltAngle       倾角（保留原始表示：数值 + 单位 + 来源步骤约定）
 *   PixelScale      像素尺度（值 + 单位基准）
 *   ExposureDose    曝光剂量（值 + 单位）
 *   MarkerObservation  某帧上某 fiducial 标记点坐标（坐标系基准随原始帧）
 *   TrackingGap        跟踪缺口（轨迹在某帧区间断裂）
 *   ManualExclusion    手工排除原因（针对帧）
 *
 * 决定/解释实体：
 *   TiltAxisGeometry  倾转轴几何（显式轴线，禁止默认固定在图像中心）
 *   TrackIdentity     fiducial 轨迹（可断裂、可身份交换）
 *   RegistrationCandidate 配准候选（rigid | localWarp | badFrameExclusion）
 *   RegistrationDecision   裁定（accept / reject / revoke）
 *   LockedRegistration     锁定版本（供重建引用）
 *
 * 规则常量集中在 rules.ts；每条派生记录保存 derivation（规则版本+依赖版本+输入摘要）。
 */

export type ID = string;

export type Unit =
  | 'degree'
  | 'radian'
  | 'nm_per_pixel'
  | 'angstrom_per_pixel'
  | 'e_per_angstrom_sq'
  | 'e_per_nm_sq'
  | 'pixel';

/** 带单位/坐标基准的领域量；导入时保留原始表示，规范化只发生在派生层 */
export interface DimensionedQuantity {
  /** 原始文本表示，例如 "1.24"、"2.1°"、"N/A" */
  raw: string;
  /** 仅当 raw 可解析时存在 */
  value?: number;
  unit: Unit;
  /** 规范化失败时保留原值并附诊断，绝不丢值 */
  diagnostic?: string;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface ImageSize {
  widthPx: number;
  heightPx: number;
}

// ---------- 输入实体（原始层，版本化） ----------

export type FrameKind = 'projection' | 'dark_ref' | 'gain_ref';

export interface RawFrame {
  kind: 'RawFrame';
  frameId: ID;
  /** 采集顺序索引，0 起；顺序是一等事实，不依赖文件名字典序 */
  acquisitionIndex: number;
  kind_: FrameKind;
  size: ImageSize;
  /** 不可变内容摘要（sha256 of 帧载荷字节） */
  blobSha256: string;
  /** 原始文件名/通道名（原始表示） */
  sourceLabel: string;
  /** 原始记录里携带但未在结构化字段内解释的键值，原样保留 */
  rawAttributes: Record<string, string>;
}

export interface TiltAngle {
  kind: 'TiltAngle';
  tiltId: ID;
  frameId: ID;
  angle: DimensionedQuantity;
  /** 倾角步骤约定，例如 Saxton / linear / bidirectional，原样记录 */
  schemeNote: string;
}

export interface PixelScale {
  kind: 'PixelScale';
  scaleId: ID;
  scope: { frameId?: ID };
  scale: DimensionedQuantity;
}

export interface ExposureDose {
  kind: 'ExposureDose';
  doseId: ID;
  frameId: ID;
  dose: DimensionedQuantity;
}

/** fiducial 标记点在某帧上的观测坐标；身份归属属于解释层 */
export interface MarkerObservation {
  kind: 'MarkerObservation';
  observationId: ID;
  frameId: ID;
  /** 原始检测点序号（导入文件中的编号），与解释层轨迹身份解耦 */
  detectorPointRef: string;
  position: { raw: string; frame: Vec2; diagnostic?: string };
  /** 点位质量（原始） */
  confidenceRaw?: string;
}

/** 跟踪缺口：某检测点在 [fromFrame, toFrame] 区间未被观测到 */
export interface TrackingGap {
  kind: 'TrackingGap';
  gapId: ID;
  detectorPointRef: string;
  fromAcquisitionIndex: number;
  toAcquisitionIndex: number;
  note: string;
}

/** 手工排除某帧的原因（可有多条、可撤销，均版本化） */
export interface ManualExclusion {
  kind: 'ManualExclusion';
  exclusionId: ID;
  frameId: ID;
  reason: string;
  author: string;
}

export type InputEntity =
  | RawFrame
  | TiltAngle
  | PixelScale
  | ExposureDose
  | MarkerObservation
  | TrackingGap
  | ManualExclusion;

// ---------- 解释/决定实体 ----------

/**
 * 倾转轴几何：x0 + t*(cos alpha, sin alpha)，显式穿过点 axisPoint。
 * 禁止默认固定在图像中心：axisPoint 必须由几何给出并附来源。
 */
export interface TiltAxisGeometry {
  kind: 'TiltAxisGeometry';
  axisId: ID;
  /** 轴线角（相对图像 x 轴），单位 degree */
  angleDeg: number;
  /** 轴线穿过点（像素，图像坐标系），显式偏心 */
  axisPoint: Vec2;
  imageSize: ImageSize;
  /** 偏心量（轴点到图像中心），像素 */
  eccentricityPx: number;
  source: 'fitted' | 'manual' | 'assumed';
  note: string;
}

/** 轨迹段：一条 fiducial 轨迹可由多段组成（断裂），每段独立观测序列 */
export interface TrackSegment {
  segmentId: ID;
  observationIds: ID[];
  frameIds: ID[];
}

export interface TrackIdentity {
  kind: 'TrackIdentity';
  trackId: ID;
  /** 稳定物理标记身份（解释层赋予，可与检测器编号交换） */
  physicalMarkerRef: string;
  color: string;
  segments: TrackSegment[];
  /** 与另一轨迹发生过身份交换的记录 */
  swapWithTrackId?: ID;
  note: string;
}

export type RegistrationModel = 'rigid' | 'localWarp' | 'badFrameExclusion';

export interface PerFrameResidual {
  frameId: ID;
  /** 该候选实际使用的帧数（局部形变可能在缺帧处无值） */
  used: boolean;
  rmsPx: number | null;
  nPoints: number;
}

export interface RegistrationCandidate {
  kind: 'RegistrationCandidate';
  candidateId: ID;
  model: RegistrationModel;
  label: string;
  /** 该候选使用的有效帧集合（帧 ID，排序） */
  effectiveFrameIds: ID[];
  /** 该候选使用的观测点 ID 集合 */
  effectiveObservationIds: ID[];
  /** 拟合参数（每帧平移、可选局部形变系数），仅用于渲染 */
  perFrameShift: Record<ID, Vec2>;
  localWarpGrid?: number;
  /** 在“该候选自己的有效点集”上的残差 */
  ownRmsPx: number;
  /** 在“全部候选共同有效点集”上的残差 —— 公平比较口径 */
  commonSetRmsPx: number;
  perFrame: PerFrameResidual[];
  /** 诊断：用更少帧换低残差 / 过拟合 / 多解 等 */
  diagnostics: CandidateDiagnostic[];
  /** 是否为某多解歧义下的并列合法解 */
  ambiguityGroupId?: ID;
}

export type DiagnosticCode =
  | 'FAIR_SET_OK'
  | 'FEWER_FRAMES_LOWER_RESIDUAL'
  | 'LOCAL_WARP_OVERFIT'
  | 'MULTIPLE_SOLUTIONS'
  | 'MISSING_HIGH_TILT_FRAME'
  | 'BAD_FRAME_EXCLUDED'
  | 'AXIS_OFF_CENTER'
  | 'TRACK_IDENTITY_SWAP'
  | 'TRACK_BROKEN';

export interface CandidateDiagnostic {
  code: DiagnosticCode;
  severity: 'info' | 'warn' | 'fail';
  message: string;
  evidence: Record<string, unknown>;
}

export type DecisionVerdict = 'accept' | 'reject' | 'revoke';

export interface RegistrationDecision {
  kind: 'RegistrationDecision';
  decisionId: ID;
  candidateId: ID;
  verdict: DecisionVerdict;
  author: string;
  note: string;
  /** revoke 指向被撤销的决定事件 */
  revokesDecisionId?: ID;
}

export interface LockedRegistration {
  kind: 'LockedRegistration';
  lockId: ID;
  candidateId: ID;
  decisionId: ID;
  /** 供重建引用的稳定句柄 */
  reference: string;
}

export type InterpretedEntity =
  | TiltAxisGeometry
  | TrackIdentity
  | RegistrationCandidate
  | RegistrationDecision
  | LockedRegistration;

// ---------- 事件溯源 ----------

export type EventType =
  | 'series.created'
  | 'frames.imported'
  | 'tilts.imported'
  | 'pixelScale.imported'
  | 'dose.imported'
  | 'markers.imported'
  | 'gaps.imported'
  | 'exclusions.recorded'
  | 'axis.proposed'
  | 'tracks.proposed'
  | 'candidates.proposed'
  | 'decision.recorded'
  | 'registration.locked'
  | 'parameter.revised'
  | 'source.localRevised'
  | 'branch.created'
  | 'conflict.detected';

export interface EventRef {
  eventId: ID;
  version: number;
}

/** 来源链：每条派生记录保存规则版本、依赖事件与输入内容摘要 */
export interface Derivation {
  ruleVersion: string;
  dependsOn: EventRef[];
  inputSummaries: { label: string; sha256?: string; entityId?: ID }[];
  /** 依赖失效范围计算结果缓存：本记录失效于哪些事件之后 */
  invalidatedBy?: ID[];
}

export interface DomainEvent {
  eventId: ID;
  branchId: ID;
  version: number;
  type: EventType;
  at: string;
  author: string;
  /** 输入实体/解释实体的完整载荷（原始表示） */
  payload: unknown;
  derivation?: Derivation;
  /** 乐观并发：基于分支 version；为 0 表示不检查 */
  expectedVersion: number;
  /** 与另一分支/窗口同时提交时的冲突关联 */
  conflictWithEventId?: ID;
  parentEventId?: ID;
}

export interface BranchInfo {
  branchId: ID;
  name: string;
  parentBranchId?: ID;
  parentEventId?: ID;
  note: string;
  createdAt: string;
}

// ---------- 实体查询（显示值都带稳定身份） ----------

export interface EntityView {
  entityId: ID;
  entityKind: string;
  branchId: ID;
  /** 当前生效版本（事件 version）；历史版本通过 atEventId 重放得到 */
  version: number;
  lastChangedEventId: ID;
  value: InputEntity | InterpretedEntity;
  derivation?: Derivation;
  /** 引用完整性：null 表示完整；损坏时给出缺失引用 */
  integrity:
    | { status: 'ok' }
    | { status: 'corrupt'; missing: { ref: string; expectedSha256?: string }[] };
}

export interface SeriesMeta {
  seriesId: ID;
  name: string;
  createdAt: string;
  imageSize: ImageSize;
  frameCount: number;
}
