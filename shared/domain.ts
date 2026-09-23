// 领域模型：电子断层 / 倾转序列 / 配准审阅
// 所有实体使用领域词汇的一等结构，不压成 name/value。
// 所有领域量携带单位或坐标基准；原始表示在导入层保留，规范化只发生在派生层。

export type SourceKind =
  | 'raw_frames'         // 原始帧
  | 'tilt_angles'        // 倾角
  | 'pixel_scale'        // 像素尺度
  | 'dose'               // 曝光剂量
  | 'marker_coords'      // 标记点坐标（fiducial 轨迹）
  | 'tracking_gaps'      // 跟踪缺口
  | 'exclusion_reasons'; // 手工排除原因

export const SOURCE_KINDS: SourceKind[] = [
  'raw_frames', 'tilt_angles', 'pixel_scale', 'dose',
  'marker_coords', 'tracking_gaps', 'exclusion_reasons',
];

export type Scheme = 'rigid' | 'local_deform' | 'exclude_bad_frames';

export interface Unit {
  quantity: string;      // 'angle' | 'length' | 'dose' | 'pixel_scale' | 'count'
  unit: string;          // 'deg' | 'nm' | 'px' | 'nm/px' | 'A/px' | 'e-/A^2' | ...
  coordFrame?: string;   // 'image_px_topleft' | 'specimen_nm' | ...
}

export interface Diagnostic {
  code: string;          // 机器可读诊断码，如 'unit_unconvertible'
  message: string;
  at?: string;           // 出问题的位置（留在原位置，不丢弃）
  severity: 'info' | 'warn' | 'error';
}

// ---- 原始帧 ----
export interface RawFrame {
  frameId: string;             // 'f000'
  tiltDeg: number;             // 原始倾角读数（deg）
  doseEPerA2: number;          // 本帧剂量
  file: string;                // 原始文件名（来源关系）
  detector: { widthPx: number; heightPx: number };
}
export interface RawFramesPayload { frames: RawFrame[]; }

// ---- 倾角 ----
export interface TiltAnglesPayload {
  angles: { frameId: string; tiltDeg: number }[];
  axisAngleDeg: number;        // 倾转轴在图像平面内的取向
}

// ---- 像素尺度 ----
export interface PixelScalePayload { value: number; unit: 'nm/px' | 'A/px'; }

// ---- 剂量 ----
export interface DosePayload {
  perFrame: { frameId: string; doseEPerA2: number }[];
  cumulativeEPerA2: number;
}

// ---- 标记点坐标（fiducial 轨迹）----
export interface FiducialPoint { frameId: string; xPx: number; yPx: number; }
export interface FiducialTrajectory {
  trajectoryId: string;        // 'fid01'
  points: FiducialPoint[];     // 可断裂：缺帧即断点
}
export interface MarkerCoordsPayload {
  coordFrame: 'image_px_topleft';
  trajectories: FiducialTrajectory[];
}

// ---- 跟踪缺口 ----
export interface TrackingGap {
  trajectoryId: string;
  fromFrame: string;
  toFrame: string;
  cause: string;
}
export interface TrackingGapsPayload { gaps: TrackingGap[]; }

// ---- 手工排除原因 ----
export interface ExclusionReason { frameId: string; reason: string; decidedBy: string; }
export interface ExclusionReasonsPayload { exclusions: ExclusionReason[]; }

export type SourcePayload =
  | RawFramesPayload | TiltAnglesPayload | PixelScalePayload | DosePayload
  | MarkerCoordsPayload | TrackingGapsPayload | ExclusionReasonsPayload;

// ---- 配准参数（倾转轴绝不默认固定在图像中心）----
export interface AlignmentParams {
  axisOffsetXPx: number;       // 轴线相对图像中心的偏移（px），显式参数
  axisOffsetYPx: number;
  axisAngleDeg: number;
  magnification: number;
}

// ---- 版本化源实体 ----
export interface SourceVersion {
  id: string;                  // 稳定身份，如 'src.tilt_angles.v2'
  kind: SourceKind;
  version: number;
  blobHash: string;            // 不可变内容寻址
  unit: Unit;
  supersedes: string | null;
  note: string;
  createdAt: string;
}

// ---- 解释（把来源版本钉在一起的一次解读）----
export interface Interpretation {
  id: string;                  // 'interp.main.v1'
  branch: string;
  version: number;
  pins: Record<SourceKind, string>;   // 显式钉住版本号，禁止退回“最新版”
  params: AlignmentParams;
  derivedFrom: string | null;
  createdAt: string;
}

// ---- 配准候选 ----
export interface FrameResidual { frameId: string; rmseNm: number; used: boolean; }
export interface Candidate {
  id: string;                  // 'cand.main.rigid.v1'
  interpretationId: string;
  scheme: Scheme;
  effectivePointSet: string[]; // 有效点集：比较时所有候选必须一致
  framesUsed: string[];
  perFrameResiduals: FrameResidual[];
  comparisonRmseNm: number;    // 在共享有效点集 + 共享帧集上计算
  dof: number;
  diagnostics: Diagnostic[];
  status: 'open' | 'adopted' | 'rejected';
  createdAt: string;
}

// ---- 裁定 / 事件（机器可读取的判断依据）----
export type EventType =
  | 'import'            // 导入基线
  | 'source_revision'   // 源数据改动（只改一个直接来源）
  | 'param_revision'    // 参数修订
  | 'reinterpret'       // 重新解释 → 新分支
  | 'adjudicate'        // 人工裁定（接受/否定）
  | 'undo'              // 撤销裁定，恢复前一分支
  | 'restore'           // 回到旧事件：恢复当时依赖版本与可见结论
  | 'lock'              // 锁定一版配准供重建引用
  | 'unlock'
  | 'freeze';           // 并发冻结：分支锁定后拒绝写入

export interface JudgmentBasis {
  ruleRefs: string[];          // 机器可读规则引用
  comparisonBasis?: {
    effectivePointSetDigest: string;
    framesCompared: string[];
    note: string;              // 如 “不同候选用相同有效点集比较，不用少帧换低残差”
  };
  scenario?: string;           // 反例场景标识
}

export interface AppEvent {
  id: string;                  // 'evt.000001'
  seq: number;
  branch: string;
  type: EventType;
  parent: string | null;       // 前一事件
  baseHead: string | null;     // 提交者看到的 head（并发检测）
  actor: string;
  summary: string;
  judgment: JudgmentBasis | null;
  resulting: BranchSnapshot;   // 事件完成后的可见状态（用于恢复历史）
  invalidated: string[];       // 本次变更的失效范围
  createdAt: string;
}

export interface BranchSnapshot {
  interpretationId: string | null;
  candidateStatus: Record<string, 'open' | 'adopted' | 'rejected'>;
  lockedCandidateId: string | null;
}

export interface Branch {
  name: string;
  headEventId: string | null;
  frozen: boolean;             // 冻结后拒绝新写入（并发冻结检验）
}

export interface AlignmentLock {
  id: string;                  // 'lock.main.v1'
  branch: string;
  candidateId: string;
  interpretationId: string;
  createdAt: string;
}

// ---- 查询返回：实体 + 引用版本号 + 内容摘要 ----
export interface EntityView {
  id: string;
  table: string;
  entity: unknown;
  refs: { role: string; id: string; digest: string | null }[];
  digest: string;
  corrupt?: { missing: string[] };
}

export interface ConflictInfo {
  conflict: true;
  branch: string;
  baseHead: string | null;
  currentHead: string | null;
  theirEvents: { id: string; summary: string; actor: string }[]; // 对方先提交的事件
  yourChange: string;                                            // 你试图提交的变更
}

export const RULES = {
  AXIS_NOT_CENTERED: 'rule.axis_not_fixed_at_image_center',
  TRAJECTORY_BREAK_SWAP: 'rule.trajectory_may_break_and_identity_swap',
  SAME_EFFECTIVE_SET: 'rule.same_effective_point_set_for_comparison',
  NO_FEWER_FRAMES_FOR_RESIDUAL: 'rule.no_fewer_frames_for_lower_residual',
} as const;

export const SCENARIOS = [
  'axis_eccentric',            // 轴线偏心
  'trajectory_identity_swap',  // 轨迹身份交换
  'missing_high_tilt_frames',  // 缺失高倾角帧
  'bad_frame_exclusion',       // 坏帧排除
  'local_deform_overfit',      // 局部形变过拟合
  'multiple_solutions',        // 多解
  'concurrent_freeze',         // 并发冻结
] as const;
export type Scenario = typeof SCENARIOS[number];
