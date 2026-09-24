// 领域数据契约：直接使用电子断层领域词汇，不压成 name/value。
// 所有领域量携带单位或坐标基准；原始层保留原始表示，派生层才规范化。

export type Unit = 'nm' | 'um' | 'pixel' | 'degree' | 'radian' | 'e_per_A2' | 'e_per_nm2' | 'count' | 'dimensionless';

/** 带单位与坐标基准的量：原始表示保留，规范化值由派生层计算 */
export interface Dimensioned {
  raw: string | number;          // 导入时的原始表示，绝不丢
  value: number | null;          // 规范化到 canonicalUnit 后的数值；无法转换则 null
  unit: Unit;                    // 原始单位
  canonicalUnit: Unit;           // 派生层使用的规范单位
  coordinateFrame?: string;      // 坐标基准（图像/标本/...）
  diagnostics?: string[];        // 无法转换等问题留在原位
}

export type SourceKind =
  | 'rawFrame'
  | 'tiltAngle'
  | 'pixelScale'
  | 'exposureDose'
  | 'fiducialCoordinate'
  | 'trackingGap'
  | 'manualExclusion';

export interface FrameRef {
  frameId: FrameId;
  index: number;      // 倾转序列中的顺序（0 起）
}

/** 原始帧：不可变原始字节的引用（此处离线案例用合成帧描述代替真实 MRC 字节） */
export interface RawFrame {
  kind: 'rawFrame';
  frameId: FrameId;
  index: number;
  widthPx: number;
  heightPx: number;
  /** 合成帧的确定性种子；真实导入时为字节哈希，二者都内容寻址 */
  contentSeed: string;
  sha256: string;
  intensityStats: { min: number; max: number; mean: number };
  acquiredAt?: string;
}

export interface TiltAngle {
  kind: 'tiltAngle';
  frameId: FrameId;
  angle: Dimensioned;   // degree，规范为 radian
}

export interface PixelScale {
  kind: 'pixelScale';
  pixelSize: Dimensioned; // nm/pixel 或 um/pixel，规范 nm/pixel
  appliesToFrames: FrameId[];
}

export interface ExposureDose {
  kind: 'exposureDose';
  frameId: FrameId;
  dose: Dimensioned;     // e-/Å^2 或 e-/nm^2，规范 e-/Å^2
  cumulative?: boolean;
}

/** fiducial 标记点在某帧的坐标（图像坐标基准，单位 pixel） */
export interface FiducialCoordinate {
  kind: 'fiducialCoordinate';
  observationId: ObservationId;
  frameId: FrameId;
  label: string;               // 导入文件里的原始标记名
  x: Dimensioned;
  y: Dimensioned;
  uncertaintyPx?: number;
}

/** 跟踪缺口：某标记在某帧区间未被观测，轨迹允许断裂 */
export interface TrackingGap {
  kind: 'trackingGap';
  gapId: string;
  label: string;
  fromFrameId: FrameId;
  toFrameId: FrameId;
  reason?: string;
}

/** 手工排除原因：不删除数据，仅标记并保留理由 */
export interface ManualExclusion {
  kind: 'manualExclusion';
  exclusionId: string;
  frameId?: FrameId;
  observationId?: ObservationId;
  reasonCode: 'motion' | 'charging' | 'focus' | 'crack' | 'other';
  note: string;
  decidedBy: string;
}

export type SourceEntity =
  | RawFrame | TiltAngle | PixelScale | ExposureDose
  | FiducialCoordinate | TrackingGap | ManualExclusion;

// ---------- 解释 / 派生实体 ----------

export type AlignmentModelKind = 'rigid' | 'localDeformation' | 'rigidWithExclusion';

/** 倾转轴：必须由数据估计，绝不默认固定在图像中心 */
export interface TiltAxisEstimate {
  axisId: string;
  /** 轴线在图像坐标中的表达：点 + 方向角，单位 pixel / degree */
  originX: number; originY: number;     // pixel，允许偏离图像中心
  angleDeg: number;
  fixedAtImageCenter: boolean;          // 必须 false，除非有显式依据事件
  residualRms: number;
  evidence: string;                     // 依据说明
}

/** 一条 fiducial 轨迹：可断裂为多个片段，标签可发生身份交换 */
export interface FiducialTrack {
  trackId: TrackId;
  segments: TrackSegment[];
  identitySwaps: IdentitySwap[];
}

export interface TrackSegment {
  segmentId: string;
  observations: ObservationId[]; // 有序
  frameRange: [FrameId, FrameId];
  broken: boolean;
}

export interface IdentitySwap {
  swapId: string;
  atFrameId: FrameId;
  labels: [string, string];
  resolved: boolean;
}

/** 单个配准候选 */
export interface AlignmentCandidate {
  candidateId: CandidateId;
  modelKind: AlignmentModelKind;
  parentCandidateId?: CandidateId;
  excludedFrames: FrameId[];
  /** 该候选实际使用的有效点集指纹：不同候选必须用相同有效点集比较 */
  effectivePointSetHash: string;
  transforms: PerFrameTransform[];
  perFrameResidual: Record<FrameId, number>; // 规范化单位 pixel
  residualRms: number;
  residualRmsOnCommonSet: number;             // 公平比较指标
  maxResidual: number;
  degreesOfFreedom: number;
  pointCount: number;
  overfitFlag: boolean;
  warnings: string[];
  notes?: string;
}

export interface PerFrameTransform {
  frameId: FrameId;
  /** 相对参考帧的 2D 相似/形变参数；rigid=[tx,ty,theta,scale] */
  params: number[];
  paramNames: string[];
}

export type AdjudicationDecision = 'accepted' | 'rejected' | 'parameter_adjusted';

export interface Adjudication {
  adjudicationId: string;
  candidateId: CandidateId;
  decision: AdjudicationDecision;
  decidedBy: string;
  rationale: string;
  /** 锁定后供重建引用的版本号；只有 accepted 可锁定 */
  lockedForReconstruction: boolean;
  createdAt: string;
}

// ---------- 标识 ----------
export type FrameId = string & { readonly __brand: 'FrameId' };
export type ObservationId = string & { readonly __brand: 'ObservationId' };
export type TrackId = string & { readonly __brand: 'TrackId' };
export type CandidateId = string & { readonly __brand: 'CandidateId' };
export type ContentHash = string;
export type VersionNumber = number;

// ---------- 事件溯源 ----------

export type EventType =
  | 'packageImported'
  | 'sourceRecorded'
  | 'interpretationBranched'
  | 'axisEstimated'
  | 'trackAssembled'
  | 'identitySwapResolved'
  | 'candidateComputed'
  | 'candidateAdjudicated'
  | 'registrationLocked'
  | 'parameterRevised'
  | 'sourceLocallyChanged'
  | 'conflictingManualDecision'
  | 'rollbackRequested'
  | 'fairComparisonEvaluated'
  | 'ruleAssertionRecorded'
  | 'scenarioReplayed'
  | 'corruptionDetected';

export interface DomainEvent<T = unknown> {
  eventId: string;
  eventType: EventType;
  seq: VersionNumber;
  branch: string;
  parentEventId: string | null;
  timestamp: string;
  actor: string;
  /** 乐观并发：该事件提交时期望的分支头 */
  expectedHead: string | null;
  payload: T;
  /** 该事件依赖的（实体→版本/内容哈希），用于失效范围计算与损坏检测 */
  refs: Record<string, string>;
  ruleAssertions?: RuleAssertion[];
}

/** 机器可读取的判断依据 */
export interface RuleAssertion {
  ruleId:
    | 'AXIS_NOT_CENTER_DEFAULT'
    | 'TRACKS_CAN_BREAK_AND_SWAP'
    | 'COMMON_EFFECTIVE_POINT_SET'
    | 'NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL';
  holds: boolean;
  evidence: string;
  subjectIds: string[];
}

export interface EntityView {
  id: string;
  kind: string;
  version: VersionNumber;
  contentHash: ContentHash;
  /** 它引用的版本号与内容摘要；缺引用即损坏 */
  references: { ref: string; version: VersionNumber; contentSummary: string }[];
  summary: string;
  value: unknown;
}

export interface ContentObject {
  sha256: ContentHash;
  kind: SourceKind | string;
  bytes: string;        // 原始表示（JSON 字符串或编码字节）
  mediaType: string;
  recordedAt: string;
}
