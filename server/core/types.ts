// 领域词汇数据契约：电子断层 / 倾转序列 / fiducial 轨迹 / 配准候选
// 所有领域量携带单位或坐标基准；原始表示在 raw 层保留，派生层才规范化。

export type Unit =
  | 'radian' | 'degree' | 'pixel' | 'nm' | 'angstrom'
  | 'electron_per_nm2' | 'e_per_angstrom2' | 'frame_index' | 'dimensionless';

/** 带单位/坐标基准的量。无法转换时 convertible=false 并保留原文与诊断，绝不丢弃。 */
export interface DomainQuantity {
  /** 原始表示，导入时逐字保留（字符串 / 数字 / null） */
  raw: string | number | null;
  rawUnit: Unit | string;
  /** 规范化后的数值（内部统一基准，见 normalize.ts）；不可转换时为 null */
  value: number | null;
  /** 规范化后的内部单位；不可转换时为 null */
  unit: Unit | null;
  convertible: boolean;
  /** 无法转换时的诊断，留在原位置 */
  diagnostic?: string;
}

export type FrameKind = 'micrograph' | 'dark' | 'skip';

/** 原始帧（版本化实体） */
export interface RawFrameV1 {
  frameId: string; // frm_0001 稳定身份
  sequence: number; // 顺序，显式保存，导出再导入保持
  kind: FrameKind;
  widthPx: number;
  heightPx: number;
  /** 确定性灰度片段签名（用于帧叠影绘制与内容寻址），非真实图片 */
  intensitySignature: number[];
  rawFileName: string;
  contentRef: BlobRef;
}

export interface BlobRef {
  sha256: string; // 内容哈希；共享原始片段只存一份不可变内容
  bytes: number;
}

/** 倾角（带原始单位表示） */
export interface TiltAngleV1 {
  frameId: string;
  angle: DomainQuantity;
}

/** 像素尺度 */
export interface PixelScaleV1 {
  frameId?: string; // 缺省表示整序列统一尺度
  scale: DomainQuantity; // nm/pixel 等
}

/** 曝光剂量 */
export interface DoseV1 {
  frameId: string;
  dose: DomainQuantity;
  cumulative?: DomainQuantity;
}

/** fiducial 标记点定义（物理实体，与轨迹观测分开） */
export interface FiducialMarkerV1 {
  markerId: string; // fmk_a 稳定身份
  note?: string;
}

/** 标记点在某帧上的坐标观测；属于一条轨迹段 */
export interface MarkerObservationV1 {
  observationId: string; // obs_fmk_a_frm_0001
  markerId: string;
  frameId: string;
  x: DomainQuantity; // pixel，坐标基准：图像左上原点
  y: DomainQuantity;
  basis: 'image_top_left_px';
}

/** 跟踪缺口（轨迹断裂显式记录，不静默插值） */
export interface TrackingGapV1 {
  gapId: string; // gap_fmk_a_0003_0005
  markerId: string;
  fromFrameId: string;
  toFrameId: string;
  reason: DomainQuantity; // dimensionless 文本载荷：occluded / out_of_field / detector_badline
}

/** 手工排除原因（版本化） */
export interface ManualExclusionV1 {
  exclusionId: string; // exc_frm_0007
  targetFrameId?: string;
  targetObservationId?: string;
  reasonCode: 'excessive_motion' | 'ice_contamination' | 'bad_focus' | 'beam_blocked' | 'detector_fault' | 'other';
  reasonText: string;
  author: string;
}

export type SourceEntityKind =
  | 'rawFrame' | 'tiltAngle' | 'pixelScale' | 'dose'
  | 'fiducialMarker' | 'markerObservation' | 'trackingGap' | 'manualExclusion';

export type EntityStatus = 'active' | 'superseded' | 'excluded' | 'broken';

/** 版本化实体信封：查询任一实体返回引用版本号与内容摘要；缺引用即损坏 */
export interface VersionedEnvelope<T = unknown> {
  stableId: string;
  kind: SourceEntityKind | DerivedEntityKind;
  versionId: string; // 内容寻址版本 ver_<sha256:16>
  seq: number; // 在流中的全局顺序
  branch: string;
  status: EntityStatus;
  /** 上一版本引用；首版为 null（非缺失引用） */
  predecessorVersionId: string | null;
  content: T;
  contentSummary: string;
  /** 引用的原始字节 blob 哈希列表 */
  blobRefs: string[];
  createdByEventId: string;
}

// ---------------- 派生 / 决定实体 ----------------

export type DerivedEntityKind =
  | 'tiltAxisRule' | 'trackSegmentRule' | 'frameExclusionRule'
  | 'registrationCandidate' | 'adjudication' | 'registrationLock'
  | 'ruleJudgement' | 'interpretationBranch';

/** 倾转轴规则：轴线可偏心，不允许默认固定图像中心 */
export interface TiltAxisRuleContent {
  axisId: string;
  fixedAtImageCenter: boolean;
  /** 轴线与图像 y 轴夹角（内部 radian） */
  phiRad: number;
  /** 轴线与图像中心交点偏移（pixel），free 时由配准估计 */
  centerOffsetXPx: number | null;
  centerOffsetYPx: number | null;
  imageCenterXPx: number;
  imageCenterYPx: number;
  source: 'default_assumed_center' | 'estimated' | 'manual';
}

/** 轨迹段：可断裂；段与 marker 的对应可发生身份交换 */
export interface TrackSegmentContent {
  segmentId: string; // seg_a1
  markerId: string; // 当前解释下的标记身份
  observationIds: string[];
  gapIds: string[];
  /** 身份交换记录：从哪个 marker 交换而来，以及判定依据事件 */
  swappedFromMarkerId?: string;
}

/** 配准候选 */
export interface RegistrationCandidateContent {
  candidateId: string; // cnd_rigid_center / cnd_rigid_free ...
  label: string;
  model: 'rigid' | 'rigid_fixed_axis' | 'local_warp';
  tiltAxisId: string;
  usedSegmentIds: string[];
  /** 有效点集（observationId 排序数组）——不同候选必须用相同有效点集比较 */
  effectiveObservationIds: string[];
  excludedFrameIds: string[];
  droppedObservationIds: string[];
  /** 全部合法候选（多解时非空且大于 1） */
  ambiguity: {
    nonUnique: boolean;
    parameterFamily: string | null;
    equivalentCandidateIds: string[];
  };
  metrics: CandidateMetrics;
  params: CandidateParams;
  perFrameResidual: PerFrameResidual[];
  diagnosticCodes: string[];
  generatedByProbeId?: string;
}

export interface PerFrameResidual {
  frameId: string;
  nPoints: number;
  rmsePx: number;
  maxErrPx: number;
  excluded: boolean;
}

export interface CandidateMetrics {
  /** 在候选自身有效点集上的拟合 RMSE（不得单独用于裁定） */
  fitRmsePx: number;
  /** 共同有效点集 RMSE（公平比较口径） */
  commonSetRmsePx: number;
  /** 公平点集大小 */
  commonSetSize: number;
  coverageFrames: number;
  totalFrames: number;
  /** 被排除帧若纳入的预测残差，用于识别“用少帧换低残差” */
  excludedPredictedRmsePx: number | null;
  overfit: boolean;
  dof: number;
  heldOutRmsePx: number | null;
}

export interface CandidateParams {
  phiRad: number;
  centerOffsetXPx: number | null;
  centerOffsetYPx: number | null;
  frameTransforms: Record<string, { shiftXPx: number; shiftYPx: number; cu: number }>;
  /** local_warp 每点残差松弛量 */
  pointWarp?: Record<string, { dx: number; dy: number }>;
}

/** 人工裁定 */
export interface AdjudicationContent {
  adjudicationId: string;
  decision: 'accepted' | 'rejected';
  candidateId: string;
  reason: string;
  author: string;
  supersedesAdjudicationId?: string;
  revoked: boolean;
}

export interface RegistrationLockContent {
  lockId: string;
  candidateId: string;
  /** 供重建引用的不可变指针：候选版本+依赖版本快照 */
  referenceDigest: string;
  active: boolean;
}

/** 机器可读取的判断依据事件载荷（轴线/轨迹/公平比较规则） */
export interface RuleJudgementContent {
  judgementId: string;
  code:
    | 'AXIS_NOT_CENTER_DEFAULT'
    | 'TRACK_CAN_BREAK_AND_SWAP'
    | 'COMMON_EFFECTIVE_POINT_SET'
    | 'NO_FEWER_FRAMES_LOWER_RESIDUAL'
    | 'KEEP_ALL_LEGAL_CANDIDATES'
    | 'LOCAL_WARP_OVERFIT'
    | 'MISSING_HIGH_TILT_UNINFORMATIVE'
    | 'BAD_FRAME_EXCLUSION'
    | 'CONCURRENT_FREEZE';
  subject: string;
  holds: boolean;
  evidence: Record<string, unknown>;
  relatedCandidateIds: string[];
}

// ---------------- 事件流 ----------------

export type EventType =
  | 'archive.created'
  | 'source.imported'
  | 'source.revised'
  | 'axis.rule_revised'
  | 'track.segment_revised'
  | 'frame.exclusion_changed'
  | 'registration.computed'
  | 'rule.judged'
  | 'ambiguity.resolved_set'
  | 'adjudication.recorded'
  | 'adjudication.revoked'
  | 'registration.locked'
  | 'registration.lock_released'
  | 'branch.created'
  | 'probe.opened'
  | 'probe.closed';

export interface DomainEvent<P = unknown> {
  eventId: string; // evt_<seq:05d>_<hash12>，顺序与身份稳定
  seq: number;
  type: EventType;
  branch: string;
  /** 依赖版本快照：该事件使用的输入/规则版本号，回放到旧事件即恢复当时结论 */
  dependencyRefs: Record<string, string>;
  /** 失效范围键（实体类别/标识），参数或参考版本变化后按依赖关系计算 */
  invalidationScope: string[];
  payload: P;
  author: string;
  atIso: string;
  /** 反例探针归属 */
  probeId?: string;
  /** 该事件由哪个输入片段/规则/决定直接导致，便于反查来源链 */
  provenance: {
    directSourceEventIds: string[];
    importBatchId?: string;
    note?: string;
  };
}

export interface ImportBatch {
  batchId: string;
  kind: 'initial' | 'parameter_revision' | 'local_source_change' | 'conflicting_decision';
  summary: string;
}

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export interface ImportDiagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  path: string;
  quantityRaw?: string | number | null;
}

export interface CorruptionError {
  code: 'CORRUPT_REFERENCE' | 'CORRUPT_BLOB' | 'CORRUPT_ORDER';
  message: string;
  missingRef: string;
  holderEventSeq?: number;
}
