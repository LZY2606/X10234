/**
 * 领域数据契约 —— 直接采用电子断层/倾转序列配准的词汇，
 * 不把一切压成 name/value。
 *
 * 分层：
 *  - 原始层 Raw*：导入时保留原始表示（数值+单位+坐标基准），永不改写。
 *  - 解释层 Interpretation：人/规则对原始材料的版本化解释（轴线、轨迹身份、排除等）。
 *  - 派生层 Derived：规范化后的量与配准计算结果，可随时重放重建。
 */

export type ScenarioCode =
  | "axis_eccentricity"
  | "track_identity_swap"
  | "missing_high_tilt"
  | "bad_frame_exclusion"
  | "local_warp_overfit"
  | "ambiguous_multiplicity"
  | "concurrent_freeze";

/** 带原始表示 + 单位/坐标基准的量。无法转换时 raw 保留、normalized=null、附带诊断。 */
export interface Measured<V> {
  /** 原始文本/数值表示，逐字节保留导入内容。 */
  raw: string | number;
  /** 派生层规范化后的数值（SI 或内部基准）；无法转换时为 null。 */
  normalized: V | null;
  /** 物理单位（如 "degree","nm/px","e-/Å^2"）。 */
  unit: string;
  /** 坐标基准（如 "image_origin_topleft"、"stage"、"tilt_axis_frame"）。 */
  basis: string;
  /** 无法转换等问题诊断；可空。 */
  diagnostic?: string;
}

/** 原始帧：像素内容单独以不可变 blob 存放，这里只保留元数据与引用。 */
export interface RawFrame {
  frameId: string;
  /** 采集顺序索引（0 起，决定序列顺序）。 */
  index: number;
  /** 图像宽高（像素）。 */
  width: number;
  height: number;
  /** 指向 raw_blobs 的不可变内容引用。 */
  blobRef: BlobRef;
  note?: string;
}

/** 不可变内容引用：digest 是身份，缺引用即损坏。 */
export interface BlobRef {
  blobId: string;
  sha256: string;
  mediaType: string;
  byteLength: number;
}

/** 倾角（度，原始单位保留）。 */
export interface RawTiltAngle {
  frameId: string;
  angle: Measured<number>;
}

/** 像素尺度：物理距离/像素，保留原始单位（如 nm/px、Å/px）。 */
export interface RawPixelScale {
  frameId: string;
  scale: Measured<number>;
}

/** 曝光剂量（每帧累计/帧剂量，保留原始单位）。 */
export interface RawDose {
  frameId: string;
  dose: Measured<number>;
}

/** 单帧上的 fiducial 标记观测坐标（像素，坐标基准显式）。 */
export interface RawMarkerObservation {
  /** 原始观测点身份（导入文件里的行号/点号，保持原始）。 */
  observationId: string;
  frameId: string;
  x: Measured<number>;
  y: Measured<number>;
  /** 原始点号/列号字符串，便于身份交换核对。 */
  rawLabel?: string;
}

/** 跟踪缺口：某轨迹在某帧区间无法被观测/跟踪。 */
export interface TrackingGap {
  trackId: string;
  /** 缺口覆盖的帧（按 frameId）。 */
  missingFrameIds: string[];
  reason: string;
  recordedAt: string;
}

/** 手工排除原因：版本化、可撤销。 */
export interface ManualExclusion {
  frameId: string;
  reason: string;
  author: string;
  recordedAt: string;
}

/** 一次完整的原始材料导入清单（一个原始片段）。 */
export interface RawBundle {
  bundleId: string;
  scenario: ScenarioCode;
  frames: RawFrame[];
  tiltAngles: RawTiltAngle[];
  pixelScales: RawPixelScale[];
  doses: RawDose[];
  markers: RawMarkerObservation[];
  gaps: TrackingGap[];
  exclusions: ManualExclusion[];
  importedAt: string;
  sourceDescription: string;
}

/* ---------------- 解释层（版本化） ---------------- */

/**
 * 倾转轴。规则：不能默认固定在图像中心。
 * 必须显式给出轴线（点+方向）或标注 "unconstrained"。
 */
export interface TiltAxisSpec {
  /** 轴线上一点（像素，image 基准）。 */
  originX: number;
  originY: number;
  /** 轴方向角（度，相对图像 +x）。 */
  directionDeg: number;
  /** true 表示显式允许偏心；false/default-center 会触发诊断。 */
  explicitlyPlaced: boolean;
  assumption: string;
}

/** 轨迹段：fiducial 轨迹可断裂。 */
export interface TrackSegment {
  segmentId: string;
  observationIds: string[];
  frameIds: string[];
}

/** 轨迹身份：可显式记录“身份交换”。 */
export interface IdentityLink {
  /** 交换前段。 */
  fromSegmentId: string;
  /** 交换后段。 */
  toSegmentId: string;
  atFrameId: string;
  note: string;
}

/** 某条 fiducial 轨迹的解释（版本化）。 */
export interface TrackInterpretation {
  trackId: string;
  segments: TrackSegment[];
  identityLinks: IdentityLink[];
}

/** 一版解释：轴线 + 轨迹 + 有效帧集合。 */
export interface Interpretation {
  interpretationId: string;
  basedOnBundleId: string;
  axis: TiltAxisSpec;
  tracks: TrackInterpretation[];
  /** 被手工排除的帧（排除是显式的、版本化的，不是悄悄丢帧）。 */
  excludedFrameIds: string[];
  /** 已知缺失的高倾角帧（只标记，不用插值冒充实测）。 */
  missingFrameIds: string[];
  note: string;
}

/* ---------------- 派生层：配准候选 ---------------- */

export type RegistrationModelKind = "rigid" | "local_warp" | "badframe_excluded";

/** 每帧残差（像素；并给出归一化的 nm）。 */
export interface FrameResidual {
  frameId: string;
  tiltDeg: number;
  rmsPx: number;
  rmsNm: number;
  pointCount: number;
  usedInFit: boolean;
}

/** 候选配准。 */
export interface RegistrationCandidate {
  candidateId: string;
  model: RegistrationModelKind;
  interpretationId: string;
  /** 参与比较的有效帧集合（候选之间必须用同一集合比较）。 */
  commonFrameIds: string[];
  /** 候选实际拟合用帧（坏帧方案会少），仅用于诊断，不参与公平比较。 */
  fitFrameIds: string[];
  residuals: FrameResidual[];
  /** 在公共有效点集上的 RMS（公平指标）。 */
  commonRmsPx: number;
  /** 仅在自己拟合点上的 RMS（会因少帧偏低，禁止拿它取胜）。 */
  fitRmsPx: number;
  /** 局部形变的交叉验证 RMS；rigid 为 null。 */
  crossValidatedRmsPx: number | null;
  /** 诊断标记（overfit/uses_fewer_frames/...）。 */
  diagnostics: string[];
  /** 该候选内部参数（平移/轴修正/局部系数），供叠影与差分绘制。 */
  params: CandidateParams;
}

export interface CandidateParams {
  shiftX: number;
  shiftY: number;
  axisOriginX: number;
  axisOriginY: number;
  axisDirectionDeg: number;
  /** local_warp 的局部系数幅度（像素），其它模型为 0。 */
  localWarpAmplitude: number;
}

/** 候选对之间的差分（审阅页“候选差分”）。 */
export interface CandidateDiff {
  leftCandidateId: string;
  rightCandidateId: string;
  perFrame: Array<{
    frameId: string;
    deltaRmsPx: number;
    deltaShiftPx: number;
  }>;
  commonRmsDeltaPx: number;
  /** 右候选是否用了更少帧（若是，禁止以低残差取胜）。 */
  rightUsesFewerFrames: boolean;
}

/* ---------------- 裁定与分支 ---------------- */

export type DecisionKind = "accept" | "reject" | "adjust" | "undecided";

export interface Adjudication {
  decisionId: string;
  candidateId: string;
  kind: DecisionKind;
  author: string;
  reason: string;
  /** accept 时锁定该候选为重建引用版本。 */
  lockedForReconstruction: boolean;
  recordedAt: string;
  /** 撤销时指向前一个裁定事件。 */
  undone?: boolean;
}

/* ---------------- 事件（机器可读判断依据） ---------------- */

export type RuleCode =
  | "AXIS_NOT_CENTER"
  | "TRACKS_MAY_BREAK_AND_SWAP"
  | "COMMON_POINTSET_COMPARISON"
  | "NO_FEWER_FRAMES_LOWER_RESIDUAL";

export type EventType =
  | "case_created"
  | "raw_imported"
  | "interpretation_created"
  | "interpretation_branched"
  | "candidates_computed"
  | "candidate_rejected_by_rule"
  | "adjudication_recorded"
  | "adjudication_undone"
  | "parameter_revised"
  | "source_revised_local"
  | "conflicting_decisions_detected"
  | "conflict_resolved"
  | "scenario_verified"
  | "archive_imported"
  | "archive_exported";

export interface DomainEvent {
  eventId: string;
  caseId: string;
  seq: number;
  branchId: string;
  type: EventType;
  at: string;
  /** 依赖的实体精确版本（缺引用即损坏，不允许回退最新版）。 */
  refs: Record<string, string>;
  payload: Record<string, unknown>;
  /** 机器可读的规则判断。 */
  ruleJudgments?: Array<{
    rule: RuleCode | ScenarioCode;
    holds: boolean;
    evidence: string;
  }>;
}
