/**
 * 数据契约：电子断层 / 倾转序列 / 配准审阅。
 * 直接使用领域词汇建模，不压成 name/value。
 * 所有领域量都携带单位或坐标基准；原始表示不可变，派生层才做规范化。
 */

// ---------- 输入实体（原始层，全部版本化） ----------

export interface RawFrame {
  frameId: string;
  file: string;
  sha256: string;
  sizeBytes: number;
}

export interface TiltAngle {
  frameId: string;
  angleDeg: number;
  axisConvention: 'tilt-axis-vertical-in-image';
}

export interface PixelSize {
  value: number;
  unit: 'nm/px' | 'A/px';
}

export interface FrameDose {
  frameId: string;
  /** 原始表示：导入时保留，派生层才规范化为 e-/A^2 */
  dose: number | string;
  unit: string;
}

export interface FiducialObservation {
  trackId: string;
  frameId: string;
  x: number;
  y: number;
  coordOrigin: 'image-center' | 'image-top-left';
  unit: 'px';
}

export interface TrackingGap {
  trackId: string;
  fromFrame: string;
  toFrame: string;
  cause: string;
}

export interface ManualExclusion {
  frameId: string;
  reason: string;
  decidedBy: string;
}

/** 输入实体：倾转序列（原始帧 + 倾角 + 像素尺度 + 剂量） */
export interface TiltSeriesContent {
  rawFrames: RawFrame[];
  tiltAngles: TiltAngle[];
  pixelSize: PixelSize;
  doses: FrameDose[];
}

/** 输入实体：fiducial 点轨迹（坐标 + 跟踪缺口 + 手工排除原因） */
export interface FiducialTrackSetContent {
  observations: FiducialObservation[];
  trackingGaps: TrackingGap[];
  manualExclusions: ManualExclusion[];
}

// ---------- 决定实体（推导到结论的规则） ----------

export interface AlignmentParamsContent {
  axisRegularization: number;
  maxIterations: number;
  /** 决定实体：倾转轴不能被默认固定在图像中心 */
  tiltAxisFixedAtImageCenter: false;
  /** 决定实体：fiducial 轨迹可断裂且可能身份交换 */
  tracksMayBreakAndSwap: true;
  /** 决定实体：不同候选用相同有效点集比较，不用少帧换低残差 */
  compareOnCommonEffectivePointSet: true;
}

export interface TiltAxisFitContent {
  offsetPx: number;
  angleDeg: number;
  gauge: 'mean-shift-zero';
  sourceNote: string;
}

export interface TrackHypothesis {
  hypothesisId: string;
  assignments: { observationKey: string; trackId: string }[];
  note: string;
}

export interface TrackGraphContent {
  tracksMayBreak: true;
  tracksMaySwapIdentity: true;
  breakpoints: { trackId: string; atFrame: string }[];
  identitySwaps: { trackA: string; trackB: string; frameRange: [string, string] }[];
  hypotheses: TrackHypothesis[];
}

// ---------- 复核实体（审阅页 + 锁定） ----------

export type AlignmentModel = 'rigid' | 'local_deform' | 'exclude_bad_frames';

export interface AlignmentCandidateContent {
  model: AlignmentModel;
  label: string;
  perFrameResiduals: { frameId: string; residualPx: number }[];
  rmsPx: number;
  parameterCount: number;
  aic: number;
  axis: TiltAxisFitContent;
  effectivePointSetHash: string;
  effectivePointCount: number;
  droppedFrames: string[];
}

export interface CandidateDiffContent {
  candidateA: string;
  candidateB: string;
  commonPointSetHash: string;
  commonPointCount: number;
  rmsAOnCommon: number;
  rmsBOnCommon: number;
  perFrameDelta: { frameId: string; deltaPx: number }[];
  verdict: string;
}

export type DiagnosticKind =
  | 'axis_eccentric'
  | 'track_identity_swap'
  | 'missing_high_tilt'
  | 'bad_frame_excluded'
  | 'local_deform_overfit'
  | 'multiple_solutions'
  | 'concurrent_freeze'
  | 'unit_unconvertible'
  | 'corrupt_reference';

export interface Diagnostic {
  kind: DiagnosticKind;
  summary: string;
  affected: { entityId?: string; frameIds?: string[]; trackIds?: string[]; candidateIds?: string[] };
  detail: Record<string, unknown>;
}

// ---------- 事件（机器可读取的判断依据） ----------

export type EventKind =
  | 'case_imported'
  | 'branch_created'
  | 'param_revision'
  | 'source_patch'
  | 'candidates_computed'
  | 'diagnostic'
  | 'adjudication'
  | 'adjudication_undone'
  | 'lock_created'
  | 'conflict_rejected'
  | 'archive_imported';

export interface DomainEvent {
  seq: number;
  id: string;
  branchId: string;
  kind: EventKind;
  actor: string;
  payload: Record<string, unknown>;
  refs: { entityVersionIds: string[]; blobHashes: string[] };
  supersedes: string | null;
  createdAt: string;
}

// ---------- 版本与来源链 ----------

export interface VersionRef {
  role: string;
  blobHash?: string;
  entityVersionId?: string;
}

export interface EntityVersionView {
  entityId: string;
  kind: string;
  branchId: string;
  versionNo: number;
  digest: string;
  refs: VersionRef[];
  content: unknown;
  stale: boolean;
  createdAt: string;
}

export interface ConflictInfo {
  error: 'version_conflict';
  message: string;
  currentHead: string;
  yourBase: string;
  theirEvents: DomainEvent[];
  yourAttempt: Record<string, unknown>;
}
