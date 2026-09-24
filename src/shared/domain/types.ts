/**
 * 倾转帧拼合室 —— 领域数据契约。
 *
 * 关键立场：
 *  - 直接使用电镜断层领域词汇（tilt frame / tilt angle / pixel scale / exposure dose /
 *    fiducial trajectory / tracking gap / manual exclusion），不压成 name/value。
 *  - 所有领域量携带单位或坐标基准；导入时保留原始表示，派生层才规范化。
 *  - 倾转轴不默认固定在图像中心；fiducial 轨迹可断裂、可发生身份交换。
 *  - 不同候选必须用相同有效点集比较，禁止用少帧换低残差。
 */

/** 稳定身份：时间排序前缀 + 随机后缀，导出/删除/重导入后保持不变。 */
export type StableId = string;

/** 语义版本号，形如 20260924-183905-7f3a9c12（单调、时间排序）。 */
export type SemanticVersion = string;

/** 坐标基准：所有派生坐标必须声明。 */
export interface CoordinateFrame {
  /** 原点约定，例如 "frame-pixel-topleft"（像素、左上原点、y 向下）。 */
  origin: 'frame-pixel-topleft';
  /** 像素尺度实体引用（pixel-scale 版本）；null 表示原始未规范化坐标。 */
  pixelScaleRef: { materialId: StableId; version: SemanticVersion } | null;
}

/** 带单位的物理量。raw 为导入时原始表示，规范化值只出现在派生层。 */
export interface Quantity<T extends string> {
  value: number;
  unit: T;
  /** 导入时的原始文本表示（逐字保留）。 */
  raw: string;
  /** 无法转换时留在原位置并附诊断；此时 normalized 为 null。 */
  normalized: number | null;
  normalizedUnit: T | null;
}

export type AngleUnit = 'degree' | 'radian';
export type LengthUnit = 'nm' | 'angstrom' | 'pixel';
export type DoseUnit = 'e-/A^2' | 'e-/nm^2';

export type Angle = Quantity<AngleUnit>;
export type Length = Quantity<LengthUnit>;
export type Dose = Quantity<DoseUnit>;

// ---------- 输入实体（全部版本化） ----------

/** 原始帧：像素字节不可变，通过 blobRef 内容寻址。 */
export interface TiltFrame {
  frameId: StableId;
  /** 采集序号，保持导入顺序（倾角可无序）。 */
  acquisitionIndex: number;
  width: number;
  height: number;
  /** 像素格式，如 "p5-pgm-u8"。 */
  encoding: string;
  blobRef: { sha256: string; byteLength: number };
  /** 原始文件名/路径表示（逐字保留）。 */
  rawLabel: string;
  /** 无法解析的原始字段留在原处。 */
  rawExtras: Record<string, string>;
}

/** 倾角（单位随原始文件保留）。 */
export interface TiltAngle {
  frameId: StableId;
  angle: Angle;
}

/** 像素尺度：物理长度 / 像素。 */
export interface PixelScale {
  length: Length;
  per: 'pixel';
  /** 来源，如 "mdoc" | "header" | "manual"。 */
  source: string;
  rawText: string;
}

/** 曝光剂量（单帧剂量）。 */
export interface ExposureDose {
  frameId: StableId;
  dose: Dose;
  rawText: string;
}

/** fiducial 点的单帧观测坐标（像素，原始坐标基准）。 */
export interface FiducialObservation {
  frameId: StableId;
  /** 像素坐标，左上原点；保留原始表示。 */
  x: number;
  y: number;
  rawText: string;
  /** 该观测是否存在（false 即跟踪缺口）。 */
  observed: boolean;
}

/**
 * fiducial 轨迹：由“轨迹段”组成。断裂（跟踪缺口）与身份交换都是一等事实。
 * trackId 是导入侧给出的原始轨迹身份；segmentId 是断裂后的稳定段身份。
 */
export interface FiducialTrack {
  trackId: StableId;
  segments: FiducialTrackSegment[];
}

export interface FiducialTrackSegment {
  segmentId: StableId;
  /** 该段覆盖的帧（连续或不连续都允许；缺口显式登记）。 */
  observations: FiducialObservation[];
}

/** 跟踪缺口：显式记录哪条轨迹在哪一帧缺失。 */
export interface TrackingGap {
  trackId: StableId;
  segmentId: StableId | null;
  frameId: StableId;
  /** 缺口原因（原始标注），逐字保留。 */
  reason: string;
}

/**
 * 轨迹身份交换：在某帧/帧区间，两个原始 trackId 的物理金粒身份疑似对调。
 * 系统不自动“修复”，只登记证据，候选必须显式声明采用哪种身份解释。
 */
export interface IdentitySwapHypothesis {
  swapId: StableId;
  trackA: StableId;
  trackB: StableId;
  /** 交换发生的帧区间。 */
  fromFrameId: StableId;
  toFrameId: StableId;
  evidence: string;
  /** 登记来源，如 "auto-suggestion" | "manual"。 */
  source: string;
}

/** 手工排除帧原因：审阅者显式决定，带理由，不可被自动清洗覆盖。 */
export interface ManualExclusion {
  frameId: StableId;
  reason: string;
  note: string;
}

/** 无法转换/解析的值留在原位置并附诊断。 */
export interface IngestDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  /** 出错的原始文本（逐字保留，绝不丢弃）。 */
  rawValue?: string;
  path: string;
}

// ---------- 规则参数（版本化） ----------

export interface RegistrationRuleParams {
  /** 倾转轴是否允许偏离图像中心；永远为 true —— 不允许默认中心。 */
  axisOffsetAllowed: true;
  /** 局部形变网格间距（像素）；过大自由度过拟合时触发诊断。 */
  localWarpGridSpacingPx: number;
  /** 每有效点允许的局部自由度上限（防过拟合）。 */
  maxWarpDofPerPoint: number;
  /** 多解判定：残差差小于该相对阈值视为并列合法。 */
  ambiguityRelativeTolerance: number;
  /** 剂量权重是否参与拟合（派生层选项）。 */
  doseWeighting: boolean;
  /** 冻结租约时长（毫秒）。 */
  freezeLeaseMs: number;
}

// ---------- 配准候选与复核实体 ----------

export type RegistrationKind = 'rigid' | 'local-warp' | 'bad-frame-exclusion';

/** 倾转轴估计结果：明确偏心，绝不假定在图像中心。 */
export interface TiltAxisEstimate {
  /** 轴线在 0° 帧像素坐标系中的表示：点 + 方向角。 */
  originX: number;
  originY: number;
  angleDeg: number;
  /** 偏心量（像素）：轴线点到图像中心的距离。 */
  offsetFromImageCenterPx: number;
  residualNm: number;
  /** 身份解释：候选采用了哪些 swap 假设（swapId 集合）。 */
  adoptedSwaps: StableId[];
  estimated: boolean;
}

export interface PerFrameResidual {
  frameId: StableId;
  residualNm: number;
  residualPx: number;
  used: boolean;
  excludedReason: string | null;
}

export interface RegistrationCandidate {
  candidateId: StableId;
  kind: RegistrationKind;
  /** 相同有效点集身份：同一 pointSetId 的候选才允许直接比较。 */
  pointSetId: StableId;
  effectiveFrameIds: StableId[];
  effectiveTrackIds: StableId[];
  excludedFrameIds: StableId[];
  axis: TiltAxisEstimate;
  perFrame: PerFrameResidual[];
  /** 聚合残差（nm），派生量。 */
  weightedRmsNm: number;
  /** 局部形变自由度（rigid 为 0 语义的刚体参数）。 */
  warpDegreesOfFreedom: number;
  diagnostics: CandidateDiagnostic[];
  /** 依赖的输入版本快照（用于失效范围计算与历史回放）。 */
  dependencies: DependencyRef[];
  ruleVersion: SemanticVersion;
  /** true 表示自上次源修订后已失效（保留旧结论，不悄悄替换）。 */
  stale: boolean;
}

export interface CandidateDiagnostic {
  code:
    | 'AXIS_CENTER_NOT_ASSUMED'
    | 'TRACK_IDENTITY_SWAP_PRESENT'
    | 'TRACK_SEGMENT_BROKEN'
    | 'MISSING_HIGH_TILT_FRAME'
    | 'BAD_FRAME_EXCLUDED'
    | 'LOCAL_WARP_OVERFIT'
    | 'MULTIPLE_SOLUTIONS'
    | 'EFFECTIVE_SET_MISMATCH'
    | 'FEWER_FRAMES_NOT_A_WIN'
    | 'UNRESOLVED_UNIT'
    | 'INSUFFICIENT_OBSERVATIONS';
  message: string;
  frameIds?: StableId[];
  trackIds?: StableId[];
  candidateIds?: StableId[];
}

export interface DependencyRef {
  materialId: StableId;
  version: SemanticVersion;
  kind: MaterialKind;
  sha256: string;
}

export type MaterialKind =
  | 'tilt-frames'
  | 'tilt-angles'
  | 'pixel-scale'
  | 'exposure-doses'
  | 'fiducial-tracks'
  | 'tracking-gaps'
  | 'identity-swaps'
  | 'manual-exclusions'
  | 'rule-params';

// ---------- 分支、事件、裁定 ----------

export type BranchStatus =
  | 'open'
  | 'ambiguous'
  | 'accepted'
  | 'rejected'
  | 'locked'
  | 'frozen';

export interface BranchStateView {
  branchId: StableId;
  label: string;
  parentBranchId: StableId | null;
  status: BranchStatus;
  headEventId: StableId;
  ruleVersion: SemanticVersion;
  candidates: RegistrationCandidate[];
  acceptedCandidateId: StableId | null;
  lockedCandidateId: StableId | null;
  /** 重建引用句柄：锁定后非空，指向不可变候选快照。 */
  reconstructionRef: { candidateId: StableId; lockEventId: StableId } | null;
  diagnostics: CandidateDiagnostic[];
  /** 从初始事件到 head 的完整事件链（历史可见结论）。 */
  timeline: EventRecord[];
  /** 冻结状态（并发冻结检验）。 */
  freeze: { owner: string; until: number; reason: string } | null;
}

export type EventType =
  | 'import-batch'
  | 'material-revised'
  | 'rule-params-revised'
  | 'branch-created'
  | 'candidate-proposed'
  | 'candidate-accepted'
  | 'candidate-rejected'
  | 'adjudication-revoked'
  | 'registration-locked'
  | 'derivatives-invalidated'
  | 'branch-frozen'
  | 'branch-unfrozen'
  | 'manual-exclusion-recorded';

export interface EventRecord {
  eventId: StableId;
  branchId: StableId;
  seq: number;
  type: EventType;
  /** 乐观并发：父事件 id，形成链。 */
  parentEventId: StableId | null;
  timestamp: string;
  actor: string;
  payload: unknown;
  /** 本事件引用的依赖版本快照。 */
  dependencies: DependencyRef[];
  /** 前一事件内容哈希，链式防篡改。 */
  prevHash: string | null;
  hash: string;
}

/** 查询任一实体时返回的信封：稳定身份 + 引用版本 + 内容摘要。 */
export interface EntityEnvelope<T> {
  entity: T;
  stableId: StableId;
  version: SemanticVersion;
  contentSha256: string;
  summary: string;
  references: DependencyRef[];
}

export interface IntegrityReport {
  ok: boolean;
  errors: { code: string; message: string; ref?: DependencyRef }[];
}
