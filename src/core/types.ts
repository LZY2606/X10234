/**
 * 领域词汇数据契约。
 * 不使用通用 name/value：每个实体都显式对应电镜倾转审阅中的领域概念。
 * 所有领域量携带单位或坐标基准；导入层保留原始表示，派生层才规范化。
 */

export type AngleUnit = 'deg' | 'rad' | 'grad';
export type LengthUnit = 'nm' | 'um' | 'angstrom' | 'pixel';
export type DoseUnit = 'e-/A^2' | 'e-/nm^2';

export interface Measure {
  /** 导入时的原始字符串表示，永不丢弃（即使无法转换）。 */
  raw: string;
  /** 规范化后的数值 + 单位；无法转换时 value 为 null 并带诊断。 */
  value: number | null;
  unit: string;
  /** 坐标基准（如 'microscope_stage' / 'image_pixel_frame'），角度可为空。 */
  datum?: string;
  diagnostic?: string;
}

export type EntityKind =
  | 'frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'exposure_dose'
  | 'fiducial_observation'
  | 'tracking_gap'
  | 'manual_exclusion'
  | 'tilt_axis'
  | 'fiducial_track'
  | 'track_identity_swap'
  | 'registration_candidate'
  | 'candidate_residual'
  | 'adjudication'
  | 'registration_lock'
  | 'rule_set'
  | 'study'
  | 'scenario_case';

export type EntityRef = {
  entity_kind: EntityKind;
  entity_id: string;
  version: number;
};

export type SourceType =
  | 'frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'exposure_dose'
  | 'fiducial_observation'
  | 'tracking_gap'
  | 'manual_exclusion';

/** 来源记录：帧 / 倾角 / 像素尺度 / 剂量 / 标记点坐标 / 跟踪缺口 / 手工排除原因，全部版本化。 */
export interface FramePayload {
  frame_index: number;
  acquisition_id: string;
  encoding: 'raw-uint8-monochrome' | 'raw-uint16-monochrome' | 'png-reference';
  width: number;
  height: number;
  blob_id: string;
  /** 原始文件名 / 采集系统路径，用于反查材料。 */
  origin_path: string;
  hash_sha256: string;
}

export interface TiltAnglePayload {
  frame_index: number;
  angle: Measure;
}

export interface PixelScalePayload {
  scope: 'series' | { frame_index: number };
  scale: Measure;
}

export interface ExposureDosePayload {
  frame_index: number;
  dose: Measure;
}

export interface FiducialObservationPayload {
  frame_index: number;
  /** 采集/跟踪软件给出的标签，允许跨版本重贴。 */
  observed_label: string;
  x: number;
  y: number;
  coordinate_frame: 'image_pixel_frame';
  subpixel: boolean;
}

export interface TrackingGapPayload {
  track_id: string;
  first_missing_frame: number;
  last_missing_frame: number;
  reason: string;
}

export interface ManualExclusionPayload {
  target_kind: 'frame' | 'fiducial_observation' | 'track_segment';
  target_ref: { frame_index?: number; track_id?: string; label?: string };
  reason_code: string;
  reason_text: string;
  reviewer: string;
}

/** 解释记录：倾转轴、fiducial 轨迹、身份交换、配准候选、逐帧残差、裁定、锁定。 */
export interface TiltAxisPayload {
  /** 轴线在图像像素坐标系中的点 + 方向角（deg，相对图像 x 轴）。 */
  anchor_x: number;
  anchor_y: number;
  direction_deg: number;
  assumed_centered: boolean;
  center_x: number;
  center_y: number;
  fit_method: string;
  rule_set_version: number;
  /** 是否无法唯一决定：为真时保留全部合法候选，不挑一个。 */
  ambiguous: boolean;
}

export interface FiducialTrackPayload {
  track_id: string;
  /** 连续可见的帧区间；断裂的轨迹由多段表达。 */
  segment_index: number;
  frame_from: number;
  frame_to: number;
  observation_labels: { frame_index: number; label: string }[];
  broken: boolean;
}

export interface TrackIdentitySwapPayload {
  frame_index: number;
  track_a: string;
  track_b: string;
  evidence: string;
  rule_set_version: number;
}

export type TransformModel = 'rigid' | 'local_warp' | 'rigid_with_badframe_exclusion';
export type CandidateStatus =
  | 'valid'
  | 'invalid_unfair_point_set'
  | 'invalid_overfit'
  | 'diagnostic_missing_high_tilt'
  | 'diagnostic_bad_frame'
  | 'diagnostic_axis_offcenter'
  | 'diagnostic_identity_swap'
  | 'ambiguous_multi_solution';

export interface RegistrationCandidatePayload {
  candidate_id: string;
  model: TransformModel;
  rule_set_version: number;
  /** 该候选实际使用的帧序号；公平比较要求候选间使用相同有效点集。 */
  effective_frame_set: number[];
  effective_observation_keys: string[];
  /** 每帧刚体/形变参数（旋转 deg + 平移 px），供叠影视图使用。 */
  per_frame_transform: { frame_index: number; rotation_deg: number; tx: number; ty: number; local_warp?: number[] }[];
  summary_rms_residual_px: number;
  common_set_rms_residual_px: number;
  cv_residual_px: number | null;
  status: CandidateStatus;
  diagnostics: string[];
  excluded_frames: number[];
  parent_candidate_id?: string;
}

export interface CandidateResidualPayload {
  candidate_id: string;
  frame_index: number;
  residual_px: number;
  observations_used: number;
  excluded: boolean;
}

export type Decision = 'accepted' | 'rejected';

export interface AdjudicationPayload {
  candidate_ids: string[];
  decision: Decision;
  reason: string;
  reviewer: string;
  /** 撤销时指向被恢复的前一分支事件。 */
  reverted_event_id?: string;
}

export interface RegistrationLockPayload {
  candidate_id: string;
  purpose: 'reconstruction_reference';
  active: boolean;
  released_event_id?: string;
}

export interface RuleSetPayload {
  rule_set_id: string;
  rules: {
    axis_must_not_assume_center: boolean;
    tracks_may_break_and_swap: boolean;
    compare_on_common_effective_point_set: boolean;
    no_trading_frames_for_lower_residual: boolean;
    keep_all_solutions_when_ambiguous: boolean;
    overfit_penalty_enabled: boolean;
  };
}

export interface StudyPayload {
  study_id: string;
  name: string;
  narrative: string;
}

export interface ScenarioCasePayload {
  case_id: string;
  scenario: ScenarioName;
  kind: 'minimal' | 'combined';
  title: string;
  expected_diagnostic: string;
  expected_invalidation_kind: EntityKind[] | string[];
}

export type ScenarioName =
  | 'axis_offcenter'
  | 'identity_swap'
  | 'missing_high_tilt'
  | 'bad_frame_exclusion'
  | 'local_warp_overfit'
  | 'multi_solution'
  | 'concurrent_freeze';

export type ScenarioStatus =
  | 'replayed'
  | 'adopted'
  | 'not_adopted'
  | 'conflict'
  | 'frozen';

export type EventType =
  | 'source_recorded'
  | 'reinterpretation_branched'
  | 'axis_estimated'
  | 'tracks_segmented'
  | 'identity_swap_detected'
  | 'candidate_proposed'
  | 'candidate_compared'
  | 'adjudication_made'
  | 'adjudication_reverted'
  | 'registration_locked'
  | 'lock_released'
  | 'rule_set_activated'
  | 'invalidated'
  | 'integrity_corrupt'
  | 'conflict_detected'
  | 'scenario_replayed'
  | 'archive_imported'
  | 'archive_exported'
  | 'rollback';

/** 机器可读取的审计事件：判断依据以代码而非散文保存。 */
export interface AuditEvent {
  event_id: string;
  branch_id: string;
  seq: number;
  event_type: EventType;
  /** 本事件写入/指向的实体版本。 */
  subject: EntityRef | null;
  /** 本事件依赖的全部实体版本——缺少引用即损坏，不得退回最新版。 */
  dependencies: EntityRef[];
  /** 机器可读取的判断依据。 */
  rationale_code: string;
  rationale_detail: Record<string, unknown>;
  parent_event_id: string | null;
  author: string;
  created_at: string;
  /** 乐观并发：分支期望前置事件。 */
  expected_parent_event_id?: string | null;
}

export interface BranchState {
  branch_id: string;
  parent_branch_id: string | null;
  name: string;
  head_event_id: string;
  /** 该分支当前可见的每类实体的版本引用，事件重放的投影结果。 */
  visible: Record<string, EntityRef>;
  frozen: boolean;
  created_at: string;
}

export interface EntityRecord {
  entity_kind: EntityKind;
  entity_id: string;
  version: number;
  payload: unknown;
  source_event_id: string;
  branch_id: string;
  content_hash: string;
  created_at: string;
}

export interface BlobRecord {
  blob_id: string;
  sha256: string;
  bytes: Uint8Array;
  media_type: string;
  origin: string;
}

/** 查询任一实体时返回：引用版本号 + 内容摘要。 */
export interface EntityView {
  ref: EntityRef;
  payload: unknown;
  content_hash: string;
  source_event_id: string;
  dependencies: EntityRef[];
  summary: string;
}
