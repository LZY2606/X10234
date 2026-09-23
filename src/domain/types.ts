/**
 * 倾转帧拼合室 —— 领域数据契约
 *
 * 原则：
 *  - 领域量携带单位 / 坐标基准，保留原始表示；规范化只发生在派生层。
 *  - 无法转换的值留在原位置并附诊断，绝不为了画图而丢弃。
 *  - 来源（raw / versioned input）与解释（derived interpretation）分层保存。
 *  - 每个显示值带稳定身份；缺失引用必须报损坏，不能回退最新版。
 */

export type Uid = string;

/** 已知单位词汇（仅这些单位允许静默规范化；其余保留原值 + 诊断） */
export type AngleUnit = 'degree' | 'radian';
export type LengthUnit = 'pixel' | 'nm' | 'um';
export type DoseUnit = 'e/angstrom^2' | 'e/nm^2';

export type QuantityKind = 'angle' | 'length' | 'dose' | 'scalar';

/** 带单位 / 坐标基准的领域量；raw 是导入时的原始表示，永不重写 */
export interface Quantity {
  kind: QuantityKind;
  raw: string | number;
  unit: string;
  value?: number; // 规范化后的数值（转换失败时缺失）
  normalizedUnit?: string;
  coordFrame?: string; // 坐标基准，如 "image-pixel"、"specimen-nm"
  diagnostics?: Diagnostic[];
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

/** 原始帧（像素字节单独内容寻址存储，这里只保留摘要与渲染基准） */
export interface RawFrame {
  kind: 'RawFrame';
  frameId: Uid;
  index: number;
  width: number;
  height: number;
  pixelFormat: string; // 如 "uint8-gray"
  blobSha256: string;
  byteLength: number;
  exposure?: Quantity; // 秒（可选原始记录）
  originNote?: string;
}

/** 倾角：绝不假设对称、零中心或连续 */
export interface TiltAngle {
  kind: 'TiltAngle';
  frameId: Uid;
  angle: Quantity; // 规范化为 degree，坐标基准 goniometer
}

/** 像素尺度：像元物理尺寸，必须带坐标基准 */
export interface PixelScale {
  kind: 'PixelScale';
  frameId: Uid;
  scale: Quantity; // 规范化 nm/pixel
}

/** 曝光剂量（每帧） */
export interface FrameDose {
  kind: 'FrameDose';
  frameId: Uid;
  dose: Quantity; // 规范化 e/angstrom^2
}

/** fiducial 标记点的一次观测（某条轨迹在某帧中的坐标） */
export interface MarkerObservation {
  kind: 'MarkerObservation';
  trackId: Uid;
  frameId: Uid;
  x: Quantity; // pixel
  y: Quantity; // pixel
  coordFrame: 'image-pixel';
  observed: boolean; // false 表示该帧明确缺失（轨迹缺口）
}

/**
 * 跟踪缺口：轨迹可断裂。
 * gap 表示某条轨迹在连续帧区间内无观测（不是坏帧，是跟踪丢失）。
 */
export interface TrackGap {
  kind: 'TrackGap';
  trackId: Uid;
  fromFrameIndex: number;
  toFrameIndex: number;
  reason?: string;
}

/**
 * 轨迹身份交换：两段轨迹可能在交换点之后互换了身份。
 * 导入时不做不可逆“纠正”，只记录候选链接。
 */
export interface TrackIdentityLink {
  kind: 'TrackIdentityLink';
  linkId: Uid;
  segmentA: Uid;
  segmentB: Uid;
  atFrameId: Uid; // 交换发生的帧（交换点之后身份互换）
  confidence?: Quantity;
  note?: string;
}

/** 手工排除帧的原因（人类决定，进入版本化输入，不等于坏帧自动诊断） */
export interface ManualExclusion {
  kind: 'ManualExclusion';
  frameId: Uid;
  reason: string;
  reviewer: string;
}

export type VersionedInputPayload =
  | RawFrame
  | TiltAngle
  | PixelScale
  | FrameDose
  | MarkerObservation
  | TrackGap
  | TrackIdentityLink
  | ManualExclusion;

/** 输入实体的版本信封：所有输入只追加、可分支 */
export interface VersionedInput {
  sourceId: Uid; // 稳定身份（同一逻辑实体跨版本不变）
  versionId: Uid;
  parentVersionId: Uid | null;
  entityType: VersionedInputPayload['kind'];
  payload: VersionedInputPayload;
  materialVersionId: Uid; // 所属材料（case / bundle）版本
  committedAt: string;
  sha256: string;
}

/** 倾转轴参数（派生解释，不是输入） */
export interface TiltAxisSpec {
  kind: 'TiltAxisSpec';
  axisId: Uid;
  /** 轴线与图像 x 轴夹角，degree，coordFrame=image-pixel */
  directionAngle: Quantity;
  /** 轴线穿过的点 —— 显式存在；绝不默认图像中心 */
  centerX: Quantity;
  centerY: Quantity;
  assumedImageCenter: boolean; // true 仅表示“采纳了图像中心假设”，必须显式
  diagnostic?: Diagnostic;
}

/** 候选策略类别 */
export type CandidateStrategy =
  | 'rigid' // 刚体：共享轴 + 每帧平移
  | 'local-warp' // 局部形变：每帧附加仿射自由度
  | 'exclude-bad-frames'; // 排除坏帧

/** 每帧残差 —— 显示值，带稳定身份 */
export interface PerFrameResidual {
  residualId: Uid;
  candidateId: Uid;
  frameId: Uid;
  meanResidual: Quantity; // pixel
  maxResidual: Quantity; // pixel
  observationCount: number;
  excludedFromFit: boolean;
  frameWeight: number;
}

/** 配准候选（派生实体） */
export interface AlignmentCandidate {
  kind: 'AlignmentCandidate';
  candidateId: Uid;
  interpretationId: Uid;
  strategy: CandidateStrategy;
  label: string;
  tiltAxis: TiltAxisSpec;
  /** 有效点集的确定性指纹 —— 不同候选必须在相同有效点集上比较 */
  effectivePointSetHash: string;
  effectivePointSet: Array<{ trackId: Uid; frameId: Uid }>;
  effectiveFrameIds: Uid[];
  perFrameResiduals: PerFrameResidual[];
  /** 主指标（像素 RMS）；次要诊断不允许通过删帧“刷低” */
  rmsResidual: Quantity;
  rmsOnCommonSet: Quantity; // 公共有效点集上的 RMS —— 唯一可比指标
  heldOutRms?: Quantity; // local-warp 的交叉验证残差
  degreesOfFreedom: number;
  parameterSummary: string;
  diagnostics: Diagnostic[];
  ambiguityGroup?: string; // 多解：同一组内候选在有效点集上等价
}

/** 解释：一次“对材料的重新解释”是一个新分支 */
export interface Interpretation {
  kind: 'Interpretation';
  interpretationId: Uid;
  branchId: Uid;
  materialVersionId: Uid;
  ruleVersion: string; // 生成该解释的规则版本
  parentInterpretationId: Uid | null;
  candidates: AlignmentCandidate[];
  diagnostics: Diagnostic[];
  createdAt: string;
}

export type EventType =
  | 'material.imported'
  | 'material.revised'
  | 'interpretation.created'
  | 'candidate.computed'
  | 'review.viewed'
  | 'decision.accepted'
  | 'decision.rejected'
  | 'decision.parameter-adjusted'
  | 'registration.locked'
  | 'registration.unlocked'
  | 'scenario.triggered'
  | 'conflict.detected'
  | 'integrity.corrupt';

/** 机器可读的裁定/规则判断依据（判定代码 + 结构化对象） */
export interface JudgmentBasis {
  code: string; // 如 AXIS_NOT_CENTERED / FAIR_COMMON_POINT_SET / NO_FEWER_FRAMES_TRICK
  message: string;
  evidence?: Record<string, unknown>;
}

/** 只追加的事件 —— 分支历史的唯一事实来源 */
export interface LedgerEvent {
  eventId: Uid;
  branchId: Uid;
  seq: number; // 分支内单调序号，乐观锁
  type: EventType;
  basis: JudgmentBasis[];
  refs: {
    materialVersionId?: Uid;
    interpretationId?: Uid;
    candidateId?: Uid;
    ruleVersion?: string;
    sourceVersionIds?: Uid[];
    parentEventId?: Uid;
  };
  payload?: Record<string, unknown>;
  actor: string;
  at: string;
  sha256: string;
}

export interface Branch {
  branchId: Uid;
  name: string;
  parentBranchId: Uid | null;
  forkedFromEventSeq: number | null;
  headSeq: number;
  lockedCandidateId: Uid | null;
  createdAt: string;
}

/** 被采纳 / 未采纳结果都保留的裁定记录 */
export interface DecisionRecord {
  decisionId: Uid;
  branchId: Uid;
  eventId: Uid;
  candidateId: Uid;
  action: 'accept' | 'reject' | 'adjust-params';
  parameterPatch?: Record<string, Quantity>;
  supersededBy: Uid | null; // 撤销时指向新决定；旧决定继续可读
  reverted: boolean;
  reviewer: string;
  at: string;
  basis: JudgmentBasis[];
}

/** 查询实体时返回的版本信封 */
export interface EntityEnvelope<T> {
  stableId: Uid;
  versionId: Uid;
  entityType: string;
  payload: T;
  contentSummary: string; // sha256 摘要
  referencedVersions: Array<{ refName: string; versionId: Uid; contentSummary: string }>;
}

/** 损坏引用：必须报错而非回退最新 */
export interface CorruptReference {
  kind: 'CorruptReference';
  fromEntity: Uid;
  missingVersionId: Uid;
  refName: string;
}

export class IntegrityError extends Error {
  constructor(public corruptions: CorruptReference[]) {
    super(`损坏引用: ${corruptions.map((c) => c.missingVersionId).join(', ')}`);
    this.name = 'IntegrityError';
  }
}

/** 版本冲突（并发冻结检验） */
export interface VersionConflict {
  kind: 'VersionConflict';
  branchId: Uid;
  expectedHeadSeq: number;
  actualHeadSeq: number;
  myEvent: LedgerEvent;
  theirEvent: LedgerEvent;
  diff: Record<string, unknown>;
}

/** 失效范围：参数/参考版本变化后的依赖追踪结果 */
export interface InvalidationScope {
  changedSourceVersionId: Uid;
  affectedInterpretationIds: Uid[];
  affectedCandidateIds: Uid[];
  affectedEventIds: Uid[];
  unaffectedBranches: Uid[];
}

/** 反例情形标识 */
export type ScenarioCode =
  | 'axis-offset'
  | 'track-identity-swap'
  | 'missing-high-tilt'
  | 'bad-frame-exclusion'
  | 'local-warp-overfit'
  | 'multi-solution'
  | 'concurrent-freeze';

/** 反例档案条目：最小输入 / 组合输入各自独立解释 */
export interface CounterExampleEntry {
  scenario: ScenarioCode;
  minimalMaterialVersionId: Uid;
  combinedMaterialVersionId: Uid;
  sharedBlobHashes: string[]; // 两者共享的不可变原始片段
  minimalInterpretationIds: Uid[];
  combinedInterpretationIds: Uid[];
  expectedBasis: JudgmentBasis[];
}
