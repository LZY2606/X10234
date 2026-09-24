// 领域词汇表：电子断层 / 倾转序列 / fiducial 配准。
// 不使用 name/value 通用结构，所有量保留原始表示与单位/坐标基准。

export type UID = string;
export type Version = number;

export interface Unit {
  /** 单位符号，如 nm/px、e-/Å^2、deg、px */
  symbol: string;
  /** 坐标基准，如图像像素原点与轴向约定 */
  basis?: string;
}

/** 导入值：原始表示与规范化值分开保存；无法转换时留在原位。 */
export interface Measured<V> {
  value: V | null;
  unit?: Unit;
  /** 导入文件中的原始表示，原样保留 */
  raw: string;
  convertible: boolean;
  diagnosticUid?: UID;
}

export type EntityKind =
  | 'raw_frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'dose'
  | 'fiducial_mark'
  | 'track_gap'
  | 'manual_exclusion'
  | 'rule_set'
  | 'interpretation'
  | 'tilt_axis'
  | 'track_identity'
  | 'effective_point_set'
  | 'registration_candidate'
  | 'candidate_comparison'
  | 'review_decision'
  | 'reconstruction_ref'
  | 'diagnostic';

/** 实体版本内容的判别联合 */
export type EntityContent =
  | RawFrameContent
  | TiltAngleContent
  | PixelScaleContent
  | DoseContent
  | FiducialMarkContent
  | TrackGapContent
  | ManualExclusionContent
  | RuleSetContent
  | InterpretationContent
  | TiltAxisContent
  | TrackIdentityContent
  | EffectivePointSetContent
  | RegistrationCandidateContent
  | CandidateComparisonContent
  | ReviewDecisionContent
  | ReconstructionRefContent
  | DiagnosticContent;

export interface ContentBase {
  kind: EntityKind;
  /** 该版本引用的全部实体（uid + 精确版本），用于来源链与损坏检测 */
  refs?: EntityRef[];
}

export interface EntityRef {
  uid: UID;
  version: Version;
  role: string;
}

export interface RawFrameContent extends ContentBase {
  kind: 'raw_frame';
  acquisitionIndex: number;
  widthPx: number;
  heightPx: number;
  pixelFormat: 'uint8';
  blobUid: UID;
  checksumSha256: string;
  coordinateBasis: string;
  exposureMs?: number;
}

export interface TiltAngleContent extends ContentBase {
  kind: 'tilt_angle';
  frameUid: UID;
  angleDeg: Measured<number>;
}

export interface PixelScaleContent extends ContentBase {
  kind: 'pixel_scale';
  /** 像素尺度可能全序列一致，也可能挂在某一帧上 */
  scope: 'series' | 'frame';
  frameUid?: UID;
  nmPerPx: Measured<number>;
}

export interface DoseContent extends ContentBase {
  kind: 'dose';
  frameUid?: UID;
  cumulative: boolean;
  electronsPerAngstromSq: Measured<number>;
}

export interface FiducialMarkContent extends ContentBase {
  kind: 'fiducial_mark';
  markIndex: number;
  frameUid: UID;
  trackUid: UID;
  xPx: number;
  yPx: number;
}

export interface TrackGapContent extends ContentBase {
  kind: 'track_gap';
  trackUid: UID;
  fromFrameUid: UID;
  toFrameUid: UID;
  reasonRaw: string;
}

export interface ManualExclusionContent extends ContentBase {
  kind: 'manual_exclusion';
  frameUid: UID;
  excluded: boolean;
  reasonRaw: string;
}

export interface RuleSetContent extends ContentBase {
  kind: 'rule_set';
  params: RuleParams;
}

export interface RuleParams {
  /** 坏帧判定：单帧残差超过 RMSE 的倍数 */
  badFrameResidualSigma: number;
  /** 局部形变被认定过拟合时，留出集 RMSE 至少不能比刚体差于此值（px） */
  overfitHeldoutEpsilonPx: number;
  /** 两个候选被视为同样合法（多解）的 RMSE 间隔（px） */
  ambiguityRmseBandPx: number;
  /** 构成有效轨迹所需的最少观测点数 */
  minTrackObservations: number;
  /** 高倾角阈值（deg） */
  highTiltThresholdDeg: number;
}

export const DEFAULT_RULE_PARAMS: RuleParams = {
  badFrameResidualSigma: 2.5,
  overfitHeldoutEpsilonPx: 0.25,
  ambiguityRmseBandPx: 0.5,
  minTrackObservations: 3,
  highTiltThresholdDeg: 55
};

export interface InterpretationContent extends ContentBase {
  kind: 'interpretation';
  label: string;
  frameUids: UID[];
  ruleSetUid: UID;
  scenarioCode?: ScenarioCode;
}

export interface TiltAxisContent extends ContentBase {
  kind: 'tilt_axis';
  interpretationUid: UID;
  /** 面内轴角（deg）。未唯一决定时为 null，候选中保留多解 */
  axisAngleDeg: number | null;
  /** 轴线位置；显式允许偏离图像中心 */
  centerXPx: number | null;
  centerYPx: number | null;
  imageCenterXPx: number;
  imageCenterYPx: number;
  /** true 仅表示“本候选做了中心固定假设”，绝不作为缺省事实 */
  pinnedToImageCenter: boolean;
  offsetFromImageCenterPx: number | null;
}

export interface TrackIdentityContent extends ContentBase {
  kind: 'track_identity';
  interpretationUid: UID;
  trackUid: UID;
  status: 'continuous' | 'broken' | 'identity_swap_hypothesis';
  /** 断裂片段：每段给出帧区间 */
  segments: { fromFrameUid: UID; toFrameUid: UID }[];
  /** 身份交换假设中，与哪条轨迹交换 */
  swapWithTrackUid?: UID;
  legal: boolean;
}

export interface PointSetMember {
  frameUid: UID;
  trackUid: UID;
  markUid: UID;
}

export interface EffectivePointSetContent extends ContentBase {
  kind: 'effective_point_set';
  interpretationUid: UID;
  members: PointSetMember[];
  pointSetHash: string;
  excludedFrameUids: UID[];
  note: string;
}

export type CandidateModel =
  | 'rigid_free_axis'
  | 'rigid_pinned_center'
  | 'rigid_badframe_excluded'
  | 'local_warp'
  | 'identity_swap';

export interface PerFrameResidual {
  frameUid: UID;
  tiltDeg: number | null;
  rmsePx: number;
  observationCount: number;
  excluded: boolean;
}

export interface RegistrationCandidateContent extends ContentBase {
  kind: 'registration_candidate';
  interpretationUid: UID;
  pointSetUid: UID;
  pointSetHash: string;
  model: CandidateModel;
  label: string;
  axisAngleDeg: number | null;
  centerXPx: number | null;
  centerYPx: number | null;
  /** 每帧沿轴漂移（px） */
  perFrameDriftAlongAxisPx: Record<UID, number>;
  perFrameResidual: PerFrameResidual[];
  trainRmsePx: number;
  heldoutRmsePx: number;
  effectiveFrameCount: number;
  excludedFrameUids: UID[];
  legal: boolean;
  resolution: 'unique' | 'ambiguous';
  diagnosticUids: UID[];
}

export interface ComparisonRow {
  candidateUid: UID;
  model: CandidateModel;
  commonSetRmsePx: number;
  heldoutRmsePx: number;
  effectiveFrameCount: number;
  excludedFrameUids: UID[];
  rejectedRuleCodes: string[];
}

export interface CandidateComparisonContent extends ContentBase {
  kind: 'candidate_comparison';
  interpretationUid: UID;
  pointSetHash: string;
  rows: ComparisonRow[];
  /** 共同有效点集上的裁定提示，禁止“用少帧换低残差” */
  fairBasisNote: string;
}

export interface ReviewDecisionContent extends ContentBase {
  kind: 'review_decision';
  candidateUid: UID;
  interpretationUid: UID;
  verdict: 'accepted' | 'rejected';
  rationale: string;
  branchUid: UID;
  /** 撤销时指向撤销事件，不删除历史 */
  undoneByEventSeq?: number;
  supersededByUid?: UID;
}

export interface ReconstructionRefContent extends ContentBase {
  kind: 'reconstruction_ref';
  candidateUid: UID;
  decisionUid: UID;
  branchUid: UID;
  frozenAtEventSeq: number;
  label: string;
}

export interface DiagnosticContent extends ContentBase {
  kind: 'diagnostic';
  code: DiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** 无法转换的原始值留在原位，诊断挂在这里 */
  unconvertibleRaw?: string;
  subjectUid?: UID;
}

export type DiagnosticCode =
  | 'unconvertible_value'
  | 'axis_not_center'
  | 'axis_pinned_assumption'
  | 'track_broken'
  | 'track_identity_swap'
  | 'missing_high_tilt'
  | 'bad_frame_residual'
  | 'local_warp_overfit'
  | 'ambiguous_solution'
  | 'unequal_point_set'
  | 'fewer_frames_lower_residual'
  | 'concurrent_lock_rejected';

export type ScenarioCode =
  | 'axis_eccentric'
  | 'track_identity_swap'
  | 'missing_high_tilt_frames'
  | 'bad_frame_exclusion'
  | 'local_warp_overfit'
  | 'multiple_solutions'
  | 'concurrent_freeze';

export type EventKind =
  | 'raw_imported'
  | 'interpretation_created'
  | 'parameter_revision'
  | 'source_revision_local'
  | 'candidate_created'
  | 'candidate_compared'
  | 'decision_accepted'
  | 'decision_rejected'
  | 'decision_undone'
  | 'reconstruction_locked'
  | 'conflict_detected'
  | 'invalidation_computed'
  | 'import_rollback';

export interface DomainEvent {
  eventUid: UID;
  seq: number;
  atIso: string;
  kind: EventKind;
  branchUid: UID;
  actor: string;
  /** 触发该事件的规则版本（可空，迁移后补齐） */
  ruleVersion?: Version | null;
  entityUid?: UID;
  versionFrom?: Version | null;
  versionTo?: Version | null;
  payload: Record<string, unknown>;
  /** 事件发生时依赖的精确版本快照，回放旧事件时不拿最新结果覆盖 */
  basisRefs: EntityRef[];
}
