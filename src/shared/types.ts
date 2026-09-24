/**
 * 倾转帧拼合室 —— 领域数据契约
 *
 * 直接使用电子断层领域词汇：tilt series、frame、tilt angle、pixel scale、
 * dose、fiducial marker、trajectory segment、gap、exclusion、tilt axis、
 * registration candidate …… 不压成 name/value。
 *
 * 所有量（quantity）携带单位或坐标基准；导入时保留原始表示（raw），
 * 派生层才规范化；无法转换的值留在原位置并附诊断（diagnostics）。
 */

export type EntityKind =
  | 'tilt_series'
  | 'frame_record'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'dose_record'
  | 'marker'
  | 'track_segment'
  | 'track_gap'
  | 'exclusion_record'
  | 'interpretation'
  | 'tilt_axis'
  | 'registration_candidate'
  | 'review_decision'
  | 'reconstruction_lock'
  | 'case_narrative'
  | 'counterexample';

export type RefKind = EntityKind | 'blob';

/** 稳定身份：形如 frame_record:01HXY... 的全库稳定 ID，不随行号/导入顺序变化 */
export type StableId = string;

/** 带单位/坐标基准的领域量：保留原始表示，派生层才规范化 */
export interface DomainQuantity {
  /** 导入时的原始表示（字符串原样保留，不做不可逆清洗） */
  raw: string;
  /** 规范化后的数值；无法转换时为 null 且 diagnostics 给出原因 */
  value: number | null;
  /** 单位（如 degree / nm_per_pixel / electrons_per_angstrom_squared / pixel） */
  unit: string;
  /** 无法转换等问题诊断；空数组表示干净 */
  diagnostics?: string[];
}

export interface CoordinateBasis {
  /** 坐标基准：原始像素坐标（左上原点）或物理坐标等 */
  name: 'image_pixel_topleft' | 'specimen_physical';
  origin: 'top_left' | 'specimen';
  unit: 'pixel' | 'nm';
}

/** 版本引用：必须带版本号；缺少引用/版本号即损坏，不能退回最新版 */
export interface VersionRef {
  kind: RefKind;
  id: StableId;
  version: number;
  /** 内容摘要（sha256 前缀），读回时可校验 */
  digest?: string;
}

export interface PointObservation {
  frame: VersionRef;
  x: DomainQuantity;
  y: DomainQuantity;
  basis: CoordinateBasis;
}

export interface TiltSeriesV {
  series_id: string;
  microscope: string;
  notes?: string;
  /** 该版本包含的帧顺序（稳定引用的有序列表，顺序也是数据） */
  frame_order: VersionRef[];
}

export interface FrameRecordV {
  series: VersionRef;
  index: number;
  blob: VersionRef;
  width: number;
  height: number;
  encoding: 'pgm_fixture_u8';
  acquired_at: string;
}

export interface TiltAngleV {
  frame: VersionRef;
  angle: DomainQuantity; // degree
}

export interface PixelScaleV {
  frame: VersionRef;
  scale: DomainQuantity; // nm/pixel
}

export interface DoseRecordV {
  frame: VersionRef;
  dose: DomainQuantity; // e-/Å^2
  cumulative: DomainQuantity | null;
}

export interface MarkerV {
  series: VersionRef;
  /** 电镜小组给的 fiducial 标签（可能与稳定 ID 不同；身份交换时保留原标签） */
  label: string;
  diameter_nm: number | null;
}

/** 一条可断裂的轨迹段；同一 marker 可有多个 segment，segment 间为 gap */
export interface TrackSegmentV {
  marker: VersionRef;
  segment_index: number;
  observations: PointObservation[];
}

export interface TrackGapV {
  marker: VersionRef;
  after_segment: number;
  before_segment: number;
  missing_frames: VersionRef[];
  reason: DomainQuantity; // 例如 occluded / out_of_field / untracked
}

export interface ExclusionRecordV {
  frame: VersionRef;
  excluded: boolean;
  reason: DomainQuantity; // 手工排除原因（原文保留）
  author: string;
}

/**
 * 解释层：同一份材料可被重新解释 -> 新建分支版本；
 * 引用的全部是带版本号的源实体。
 */
export interface InterpretationV {
  series: VersionRef;
  parent_interpretation: VersionRef | null;
  parameter_revision: number;
  rule_set_version: string;
  /** 本解释采纳的有效帧集合（坏帧排除在此体现） */
  active_frames: VersionRef[];
  /** 轨迹身份映射：segment -> marker，允许与源标签不同（身份交换裁定） */
  identity_assignments: Array<{ segment: VersionRef; marker: VersionRef; confidence: number }>;
  notes?: string;
}

/**
 * 倾转轴：绝不能默认固定在图像中心。
 * 以轴上一点 + 方向表示；point_xy 为像素坐标（显式给出，含偏心）。
 */
export interface TiltAxisV {
  interpretation: VersionRef;
  point_xy: { x: DomainQuantity; y: DomainQuantity; basis: CoordinateBasis };
  direction_deg: DomainQuantity; // 轴方向角（度）
  offset_from_center: DomainQuantity; // 距图像中心的垂直距离（像素），诊断量
  assumed_center?: boolean; // true 仅在明确诊断“被错误默认到中心”时出现
}

export type CandidateKind = 'rigid' | 'local_deformation' | 'bad_frame_excluded';

export interface PerFrameResidual {
  frame: VersionRef;
  residual_px: number;
  n_points: number;
}

export interface RegistrationCandidateV {
  interpretation: VersionRef;
  axis: VersionRef;
  kind: CandidateKind;
  /** 本候选使用的有效点（frame×segment 观测），候选间必须用相同有效点集比较 */
  effective_set_digest: string;
  effective_frame_refs: VersionRef[];
  params: {
    direction_deg: number;
    offset_px: number;
    /** local_deformation 才有：每帧平移自由度 */
    per_frame_shift?: Record<string, { dx: number; dy: number }>;
  };
  rms_residual_px: number;
  max_residual_px: number;
  per_frame: PerFrameResidual[];
  /** 留一标记交叉验证误差：局部形变过拟合诊断 */
  leave_one_marker_out_rms_px: number | null;
  diagnostics: CandidateDiagnostic[];
  /** 多解：全部在容差内的局部极小解（方向角模 180） */
  alternate_solutions?: Array<{ direction_deg: number; rms_residual_px: number }>;
}

export type CandidateDiagnosticCode =
  | 'AXIS_OFF_CENTER'
  | 'IDENTITY_SWAP_SUSPECTED'
  | 'MISSING_HIGH_TILT_FRAME'
  | 'BAD_FRAME_EXCLUDED'
  | 'LOCAL_OVERFIT'
  | 'MULTIPLE_SOLUTIONS'
  | 'FEWER_FRAMES_LOWER_RESIDUAL_REJECTED'
  | 'CONCURRENT_FREEZE_DETECTED';

export interface CandidateDiagnostic {
  code: CandidateDiagnosticCode;
  message: string;
  evidence: Record<string, string | number | boolean>;
}

export interface ReviewDecisionV {
  candidate: VersionRef;
  interpretation: VersionRef;
  action: 'accept' | 'reject' | 'parameter_adjust';
  author: string;
  rationale: string;
  parent_decision: VersionRef | null;
  /** 撤销：revoked_by 指向撤销事件产生的新决定；任一裁定可撤销并恢复前一分支 */
  revoked_by: VersionRef | null;
}

export interface ReconstructionLockV {
  candidate: VersionRef;
  interpretation: VersionRef;
  locked_by: string;
  note: string;
}

export interface CaseNarrativeV {
  title: string;
  steps: string[];
}

export interface CounterexampleV {
  scenario: ScenarioCode;
  variant: 'minimal' | 'combined';
  /** 该反例引用的不可变原始片段（组合与最小共享同一 blob 内容） */
  shared_blob_refs: VersionRef[];
  interpretation: VersionRef;
  independent_diagnostics: CandidateDiagnostic[];
  human_decisions: VersionRef[];
  adopted: boolean; // 同时保留被采纳和未采纳的结果
  expected_invalidation_scope: VersionRef[];
}

export type ScenarioCode =
  | 'axis_off_center'
  | 'identity_swap'
  | 'missing_high_tilt'
  | 'bad_frame_exclusion'
  | 'local_overfit'
  | 'multiple_solutions'
  | 'concurrent_freeze';

/** 版本化实体统一外壳 */
export interface EntityRecord<T = unknown> {
  id: StableId;
  kind: EntityKind;
  version: number;
  /** 本行版本的内容摘要 */
  digest: string;
  /** 该行版本引用的全部带版本号实体（含 blob） */
  refs: VersionRef[];
  created_at: string;
  branch_id: string;
  payload: T;
  superseded_by: StableId | null;
}

/** 机器可读取的事件（裁定依据/反例判定依据） */
export interface DomainEvent {
  event_id: StableId;
  seq: number;
  type: string;
  at: string;
  branch_id: string;
  actor: string;
  payload: Record<string, unknown>;
  /** 事件发生时引用的依赖版本快照（回到旧事件时恢复当时版本，而非最新） */
  dependency_snapshot: VersionRef[];
  related_entities: VersionRef[];
}

export interface WorkspaceInfo {
  id: StableId;
  name: string;
  head_event_seq: number;
}
