// 领域数据契约：直接使用电子断层 / tilt-series 领域词汇。
// 所有领域量都携带单位 (unit) 或坐标基准 (coordFrame)。

export type EntityKind =
  | "tilt_series"
  | "raw_frame"
  | "tilt_angle"
  | "pixel_size"
  | "dose"
  | "fiducial_track"
  | "marker_observation"
  | "tracking_gap"
  | "manual_exclusion"
  | "alignment_candidate"
  | "adjudication";

/** 带单位/坐标基准的量。raw 保留导入时的原始表示。 */
export interface Quantified {
  value: number;
  unit: string; // deg / nm / px / e/A^2 ...
  coordFrame?: string; // image-tl-px / detector / specimen ...
  raw?: string; // 导入时的原始文本表示，禁止丢弃
}

export interface RawFrameVersion {
  frameId: string; // 稳定身份，例如 F-00
  index: number; // 采集顺序
  widthPx: number;
  heightPx: number;
  seed: number; // 离线案例帧内容生成种子
  present: boolean; // false = 缺失（如缺失高倾角帧）
}

export interface TiltAngleVersion {
  frameId: string;
  angle: Quantified; // deg
}

export interface PixelSizeVersion {
  x: Quantified; // nm/px
  y: Quantified;
  source: string; // 显微镜记录的像素尺度来源
}

export interface DoseVersion {
  frameId: string;
  cumulative: Quantified; // e/A^2 累计剂量
  perFrame: Quantified;
}

/** fiducial 轨迹：可断裂，断裂后可能身份交换 */
export interface FiducialTrackVersion {
  trackId: string;
  /** 观测序列；断点用 TrackingGap 显式表达，不悄悄连接 */
  observations: MarkerObservation[];
}

export interface MarkerObservation {
  frameId: string;
  xPx: number; // 坐标基准: image-tl-px
  yPx: number;
  coordFrame: "image-tl-px";
  continuity: "continuous" | "after-gap" | "swapped";
}

export interface TrackingGapVersion {
  gapId: string;
  trackId: string;
  fromFrameId: string;
  toFrameId: string;
  reason: string;
}

export interface ManualExclusionVersion {
  exclusionId: string;
  frameId: string;
  reason: string;
  actor: string;
}

/** 倾转轴几何：x0,y0 是轴线相对图像左上角的位置；严禁默认固定在图像中心 */
export interface TiltAxisGeometry {
  phiDeg: number; // 轴线面内方向
  x0Px: number; // 轴线位置（图像坐标基准）
  y0Px: number;
  centerAssumed: boolean; // 仅在显式声明时可为 true（反例：默认中心）
  sourceVersionRef: string; // 来源引用 entity@version
}

export type CandidateKind = "rigid" | "local_deformation" | "bad_frame_exclusion";

export interface EffectivePointSet {
  /** 规范化集合身份：frameId + trackId 对排序后的稳定哈希输入 */
  members: string[];
  hash: string;
  excludedFrames: string[];
}

export interface AlignmentCandidateBody {
  candidateId: string;
  kind: CandidateKind;
  label: string;
  axis: TiltAxisGeometry;
  /** 自由参数个数（用于过拟合判定，不参与残差作弊） */
  degreesOfFreedom: number;
  localWarp?: { controlGrid: number; perFrameAffine: boolean };
  effectivePointSet: EffectivePointSet;
  frameResiduals: Record<string, FrameResidual>;
  trainRmsPx: number;
  heldOutRmsPx: number;
  status: "legal" | "overfit" | "incomparable" | "ambiguous";
  diagnostics: string[];
}

export interface FrameResidual {
  frameId: string;
  rmsPx: number;
  maxPx: number;
  usedPoints: number;
}

export type AdjudicationKind =
  | "accepted"
  | "rejected"
  | "locked_for_reconstruction"
  | "undone";

export interface AdjudicationBody {
  adjudicationId: string;
  candidateId: string;
  kind: AdjudicationKind;
  actor: string;
  reason: string;
  /** 撤销目标：恢复到哪条事件之前的分支状态 */
  revertsEventId?: string;
}

export type ScenarioKey =
  | "axis_eccentricity"
  | "track_identity_swap"
  | "missing_high_tilt"
  | "bad_frame_exclusion"
  | "local_deformation_overfit"
  | "multiple_solutions"
  | "concurrent_freeze";

export interface EventRecord {
  eventId: string; // 稳定身份
  branchId: string;
  seq: number;
  type:
    | "source_version_committed"
    | "interpretation_created"
    | "candidate_proposed"
    | "candidate_compared"
    | "adjudication"
    | "parameter_revision"
    | "localized_source_change"
    | "conflict_detected"
    | "diagnostic_raised"
    | "replay_step"
    | "archive_roundtrip";
  scenario?: ScenarioKey;
  actor: string;
  payload: Record<string, unknown>;
  /** 本次事件依赖的实体版本引用 entity@version —— 缺引用即损坏 */
  dependencyRefs: string[];
  /** 当时可见结论的快照（回到旧事件时恢复，不用最新结果覆盖历史） */
  viewSnapshot: Record<string, unknown>;
  createdAt: string;
}

export interface BranchRecord {
  branchId: string;
  name: string;
  parentBranchId: string | null;
  headEventId: string | null;
  baseVersion: number; // 用于并发保存冲突检测
  createdAt: string;
}

export interface SourceVersionRow {
  entityId: string;
  versionNo: number;
  kind: EntityKind;
  contentHash: string;
  content: unknown;
  rawRepresentation: string | null;
  units: string | null;
  coordFrame: string | null;
  branchId: string;
  commitEventId: string;
  createdAt: string;
}

export interface ReviewBundle {
  branchId: string;
  headEventId: string;
  baseVersion: number;
  frames: RawFrameVersion[];
  tiltAngles: Record<string, number>;
  pixelSize: PixelSizeVersion | null;
  doses: Record<string, DoseVersion>;
  tracks: FiducialTrackVersion[];
  gaps: TrackingGapVersion[];
  exclusions: ManualExclusionVersion[];
  axisByCandidate: Record<string, TiltAxisGeometry>;
  candidates: AlignmentCandidateBody[];
  activeAdjudication: { candidateId: string; kind: AdjudicationKind } | null;
  events: EventRecord[];
  diagnostics: DiagnosticRow[];
}

export interface DiagnosticRow {
  diagnosticId: string;
  entityRef: string;
  severity: "unconvertible" | "warning" | "corruption";
  message: string;
  rawValue: string | null;
  createdAt: string;
}
