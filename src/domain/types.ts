import type { StableId } from '../core/ids.ts';

/**
 * 领域词汇数据契约。
 * 不把一切压成 name/value：每个实体使用电子断层领域自己的名词。
 */

export type BranchId = StableId;

/** 带单位或坐标基准的领域量；导入时保留原始表示，派生层才做规范化。 */
export interface DomainQuantity {
  /** 原始表示（例如 "2.74 Å/pix"、"61.2 e-/Å²"），永远保留 */
  raw: string;
  /** 规范化数值（仅在可转换时存在） */
  normalized?: number;
  /** 规范化单位 */
  normalizedUnit?: string;
  /** 无法转换时为 true，值留在原位置并附诊断 */
  unconverted?: boolean;
  /** 诊断信息 */
  diagnostic?: string;
  /** 单位或坐标基准，所有领域量必须携带 */
  basis: string;
}

/** 坐标基准 */
export interface CoordinateBasis {
  /** 例如 image-pixels-topleft / reconstruction-voxel-center */
  frame: string;
  /** 图像像素坐标，原点与轴向约定 */
  origin: 'top-left' | 'center' | 'fiducial-derived';
  axisX: string;
  axisY: string;
  /** 可选旋转（度），图像行轴到 basis X 轴 */
  rotationDeg?: number;
}

/** 稳定引用：必须解析得到，缺少引用报损坏，不能退回当前最新版。 */
export interface VersionedRef<TKind extends string = string> {
  kind: TKind;
  id: StableId;
  /** 被引用实体的版本号（必填，用于历史视图） */
  version: number;
  /** 被引用内容摘要，查询时核对；不匹配报损坏 */
  contentDigest: string;
}

export type Ref = VersionedRef;

/* ------------------------------------------------------------------ */
/* 来源层（source）：原始帧、倾角、像素尺度、剂量、标记点坐标、         */
/* 跟踪缺口与手工排除原因全部版本化。来源与解释拆开保存。              */
/* ------------------------------------------------------------------ */

export interface ImportBatch {
  kind: 'importBatch';
  id: StableId;
  version: number;
  label: string;
  importedAt: string;
  /** 原始来源描述（文件名、操作员、仪器导出头） */
  provenance: Record<string, string>;
  /** 原子批次：失败即整体回滚 */
  memberIds: StableId[];
  contentDigest: string;
}

export interface RawFrame {
  kind: 'rawFrame';
  id: StableId;
  version: number;
  /** 倾转序列内顺序索引，最小输入与组合输入共享同一片段时保持稳定 */
  sequenceIndex: number;
  /** 不可变内容片段（原始字节只存一份） */
  blobId: StableId;
  width: number;
  height: number;
  /** 帧像素数据基准 */
  basis: CoordinateBasis;
  /** 采集时间戳原始表示 */
  acquiredAtRaw?: string;
  contentDigest: string;
}

export interface TiltAngleRecord {
  kind: 'tiltAngleRecord';
  id: StableId;
  version: number;
  frameId: StableId;
  /** 倾角：保留原始表示，派生层规范化为度 */
  angle: DomainQuantity;
  /** 倾角方案（dose-symmetric / linear / manual）原始表示 */
  scheme: string;
  contentDigest: string;
}

export interface PixelScaleRecord {
  kind: 'pixelScaleRecord';
  id: StableId;
  version: number;
  /** 像素尺度可整批或逐帧；frameId 为空表示全序列默认值 */
  frameId?: StableId;
  scale: DomainQuantity;
  contentDigest: string;
}

export interface ExposureDoseRecord {
  kind: 'exposureDoseRecord';
  id: StableId;
  version: number;
  frameId: StableId;
  /** 单帧剂量 */
  frameDose: DomainQuantity;
  /** 累积剂量（原始记录，可为缺失） */
  cumulativeDose?: DomainQuantity;
  contentDigest: string;
}

/** 单帧上的 fiducial 标记点坐标（来源层） */
export interface MarkerObservation {
  kind: 'markerObservation';
  id: StableId;
  version: number;
  frameId: StableId;
  /** 来源文件中的标记编号（可能跨断裂重复/交换） */
  markerLabel: string;
  x: DomainQuantity;
  y: DomainQuantity;
  /** 该观测归属的轨迹片段（解释层），允许为空表示尚未解释 */
  segmentId?: StableId;
  contentDigest: string;
}

/** fiducial 轨迹可断裂：片段是一段连续被跟踪的观测 */
export interface FiducialTrackSegment {
  kind: 'fiducialTrackSegment';
  id: StableId;
  version: number;
  /** 同一物理 bead 的片段共享 trajectoryKey（解释层分配，可被重解释） */
  trajectoryKey: string;
  observationIds: StableId[];
  frameIds: StableId[];
  /** 断裂点：与上一片段之间的缺口（首片段可为空） */
  gapAfter?: StableId;
  contentDigest: string;
}

export interface TrackGapRecord {
  kind: 'trackGapRecord';
  id: StableId;
  version: number;
  trajectoryKey: string;
  /** 缺口两侧帧的顺序索引（闭区间内该轨迹无观测） */
  fromSequenceIndex: number;
  toSequenceIndex: number;
  reason: DomainQuantity;
  contentDigest: string;
}

/** 轨迹身份交换嫌疑：两个 trajectoryKey 在某个帧区间可能对调 */
export interface IdentitySwapSuspect {
  kind: 'identitySwapSuspect';
  id: StableId;
  version: number;
  keyA: string;
  keyB: string;
  betweenSequenceIndices: [number, number];
  evidence: DomainQuantity;
  /** 是否由裁定确认为真实交换 */
  confirmed: boolean;
  contentDigest: string;
}

export interface ManualExclusion {
  kind: 'manualExclusion';
  id: StableId;
  version: number;
  frameId?: StableId;
  observationId?: StableId;
  /** 手工排除原因：版本化、可撤销 */
  reason: DomainQuantity;
  reviewer: string;
  decidedAt: string;
  /** 撤销该排除的事件 id（空表示仍生效） */
  undoneByEventId?: StableId;
  contentDigest: string;
}

/* ------------------------------------------------------------------ */
/* 解释层（interpretation）：轴线模型、轨迹模型、配准候选、裁定、锁定。 */
/* 对同一份材料重新解释时新建分支，旧分支与人工裁定继续可读。           */
/* ------------------------------------------------------------------ */

export interface InterpretationBranch {
  kind: 'interpretationBranch';
  id: StableId;
  version: number;
  name: string;
  /** 父分支（基线分支为空） */
  parentBranchId?: StableId;
  /** 该分支依据的规则版本 */
  ruleVersion: string;
  /** 分支可见的所有来源版本引用（时间旅行时恢复当时依赖） */
  sourceRefs: Ref[];
  createdAt: string;
  /** 被锁定重建引用时记录锁 */
  lockedBy?: StableId;
  contentDigest: string;
}

/**
 * 倾转轴模型。禁止默认把轴放在图像中心：
 * offset 必须来自估计或显式声明，center 仅作初值且必须带 assumed=true。
 */
export interface TiltAxisModel {
  kind: 'tiltAxisModel';
  id: StableId;
  version: number;
  branchId: BranchId;
  /** 轴在图像面内的方向角（度） */
  axisAngleDeg: number;
  /** 轴在垂直方向上的截距（像素，坐标基准见 basis） */
  offset: number;
  offsetBasis: CoordinateBasis;
  /** true 表示仅为假设（例如中心初值），不得当作估计结论 */
  assumed: boolean;
  /** 多解：所有达到容差的候选轴 */
  alternativeAxes?: { axisAngleDeg: number; offset: number; score: number }[];
  score: number;
  contentDigest: string;
}

export interface FiducialTrajectoryModel {
  kind: 'fiducialTrajectoryModel';
  id: StableId;
  version: number;
  branchId: BranchId;
  /** trajectoryKey -> 解释后的物理 bead 索引 */
  keyToBead: Record<string, number>;
  /** 被确认的身份交换（id） */
  confirmedSwaps: StableId[];
  /** 被采纳的断裂（gap id） */
  acceptedGaps: StableId[];
  contentDigest: string;
}

export type RegistrationVariant = 'rigid' | 'localDeform' | 'badFrameExcluded';

/** 每帧残差（审阅页展示用） */
export interface PerFrameResidual {
  frameId: StableId;
  sequenceIndex: number;
  tiltAngleDeg: number;
  /** 有效标记点数 */
  validMarkerCount: number;
  /** RMS 重投影残差（规范化单位） */
  rms: number;
  /** 该帧是否被排除在本候选之外 */
  excluded: boolean;
  residualUnit: string;
}

export interface RegistrationCandidate {
  kind: 'registrationCandidate';
  id: StableId;
  version: number;
  branchId: BranchId;
  variant: RegistrationVariant;
  axisRef: Ref;
  trajectoryRef: Ref;
  /** 本候选实际使用的有效点集（frameId × observationId） */
  effectivePointSet: { frameId: StableId; observationId: StableId }[];
  /** 共同有效点集（候选间公平比较所用）——禁止用少帧换低残差 */
  commonPointSetSize: number;
  /** 共同有效点集上的 RMS，这是候选排序依据 */
  commonSetRms: number;
  /** 本候选全部有效点上的 RMS（诊断用，不用于排名） */
  ownSetRms: number;
  perFrame: PerFrameResidual[];
  /** 自由度与覆盖度（局部形变过拟合诊断） */
  degreesOfFreedom: number;
  coverageRatio: number;
  /** 过拟合标记：共同集残差低但留出轨迹残差显著变差 */
  overfitFlag: boolean;
  overfitDiagnostic?: string;
  /** 多解标记：存在同等评分的其它解 */
  ambiguous: boolean;
  /** 排除帧 id（仅 badFrameExcluded） */
  excludedFrameIds: StableId[];
  ruleVersion: string;
  contentDigest: string;
}

export interface Adjudication {
  kind: 'adjudication';
  id: StableId;
  version: number;
  branchId: BranchId;
  candidateRef: Ref;
  decision: 'accepted' | 'rejected';
  reason: DomainQuantity;
  reviewer: string;
  decidedAt: string;
  /** 撤销裁定：恢复前一分支，不删除历史 */
  undoneByEventId?: StableId;
  contentDigest: string;
}

export interface ReconstructionLock {
  kind: 'reconstructionLock';
  id: StableId;
  version: number;
  branchId: BranchId;
  candidateRef: Ref;
  adjudicationRef: Ref;
  lockedAt: string;
  /** 重建读回档案时使用的稳定句柄 */
  readbackHandle: string;
  contentDigest: string;
}

/** 复核实体：审阅页状态（帧叠影、轴、断点、残差、候选差分的视图选择） */
export interface ReviewView {
  kind: 'reviewView';
  id: StableId;
  version: number;
  branchId: BranchId;
  /** 叠影包含的帧顺序 */
  overlayFrameIds: StableId[];
  shownAxisRef?: Ref;
  shownGapIds: StableId[];
  shownCandidateRefs: Ref[];
  /** 当前时间旅行位置（事件序号）；空表示最新 */
  atEventSeq?: number;
  contentDigest: string;
}

/* ------------------------------------------------------------------ */
/* 事件层：append-only 领域事件，机器可读的判断依据与裁定都落事件。     */
/* ------------------------------------------------------------------ */

export type DomainEventType =
  | 'source.ingested'
  | 'source.reinterpreted'
  | 'source.amended'
  | 'branch.created'
  | 'axis.estimated'
  | 'trajectory.assembled'
  | 'candidate.proposed'
  | 'judgment.recorded'
  | 'adjudication.decided'
  | 'adjudication.undone'
  | 'view.changed'
  | 'reconstruction.locked'
  | 'rule.revised'
  | 'derivation.invalidated'
  | 'conflict.detected'
  | 'import.rollback'
  | 'archive.linked';

/** 判断依据（机器可读）：倾转轴/轨迹/公平比较等原则的判定结果 */
export interface DomainJudgment {
  kind: 'domainJudgment';
  id: StableId;
  version: number;
  /** 被判定的原则代码 */
  principle:
    | 'axis.not-centered-by-default'
    | 'trajectory.may-break'
    | 'identity.may-swap'
    | 'compare-on-same-effective-point-set'
    | 'no-fewer-frames-for-lower-residual'
    | 'keep-all-legal-candidates-on-ambiguity'
    | 'no-irreversible-cleanup-on-import';
  subjectRefs: Ref[];
  /** 判定结论与机器可读证据 */
  holds: boolean;
  evidence: Record<string, unknown>;
  ruleVersion: string;
  decidedAt: string;
  contentDigest: string;
}

export interface DomainEvent {
  seq: number;
  id: StableId;
  type: DomainEventType;
  branchId: BranchId;
  /** 乐观并发：提交时分支末端 seq */
  parentSeq: number;
  timestamp: string;
  actor: string;
  /** 事件负载：实体版本与摘要 */
  payload: Record<string, unknown>;
  /** 该事件产生/改动的实体版本引用 */
  entityRefs: Ref[];
  /** 规则版本（派生事件必填） */
  ruleVersion?: string;
  /** 依赖失效范围（derivation.invalidated 事件使用） */
  invalidation?: { scope: 'local' | 'global'; subjectRefs: Ref[]; reason: string };
}

/* ------------------------------------------------------------------ */
/* 反例档案：最小输入 + 组合输入共享原始片段，解释/诊断/决定独立。      */
/* ------------------------------------------------------------------ */

export type ScenarioKey =
  | 'axisEccentric'
  | 'identitySwap'
  | 'missingHighTilt'
  | 'badFrameExcluded'
  | 'localOverfit'
  | 'ambiguityMultiSolution'
  | 'concurrentFreeze';

export interface ScenarioCase {
  key: ScenarioKey;
  title: string;
  /** 最小输入引用（原始片段，不可变） */
  minimalInputId: StableId;
  /** 组合输入引用 */
  combinedInputId: StableId;
  /** 共享原始片段 blob 只存一份 */
  sharedBlobIds: StableId[];
  /** 两种输入各自的解释版本、失败诊断、人工决定 */
  interpretations: Record<'minimal' | 'combined', ScenarioInterpretation>;
  /** 被采纳与未采纳的结果都保留 */
  acceptedCandidateRef?: Ref;
  rejectedCandidateRefs: Ref[];
}

export interface ScenarioInterpretation {
  branchId: BranchId;
  diagnosis: DomainQuantity;
  affectedRefs: Ref[];
  humanDecisionRef?: Ref;
  expectedJudgments: { principle: DomainJudgment['principle']; holds: boolean }[];
}

export interface ScenarioArchive {
  kind: 'scenarioArchive';
  id: StableId;
  version: number;
  title: string;
  cases: ScenarioCase[];
  /** 规则版本清单 */
  ruleVersions: Ref[];
  contentDigest: string;
}

export type AnyEntity =
  | ImportBatch
  | RawFrame
  | TiltAngleRecord
  | PixelScaleRecord
  | ExposureDoseRecord
  | MarkerObservation
  | FiducialTrackSegment
  | TrackGapRecord
  | IdentitySwapSuspect
  | ManualExclusion
  | InterpretationBranch
  | TiltAxisModel
  | FiducialTrajectoryModel
  | RegistrationCandidate
  | Adjudication
  | ReconstructionLock
  | ReviewView
  | ScenarioArchive
  | DomainJudgment;

export type EntityOfKind<K extends AnyEntity['kind']> = Extract<AnyEntity, { kind: K }>;
