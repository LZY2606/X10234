/**
 * 领域数据契约 —— 倾转帧拼合室
 *
 * 设计原则：
 *  - 所有领域量自带单位或坐标基准（unit / basis）。
 *  - 输入层（raw/interpretation）保留原始表示，派生层才规范化。
 *  - 稳定身份：每个实体有 id，每次解释有 version 与 contentHash。
 *  - 引用必须显式指向具体版本；缺引用 => CORRUPTED，不回退最新版。
 */

export type Unit =
  | "degree"        // 倾转角，仪器原始记录
  | "radian"
  | "pixel"         // 像素坐标（图像像素网格）
  | "nm_per_pixel"  // 像素尺度
  | "angstrom_per_pixel"
  | "e_per_nm2"     // 剂量 electrons / nm^2
  | "e_per_px2"
  | "dimensionless";

/** 坐标基准：说明坐标相对什么原点、什么方向、什么帧。 */
export interface CoordBasis {
  /** 例如 image-pixel-grid（左上原点，x 右、y 下），stage-coordinate 等。 */
  kind: string;
  origin: "top-left" | "center" | "stage" | string;
  /** 单位（pixel 或物理长度）。 */
  unit: Unit;
  /** 帧引用；若为空表示对序列统一基准。 */
  frameId?: string;
  note?: string;
}

export interface Quantity {
  value: number;
  unit: Unit;
  /** 原始字符串表示（导入时保留，不规范化时仍可读）。 */
  raw?: string;
}

export interface Point2D {
  x: number;
  y: number;
  basis: CoordBasis;
}

/* ------------------------------------------------------------------ */
/* 输入实体：全部版本化                                                  */
/* ------------------------------------------------------------------ */

export type EntityKind =
  | "rawFrame"
  | "tiltAngle"
  | "pixelScale"
  | "dose"
  | "fiducialObservation"
  | "trackingGap"
  | "manualExclusion"
  | "tiltAxis"
  | "parameterSet"
  | "registrationCandidate"
  | "adjudication"
  | "lock"
  | "branch";

/** 原始帧：字节内容是不可变的，按内容哈希寻址。 */
export interface RawFrame {
  kind: "rawFrame";
  seriesId: string;
  frameId: string;
  frameIndex: number;
  /** 原始文件名/采集记录。 */
  sourceLabel: string;
  width: number;
  height: number;
  blobSha: string; // 指向 blobs 表
  byteLength: number;
  pixelBasis: CoordBasis;
}

export interface TiltAngle {
  kind: "tiltAngle";
  seriesId: string;
  frameId: string;
  angle: Quantity; // 原始单位 + raw
  orderedIndex: number;
}

export interface PixelScale {
  kind: "pixelScale";
  seriesId: string;
  frameId?: string;
  scale: Quantity;
}

export interface Dose {
  kind: "dose";
  seriesId: string;
  frameId: string;
  cumulative?: boolean;
  dose: Quantity;
}

/** 单个 fiducial 在某帧的一次观测。trackId 是标记身份，可断裂、可交换。 */
export interface FiducialObservation {
  kind: "fiducialObservation";
  seriesId: string;
  frameId: string;
  /** 观测 id（frame+track 上的点）。 */
  observationId: string;
  /** 跟踪身份（解释层分配；同一 trackId 不保证连续，交换时会变化）。 */
  trackId: string;
  position: Point2D;
  /** 该观测由哪段跟踪给出，断裂分段。 */
  segmentId: string;
}

export interface TrackingGap {
  kind: "trackingGap";
  seriesId: string;
  trackId: string;
  segmentFrom: string;
  segmentTo: string;
  /** 缺口覆盖的帧（缺失或未跟踪）。 */
  missingFrameIds: string[];
  reason: "out-of-field" | "occluded" | "low-contrast" | "missing-frame" | "unknown";
  note?: string;
}

export interface ManualExclusion {
  kind: "manualExclusion";
  seriesId: string;
  frameId: string;
  reasonCode:
    | "motion-blur"
    | "too-many-tracks-lost"
    | "dose-anomaly"
    | "high-tilt-unusable"
    | "other";
  reason: string;
  decidedBy: string;
}

/**
 * 倾转轴。绝不能默认固定在图像中心：
 *  - anchored=false 表示轴位置由配准估计/多解，不假定中心。
 *  - anchor 只有在有仪器/测量来源时才存在，并带 source 版本引用。
 */
export interface TiltAxis {
  kind: "tiltAxis";
  seriesId: string;
  /** 轴在图像平面的方向角（度），绕光轴。 */
  directionDeg: number;
  /** 轴上一点（像素）。anchor 显式给出；无 anchor 时不允许写死为图像中心。 */
  anchor?: Point2D;
  anchored: boolean;
  anchorProvenance?: {
    source: "instrument-log" | "fiducial-fit" | "manual" | "unconstrained";
    /** 支撑该锚点的实体版本引用。 */
    refs: VersionRef[];
  };
}

/* ------------------------------------------------------------------ */
/* 参数 / 候选 / 裁定                                                   */
/* ------------------------------------------------------------------ */

export interface ParameterSet {
  kind: "parameterSet";
  seriesId: string;
  name: string;
  /** 轴先验：不锚定 / 仪器锚定。 */
  axisPolicy: "unconstrained" | "instrument-anchored";
  maxLocalWarpNorm: number; // 像素，局部形变能量阈值
  ambiguityResidualThresholdPx: number;
  notes?: string;
}

export type RegistrationModel = "rigid" | "local-warp" | "exclude-frames";

export interface PerFrameResidual {
  frameId: string;
  tiltDeg: number;
  rmsPx: number;
  used: boolean;
  excludedReason?: string;
}

export interface RegistrationCandidate {
  kind: "registrationCandidate";
  seriesId: string;
  branchId: string;
  model: RegistrationModel;
  /** 参与拟合的观测点集合的稳定哈希。不同候选必须用相同有效点集才可比。 */
  effectivePointSetHash: string;
  usedFrameIds: string[];
  excludedFrameIds: string[];
  trackingGapIds: string[];
  /** 轴（估计或锚定），不写死中心。 */
  axis: TiltAxis;
  /** 全局 rms（像素）。 */
  rmsPx: number;
  /** 有效点集覆盖率（帧占比、倾转跨度），防止用少帧换低残差。 */
  coverage: {
    frameCount: number;
    totalFrameCount: number;
    tiltSpanDeg: number;
  };
  /** 局部形变总能量（rigid 为 0）。 */
  warpEnergy: number;
  perFrame: PerFrameResidual[];
  /** 每帧刚体/仿射平移，审阅页叠影使用。 */
  frameTransforms?: Record<string, { dx: number; dy: number; tiltDeg: number }>;
  diagnostics: CandidateDiagnostic[];
  /** 多解时的其它合法轴候选。 */
  alternateAxes?: { directionDeg: number; anchor?: Point2D; rmsPx: number }[];
  ambiguous: boolean;
  /** 该候选依赖的输入版本键（用于失效范围计算）。 */
  dependencies: string[];
  /** 派生所引用的全部具体版本。 */
  refs: VersionRef[];
  /** 求解状态。 */
  solveStatus: "unique" | "ambiguous" | "overfit" | "degenerate" | "ok";
}

export interface CandidateDiagnostic {
  code:
    | "axis-off-center"
    | "track-identity-swap"
    | "missing-high-tilt"
    | "bad-frame-excluded"
    | "local-warp-overfit"
    | "multi-solution"
    | "concurrency-frozen"
    | "non-comparable-point-set"
    | "fewer-frames-lower-residual-rejected"
    | "unconvertible-value";
  severity: "info" | "warning" | "error";
  message: string;
  frameIds?: string[];
  trackIds?: string[];
}

export interface Adjudication {
  kind: "adjudication";
  seriesId: string;
  branchId: string;
  candidateId: string;
  decision: "accepted" | "rejected";
  reason: string;
  decidedBy: string;
  /** 撤销目标事件 id（撤销时指向原 accept/reject）。 */
  undoesEventId?: string;
}

export interface Lock {
  kind: "lock";
  seriesId: string;
  branchId: string;
  candidateId: string;
  reason: string;
  decidedBy: string;
  /** 重建引用令牌；稳定身份。 */
  reconstructionRef: string;
  active: boolean;
}

export interface Branch {
  kind: "branch";
  seriesId: string;
  branchId: string;
  parentBranchId?: string;
  /** 分支起点事件 id。 */
  forkedFromEventId?: string;
  label: string;
  reason: string;
}

export type DomainEntity =
  | RawFrame
  | TiltAngle
  | PixelScale
  | Dose
  | FiducialObservation
  | TrackingGap
  | ManualExclusion
  | TiltAxis
  | ParameterSet
  | RegistrationCandidate
  | Adjudication
  | Lock
  | Branch;

/* ------------------------------------------------------------------ */
/* 版本引用与事件                                                       */
/* ------------------------------------------------------------------ */

/** 显式版本引用：实体必须指向具体版本，缺失 => CORRUPTED。 */
export interface VersionRef {
  entityId: string;
  version: number;
  kind: EntityKind;
  contentHash?: string;
}

export type EventType =
  | "series-created"
  | "import-batch"
  | "branch-created"
  | "parameter-revised"
  | "source-revised"
  | "interpretation-revised"
  | "candidate-derived"
  | "adjudication-decided"
  | "adjudication-undone"
  | "registration-locked"
  | "lock-revoked"
  | "frame-excluded"
  | "frame-restored"
  | "track-swap-flagged"
  | "conflict-detected"
  | "integrity-corrupted";

export interface EventRecord {
  id: string;
  seq: number;
  branchId: string;
  seriesId: string;
  type: EventType;
  at: string;
  actor: string;
  /** 乐观并发版本：保存方基于的最后事件 seq。 */
  baseSeq: number;
  /** 事件 upsert 的实体（含 entityId/version）。 */
  upserts: EntityEnvelope[];
  /** 事件失效的派生候选 id（依赖范围），仅标记，不删除。 */
  invalidates?: { candidateId: string; reason: string; dependencyKey: string }[];
  /** 机器可读的领域判定（判断依据）。 */
  assertions?: MachineAssertion[];
  /** 输入片段 id（反例档案：保留输入片段）。 */
  fragmentId?: string;
  /** 冲突信息（两窗口并发）。 */
  conflict?: { otherEventId: string; otherActor: string; diff: ConflictDiff };
  note?: string;
}

export interface EntityEnvelope {
  entityId: string;
  version: number;
  kind: EntityKind;
  doc: DomainEntity;
  contentHash: string;
  refs: VersionRef[];
}

/** 机器可读判断事件：对应三条领域规则。 */
export interface MachineAssertion {
  rule:
    | "axis-not-default-center"
    | "fiducial-track-can-break-and-swap"
    | "compare-same-effective-point-set"
    | "no-fewer-frames-for-lower-residual"
    | "keep-all-legal-candidates-when-ambiguous"
    | "versioned-immutable-sources"
    | "local-warp-overfit-guarded"
    | "dependencies-scope-invalidation";
  verdict: "holds" | "violated" | "indeterminate";
  evidence: VersionRef[];
  detail: string;
}

export interface ConflictDiff {
  local: { eventType: EventType; targetEntityId: string; summary: string };
  remote: { eventType: EventType; targetEntityId: string; summary: string };
  affectedCandidateIds: string[];
}

/* ------------------------------------------------------------------ */
/* 查询 DTO：返回引用版本号与内容摘要；缺引用 => CORRUPTED               */
/* ------------------------------------------------------------------ */

export interface EntityView {
  entityId: string;
  version: number;
  kind: EntityKind;
  contentHash: string;
  doc: DomainEntity;
  refs: VersionRef[];
  /** 引用完整性。 */
  integrity: "ok" | "corrupted";
  missingRefs?: VersionRef[];
  createdAt: string;
  eventId: string;
}

export interface SeriesState {
  seriesId: string;
  headSeq: number;
  branchHeadSeq: Record<string, number>;
  branches: Branch[];
  current: Record<string, EntityView>; // entityId => 该分支当前视图
  candidates: RegistrationCandidate[];
  events: EventRecord[];
  activeLock?: Lock;
  diagnostics: CandidateDiagnostic[];
}

export interface CorruptionReport {
  status: "corrupted";
  missingRefs: { fromEntityId: string; ref: VersionRef }[];
}
