/**
 * 领域数据契约 —— 直接使用电子断层/倾转序列的领域词汇，
 * 禁止把一切压成 name/value。
 *
 * 分层：
 *   Source（原始/来源层）：帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、手工排除原因。
 *                          全部版本化、不可变；保留原始表示、单位/坐标基准。
 *   Interpretation（解释层）：倾转轴、fiducial 轨迹（可断裂/身份交换）、配准候选、裁定。
 *   Event（事件层）：机器可读取的事实，时间旅行重放即还原当时结论。
 */

export type UnitSystem = 'SI' | 'imperial' | 'custom';

/** 带单位/坐标基准的物理量：原始表示原样保留，规范化只发生在派生层。 */
export interface UnitMeasure {
  /** 原始文本，例如 "60.0 °"、"2.34 e-/A^2"，导入时绝不重写。 */
  raw: string;
  /** 解析后的数值；无法转换时为 null 且 diagnostics 必填。 */
  value: number | null;
  /** 规范单位（派生层换算目标），例如 "deg"、"angstrom^-1 e"。 */
  unit: string;
  /** 坐标/角度基准说明，例如 "stage"、"image-x"。 */
  basis: string;
  diagnostics?: string[];
}

/** 坐标基准：标记点坐标必须说明是像素还是物理坐标、相对何处。 */
export interface CoordinateBasis {
  kind: 'pixel' | 'physical';
  origin: 'top-left' | 'center' | 'custom';
  unit?: string;
}

// ---------- 原始帧 ----------
export interface FrameSource {
  id: string;
  seriesId: string;
  index: number;
  label: string;
  /** 内容寻址的不可变像素字节（PGM）。 */
  blobRef: string;
  width: number;
  height: number;
  mediaType: 'image/x-portable-graymap';
  /** 采集高倾角丢失标记由数据表达，而非从存在性猜测。 */
  acquisitionRecorded: boolean;
}

// ---------- 倾角（原始来源） ----------
export interface TiltAngleSource {
  id: string;
  seriesId: string;
  frameId: string;
  angle: UnitMeasure; // deg
}

// ---------- 像素尺度 ----------
export interface PixelScaleSource {
  id: string;
  seriesId: string;
  scale: UnitMeasure; // 每像素物理长度，规范 nm/pixel
  appliesFromFrameIndex?: number;
}

// ---------- 曝光剂量 ----------
export interface DoseSource {
  id: string;
  seriesId: string;
  frameId: string;
  cumulative: UnitMeasure; // 规范 e-/angstrom^2
  perFrame?: UnitMeasure;
}

// ---------- 标记点坐标（原始观测） ----------
export interface FiducialPointObservation {
  id: string;
  seriesId: string;
  markerId: string;
  frameId: string;
  x: number;
  y: number;
  basis: CoordinateBasis;
  /** 观测精度（像素），用于加权与残差归一。 */
  sigmaPx?: number;
  /** 观测者/软件来源与该坐标的版本。 */
  observedBy: string;
}

// ---------- 跟踪缺口（来源显式记录） ----------
export interface TrackingGap {
  id: string;
  seriesId: string;
  markerId: string;
  fromFrameIndex: number;
  toFrameIndex: number;
  reason: 'occluded' | 'out-of-field' | 'low-signal' | 'unknown';
  note?: string;
}

// ---------- 手工排除原因（版本化、可撤销） ----------
export interface ManualExclusionReason {
  id: string;
  seriesId: string;
  frameId?: string;
  markerId?: string;
  pointId?: string;
  scope: 'frame' | 'marker' | 'point';
  reason: string;
  rationale: string;
  decidedBy: string;
  /** 撤销通过事件完成；这里保留首次记录的事件引用。 */
  active: boolean;
}

export type SourceEntity =
  | ({ entityType: 'frame' } & FrameSource)
  | ({ entityType: 'tilt-angle' } & TiltAngleSource)
  | ({ entityType: 'pixel-scale' } & PixelScaleSource)
  | ({ entityType: 'dose' } & DoseSource)
  | ({ entityType: 'fiducial-point' } & FiducialPointObservation)
  | ({ entityType: 'tracking-gap' } & TrackingGap)
  | ({ entityType: 'exclusion' } & ManualExclusionReason);

// ---------- 倾转轴（解释，默认不允许固定在图像中心） ----------
export interface TiltAxisParams {
  /** 轴线在参考帧上的点（像素）；必须显式给出，禁止默认 width/2。 */
  originX: number;
  originY: number;
  /** 轴线相对图像 x 轴方向（deg）。 */
  angleDeg: number;
  source: 'estimated' | 'manual' | 'reference-import';
  /** 偏心诊断：到图像中心的距离（像素）。 */
  eccentricityPx: number;
  referenceFrameId: string;
}

// ---------- 轨迹（解释；可断裂、可身份交换） ----------
export interface TrackSegment {
  markerId: string;
  frameIndexStart: number;
  frameIndexEndInclusive: number;
  pointIds: string[];
}

export interface IdentitySwap {
  atFrameIndex: number;
  markerA: string;
  markerB: string;
  evidence: string;
  resolved: boolean;
}

export interface TrackInterpretation {
  segments: TrackSegment[];
  gaps: TrackingGap[];
  swaps: IdentitySwap[];
}

// ---------- 配准候选 ----------
export type RegistrationKind = 'rigid' | 'local-deformation' | 'bad-frame-excluded';

export interface PerFrameResidual {
  frameId: string;
  frameIndex: number;
  /** 加权 RMS 残差（像素）。 */
  rmsPx: number;
  used: boolean;
  excluded: boolean;
  nPoints: number;
}

export interface TransformSummary {
  kind: RegistrationKind;
  /** 每帧 2D 刚体参数（局部形变时为分段仿射/网格）。 */
  frameTransforms: Record<string, { tx: number; ty: number; rotDeg: number }>;
  gridSize?: number;
  /** 局部形变：训练集与留出集残差，用于识别过拟合。 */
  heldOutRmsPx?: number;
  trainRmsPx?: number;
  deformationEnergy?: number;
}

export interface EffectivePointSetRef {
  /** 参与比较的有效点集身份摘要：不同候选必须用同一集合才可比。 */
  fingerprint: string;
  frameIds: string[];
  pointIds: string[];
  excludedFrameIds: string[];
  excludedPointIds: string[];
}

export type AmbiguityFlag =
  | 'unique'
  | 'multi-solution'
  | 'under-determined'
  | 'overfit'
  | 'axis-not-identifiable';

export interface RegistrationCandidate {
  id: string;
  seriesId: string;
  branchId: string;
  kind: RegistrationKind;
  effectiveSet: EffectivePointSetRef;
  transform: TransformSummary;
  overallRmsPx: number;
  perFrame: PerFrameResidual[];
  ambiguity: AmbiguityFlag;
  /** 多解时：全部合法候选身份都保留，禁止只留一个。 */
  legalAlternativeIds: string[];
  diagnostics: string[];
  /** 依赖输入版本指纹，供失效范围计算。 */
  inputFingerprint: string;
}

// ---------- 裁定 / 锁定 ----------
export type DecisionKind = 'accept' | 'reject' | 'parameter-revise';

export interface Adjudication {
  id: string;
  seriesId: string;
  branchId: string;
  candidateId?: string;
  decision: DecisionKind;
  comment: string;
  decidedBy: string;
  /** 乐观并发：基于的分支版本。 */
  basedOnHead: string;
  undone: boolean;
}

export interface LockedRegistration {
  seriesId: string;
  branchId: string;
  candidateId: string;
  forReconstructionRef: string;
  lockedBy: string;
  /** 重建读回的稳定引用（实体+版本+内容摘要）。 */
  references: EntityVersionRef[];
}

export interface EntityVersionRef {
  entityId: string;
  version: number;
  digest: string;
}

// ---------- 事件（机器可读取） ----------
export type EventType =
  | 'series.imported'
  | 'source.frame.recorded'
  | 'source.tilt.recorded'
  | 'source.pixelscale.recorded'
  | 'source.dose.recorded'
  | 'source.point.recorded'
  | 'source.gap.recorded'
  | 'source.exclusion.recorded'
  | 'source.exclusion.revoked'
  | 'rule.asserted'
  | 'param.revised'
  | 'source.reinterpreted'
  | 'interpretation.tracks.committed'
  | 'candidate.committed'
  | 'adjudication.made'
  | 'registration.locked'
  | 'decision.undone'
  | 'branch.forked'
  | 'scenario.replayed'
  | 'diagnostic.raised';

export interface EventRecord {
  id: string;
  seriesId: string;
  branchId: string;
  ordinal: number;
  type: EventType;
  parentIds: string[];
  payload: Record<string, unknown>;
  /** 机器可读取的领域判断依据。 */
  rationale?: Record<string, unknown>;
  createdAt: string;
  contentDigest: string;
}

// ---------- 领域规则判断（写成机器可读取事件） ----------
export type DomainRuleCode =
  | 'AXIS_NOT_CENTER'
  | 'TRACKS_MAY_BREAK'
  | 'IDENTITY_MAY_SWAP'
  | 'SAME_EFFECTIVE_SET'
  | 'NO_DROPPING_FRAMES_FOR_LOWER_RESIDUAL'
  | 'KEEP_ALL_LEGAL_SOLUTIONS'
  | 'NO_IRREVERSIBLE_CLEANING'
  | 'DEPENDENCY_INVALIDATION';

export interface RuleAssertion {
  code: DomainRuleCode;
  statement: string;
  appliesTo: string[];
  machine: { check: string; expect: unknown };
}

export const DOMAIN_RULES: RuleAssertion[] = [
  {
    code: 'AXIS_NOT_CENTER',
    statement: '倾转轴不能被默认固定在图像中心，必须显式估计或给定。',
    appliesTo: ['axis'],
    machine: { check: 'axis.origin == image.center unless source != default', expect: 'forbidden-default' },
  },
  {
    code: 'TRACKS_MAY_BREAK',
    statement: 'fiducial 轨迹可断裂；缺口必须由来源显式记录。',
    appliesTo: ['tracks'],
    machine: { check: 'segments.contiguous == false allowed', expect: 'segments-with-gaps' },
  },
  {
    code: 'IDENTITY_MAY_SWAP',
    statement: 'fiducial 身份可能交换，必须记录交换帧、双方与证据。',
    appliesTo: ['tracks'],
    machine: { check: 'swaps.length >= 0 and each resolved flagged', expect: 'swap-log' },
  },
  {
    code: 'SAME_EFFECTIVE_SET',
    statement: '不同候选用相同有效点集比较。',
    appliesTo: ['candidate'],
    machine: { check: 'effectiveSet.fingerprint equal across compared candidates', expect: 'equal-fingerprint' },
  },
  {
    code: 'NO_DROPPING_FRAMES_FOR_LOWER_RESIDUAL',
    statement: '不能用少帧/少点换更低残差；排除必须有独立来源原因。',
    appliesTo: ['candidate'],
    machine: { check: 'exclusion requires source exclusion reason; compare on same set', expect: 'no-free-drop' },
  },
  {
    code: 'KEEP_ALL_LEGAL_SOLUTIONS',
    statement: '无法唯一决定时保留全部合法候选。',
    appliesTo: ['candidate'],
    machine: { check: 'legalAlternativeIds exhaustive', expect: 'retain-all' },
  },
  {
    code: 'NO_IRREVERSIBLE_CLEANING',
    statement: '导入时禁止不可逆清洗；无法转换的值留在原位并附诊断。',
    appliesTo: ['source'],
    machine: { check: 'unparseable retained with diagnostics', expect: 'retain-and-diagnose' },
  },
  {
    code: 'DEPENDENCY_INVALIDATION',
    statement: '参数/参考版本变化按依赖关系计算失效范围，禁止全局静默替换。',
    appliesTo: ['candidate', 'interpretation'],
    machine: { check: 'affected entities = dependency closure', expect: 'scoped-invalidation' },
  },
];

export interface EntityLookupResult {
  entityId: string;
  entityType: string;
  version: number;
  digest: string;
  data: Record<string, unknown>;
  references: EntityVersionRef[];
  missingReferences: { entityId: string; reason: string }[];
  corrupted: boolean;
}
