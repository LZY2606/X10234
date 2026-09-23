// 领域数据契约：电子断层 / 倾转序列 / fiducial 配准审阅
// 原则：来源(source)与解释(interpretation)分离；来源不可变；所有领域量携带单位或坐标基准。

export type Unit = 'degree' | 'radian' | 'nm' | 'um' | 'nm_per_pixel' | 'e_per_nm2' | 'counts' | 'frame_index' | 'pixel';
export type CoordBasis = 'image_pixel_top_left' | 'stage_degree' | 'detector_pixel';

export interface DomainValue<T = number | string> {
  raw: T;                 // 导入时保留的原始表示
  rawUnit?: string;       // 原始单位（自由文本，例如 'deg' / 'e/A^2'）
  unit?: Unit;            // 规范化单位（派生层使用）
  basis?: CoordBasis;     // 坐标基准
  converted?: T;          // 派生层规范化后的值
  conversionDiagnostic?: string; // 无法转换时留在原位置并附诊断
}

// ---------- 来源实体（不可变、版本化、内容寻址） ----------

export interface FrameSource {
  kind: 'frame';
  frameIndex: number;
  blobId: string;             // 指向 frames blob（共享原始片段）
  width: number;
  height: number;
  encoding: 'P5_PGM' | 'SYNTH_PGM';
  pixelValueRange: [number, number];
  acquiredAt?: string;
  note?: string;
}

export interface TiltAngleSource {
  kind: 'tiltAngle';
  frameIndex: number;
  angle: DomainValue<number>; // 原始单位保留（degree/radian）
  direction: 'neg_to_pos' | 'pos_to_neg' | 'unknown';
}

export interface PixelScaleSource {
  kind: 'pixelScale';
  scope: 'global' | number;    // global 或某帧 index
  scale: DomainValue<number>;  // 例如 0.54 nm/px
}

export interface DoseSource {
  kind: 'dose';
  frameIndex: number;
  dose: DomainValue<number>;   // 例如 e/A^2 -> e/nm^2
}

export interface MarkerCoordSource {
  kind: 'markerCoord';
  trackLabel: string;          // 文件内给出的标记标签（可能在交换场景中错误）
  frameIndex: number;
  x: DomainValue<number>;
  y: DomainValue<number>;
  observed: boolean;
}

export interface TrackGapSource {
  kind: 'trackGap';
  trackLabel: string;
  fromFrameIndex: number;
  toFrameIndex: number;       // 缺口区间（不含端点之间观测）
  reasonRaw?: string;
  classification?: 'occlusion' | 'out_of_field' | 'tracking_failure' | 'identity_swap' | 'unclassified';
}

export interface ManualExclusionSource {
  kind: 'manualExclusion';
  frameIndex: number;
  reason: string;             // 手工排除原因（原文）
  reasonCode: 'too_much_drift' | 'motion_blur' | 'bad_tracking' | 'excessive_dose' | 'other';
  decidedBy?: string;
}

export type SourceEntity =
  | FrameSource | TiltAngleSource | PixelScaleSource | DoseSource
  | MarkerCoordSource | TrackGapSource | ManualExclusionSource;

// ---------- 解释 / 规则实体（独立版本化） ----------

export interface AlignmentRuleSet {
  kind: 'ruleSet';
  name: string;
  axisPolicy: 'estimate' | 'fixed_center';   // 倾转轴是否允许偏离图像中心
  initialAxisAngleDeg: number;
  model: 'rigid' | 'local_warp';
  warpGrid?: number;                         // local_warp 网格
  crossValidateWarp?: boolean;
  identitySwapPolicy: 'single_assignment' | 'enumerate';
  minValidFrames: number;
  badFrameSigma: number;                     // MAD 倍数阈值
  tieThreshold: number;                      // 多解判定阈值（残差）
  notes?: string;
}

export interface TrackInterpretation {
  kind: 'trackInterpretation';
  physicalTrackId: string;
  segments: Array<{
    sourceTrackLabel: string;
    frameRange: [number, number];
  }>;
  swapEdges: Array<{ frameIndex: number; labelA: string; labelB: string }>;
  gaps: Array<{ fromFrameIndex: number; toFrameIndex: number; classification: string }>;
  diagnostic?: string;
}

export interface FrameValidity {
  kind: 'frameValidity';
  validFrames: number[];
  excludedFrames: Array<{ frameIndex: number; reason: string; origin: 'manual' | 'auto_suggestion' }>;
}

export type InterpretationEntity = AlignmentRuleSet | TrackInterpretation | FrameValidity;

// ---------- 配准候选（派生结果） ----------

export interface AxisEstimate {
  angleDeg: number;
  point: { x: number; y: number };   // 轴线上一点（图像像素坐标）
  offsetFromCenterPx: number;        // 轴线偏心（像素）
  diagnostic?: string;
}

export interface FrameResidual {
  frameIndex: number;
  residualPx: number;
  valid: boolean;
  excludedReason?: string;
}

export interface AlignmentCandidate {
  kind: 'candidate';
  candidateId: string;
  model: 'rigid' | 'local_warp';
  axis: AxisEstimate;
  validFrames: number[];
  perFrameResidual: FrameResidual[];
  rmsResidualPx: number;
  coverage: number;                 // 有效帧占比
  robustScore: number;              // 覆盖率惩罚后的比较分（不用少帧换低残差）
  crossValidatedRms?: number;       // local_warp 留出帧 RMS
  overfit?: boolean;
  degeneracy: 'unique' | 'multi';   // 多解：轴方向 180° 等价等
  ambiguityReason?: string;
  comparisonNote?: string;
}

export type DecisionVerb = 'accept' | 'reject' | 'adjust_params' | 'reopen';

// ---------- 版本引用与内容摘要 ----------

export interface VersionRef {
  objectId: string;
  version: number;
  digest: string;
  kind: string;
}

export interface EntitySummary {
  objectId: string;
  version: number;
  kind: string;
  digest: string;
  content: SourceEntity | InterpretationEntity | AlignmentCandidate | Record<string, unknown>;
  refs: VersionRef[];
  createdAt: string;
}

// ---------- 机器可读取的事件（判断依据） ----------

export type EventType =
  | 'source.imported'
  | 'source.reinterpreted'
  | 'ruleset.revised'
  | 'rule.source.local_change'
  | 'track.break_detected'
  | 'track.identity_swap_detected'
  | 'frame.missing_high_tilt'
  | 'frame.bad_excluded'
  | 'warp.overfit_detected'
  | 'candidate.generated'
  | 'candidate.multi_solution'
  | 'comparison.same_valid_set_required'
  | 'comparison.frame_count_penalty'
  | 'axis.offcenter_result'
  | 'axis.fixed_center_rejected'
  | 'decision.accepted'
  | 'decision.rejected'
  | 'decision.param_adjusted'
  | 'decision.reopened'
  | 'decision.conflicted'
  | 'branch.created'
  | 'branch.frozen'
  | 'dependency.invalidated'
  | 'archive.adopted'
  | 'archive.not_adopted'
  | 'import.rolled_back'
  | 'archive.exported'
  | 'archive.imported'
  | 'archive.corrupt_missing_ref'
  | 'review.view_selected'
  | 'review.candidate_switched';

export interface DomainEvent {
  eventId: string;
  seq: number;
  branchId: string;
  parentEventId: string | null;
  type: EventType;
  at: string;
  actor: string;
  rationaleCode: string;           // 机器可读判断依据代码
  rationale: string;               // 人类可读说明
  affectedObjectIds: string[];
  refs: VersionRef[];              // 该事件引用的确定版本
  payload?: Record<string, unknown>;
}
