/**
 * 领域词汇表 —— 倾转帧拼合室。
 *
 * 这里不使用通用的 name/value 压平结构，而是直接采用电子断层小组的语言：
 * 原始帧(rawFrame)、倾转角(tiltAngle)、像素尺度(pixelScale)、曝光剂量(dose)、
 * 标记点坐标(fiducialCoordinate)、跟踪缺口(trackingGap)、手工排除原因(manualExclusion)。
 *
 * 所有领域量都携带单位或坐标基准；导入层只保留原始表示，规范化只发生在派生层。
 */

export type Units =
  | 'pixel'
  | 'nm/pixel'
  | 'degree'
  | 'radian'
  | 'e-/A^2'
  | 'gray8'
  | 'fraction'
  | 'unitless';

export type CoordinateFrame =
  | 'image-pixel'
  | 'microscope-stage'
  | 'frame-local'
  | 'normalized';

/** 带单位/基准的量；raw 保存导入时的原始表示，转换失败时不丢弃。 */
export interface Quantity {
  value: number;
  units: Units;
  /** 原始文本表示，导入时原样保留。 */
  raw?: string;
  basis?: CoordinateFrame;
  /** 派生规范化结果；无法转换时为空并附诊断。 */
  normalized?: { value: number; units: Units };
}

export type EntityKind =
  | 'rawFrame'
  | 'tiltAngle'
  | 'tiltSeries'
  | 'pixelScale'
  | 'dose'
  | 'fiducialMark'
  | 'fiducialTrack'
  | 'trackingGap'
  | 'manualExclusion'
  | 'tiltAxis'
  | 'parameterSet'
  | 'registrationCandidate'
  | 'candidateDecision'
  | 'scenarioCase'
  | 'inputFragment'
  | 'diagnosticEvent'
  | 'lock';

export interface HasStableIdentity {
  /** 全库稳定身份；导出→删库→导入后保持不变。 */
  id: string;
  kind: EntityKind;
  version: number;
  branchId: string;
}

export interface RawFramePayload {
  indexInSeries: number;
  width: number;
  height: number;
  blobHash: string;
  intensity: Quantity;
  acquisitionLabel: string;
}

export interface TiltAnglePayload {
  frameId: string;
  angle: Quantity;
}

export interface PixelScalePayload {
  scale: Quantity;
  microscopeCalibrationId?: string;
}

export interface DosePayload {
  frameId: string;
  exposureDose: Quantity;
  cumulativeDose: Quantity;
}

export interface FiducialMarkPayload {
  trackId: string;
  frameId: string;
  x: Quantity;
  y: Quantity;
  observedAt?: string;
}

/**
 * fiducial 轨迹可断裂且可能身份交换：轨迹是段(segment)的集合，
 * segment 之间允许有跟踪缺口(trackingGap)；不同 trackId 之间允许记录疑似身份交换。
 */
export interface FiducialTrackPayload {
  trackId: string;
  segmentIds: string[];
  suspectedSwap?: { otherTrackId: string; frameId: string; reason: string };
}

export interface TrackingGapPayload {
  trackId: string;
  fromFrameId: string;
  toFrameId: string;
  reason: 'occluded' | 'left-field' | 'tracking-lost' | 'manual';
}

export interface ManualExclusionPayload {
  frameId: string;
  reason: string;
  reviewer: string;
}

/**
 * 倾转轴。axisOffsetPx 显式表达相对图像中心的偏心；
 * `fixedAtImageCenter` 仅在显式证实时为 true，绝不默认。
 */
export interface TiltAxisPayload {
  angleDeg: Quantity;
  axisOffsetX: Quantity;
  axisOffsetY: Quantity;
  fixedAtImageCenter: boolean;
  evidence: string;
}

export interface ParameterSetPayload {
  rigidOnly: boolean;
  allowLocalWarp: boolean;
  localWarpGrid: number;
  regularizer: number;
  minFractionOfFrames: number;
  basedOnParameterVersion?: string;
  notes: string;
}

export interface FrameResidual {
  frameId: string;
  residualPx: number;
  usedInFit: boolean;
  excludedReason?: string;
}

export type RegistrationKind = 'rigid' | 'local-warp' | 'rigid-exclude-bad';

export interface RegistrationCandidatePayload {
  label: string;
  kind: RegistrationKind;
  parameterSetId: string;
  /** 参与比较的有效帧集合（身份），不同候选必须用同一集合才能直接比较。 */
  effectiveFrameIds: string[];
  excludedFrameIds: string[];
  transforms: Record<string, { tx: number; ty: number; angleDeg: number; localGrid?: number[] }>;
  residuals: FrameResidual[];
  rmsResidualPx: number;
  maxResidualPx: number;
  /** 是否与比较集合同宽；false 表示“用少帧换低残差”。 */
  sameEffectiveSet: boolean;
  comparableRmsPx?: number;
  overfitWarning?: string;
  ambiguous?: string[];
  axisUsedId: string;
}

export type Decision = 'accepted' | 'rejected' | 'superseded';

export interface CandidateDecisionPayload {
  candidateId: string;
  decision: Decision;
  reviewer: string;
  rationale: string;
  supersededDecisionId?: string;
}

export type ScenarioKey =
  | 'axis-offset'
  | 'track-identity-swap'
  | 'missing-high-tilt'
  | 'bad-frame-exclusion'
  | 'local-warp-overfit'
  | 'multi-solution'
  | 'concurrent-freeze';

export interface InputFragmentPayload {
  scenarioKey: ScenarioKey;
  mode: 'minimal' | 'combined';
  sharedFragmentHash: string;
  /** 引用的不可变内容（blob / 实体版本引用）。 */
  contentRefs: string[];
  interpretationVersion: number;
  interpretationNotes: string;
}

export type DiagnosticStatus = 'raised' | 'bounded' | 'failed' | 'resolved';

export interface DiagnosticEventPayload {
  scenarioKey: ScenarioKey;
  status: DiagnosticStatus;
  title: string;
  detail: string;
  /** 机器可读的判断依据。 */
  ruleCode: RuleCode;
  affectedRefs: string[];
  expectedScopeRefs: string[];
  actualScopeRefs: string[];
  scopeLimitedCorrectly: boolean;
}

export type RuleCode =
  | 'AXIS_NOT_CENTER_DEFAULT'
  | 'TRACK_CAN_BREAK_OR_SWAP'
  | 'SAME_EFFECTIVE_POINT_SET'
  | 'NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL'
  | 'KEEP_ALL_EQUIPOLLENT_CANDIDATES'
  | 'CONFLICT_FREEZE_REQUIRED'
  | 'DONT_GLOBAL_REPLACE_STALE';

export type EntityPayloadMap = {
  rawFrame: RawFramePayload;
  tiltAngle: TiltAnglePayload;
  tiltSeries: { frameIds: string[]; pixelScaleId: string; axisId: string };
  pixelScale: PixelScalePayload;
  dose: DosePayload;
  fiducialMark: FiducialMarkPayload;
  fiducialTrack: FiducialTrackPayload;
  trackingGap: TrackingGapPayload;
  manualExclusion: ManualExclusionPayload;
  tiltAxis: TiltAxisPayload;
  parameterSet: ParameterSetPayload;
  registrationCandidate: RegistrationCandidatePayload;
  candidateDecision: CandidateDecisionPayload;
  scenarioCase: { key: ScenarioKey; minimalFragmentId: string; combinedFragmentId: string; status: string };
  inputFragment: InputFragmentPayload;
  diagnosticEvent: DiagnosticEventPayload;
  lock: { candidateId: string; decisionId: string };
};

export type AnyEntityPayload = EntityPayloadMap[EntityKind];

export interface VersionedEntity<K extends EntityKind = EntityKind> {
  id: string;
  kind: K;
  version: number;
  branchId: string;
  payload: EntityPayloadMap[K];
  /** 内容摘要（canonical JSON 的 sha256 前 12 位）。 */
  contentDigest: string;
  /** 该版本直接引用的精确版本引用，形如 kind:id@version。 */
  refs: string[];
  /** 依赖来源层级：source=不可变原始，interpretation=解释/修订，derived=派生。 */
  layer: 'source' | 'interpretation' | 'derived';
  createdAt: number;
}

export interface DomainEvent {
  seq: number;
  type:
    | 'import-committed'
    | 'branch-created'
    | 'parameter-revised'
    | 'candidate-computed'
    | 'decision-made'
    | 'decision-undone'
    | 'candidate-locked'
    | 'diagnostic-raised'
    | 'scope-checked'
    | 'conflict-frozen'
    | 'case-replayed'
    | 'rollback';
  branchId: string;
  entityRef?: string;
  payload: Record<string, unknown>;
  at: number;
}

/** 界面上每个显示值都要带稳定身份与精确版本引用。 */
export interface DisplayValue<T = string> {
  id: string;
  ref: string;
  version: number;
  label: string;
  value: T;
  units?: string;
}
