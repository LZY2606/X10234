/**
 * 倾转帧拼合室 · 领域数据契约（电子断层 tilt-series 词汇）
 *
 * 设计原则：
 *  1. 直接使用电子断层领域词汇（原始帧 / 倾角 / 像素尺度 / 剂量 /
 *     fiducial 标记点坐标 / 跟踪缺口 / 手工排除原因），禁止退化为 name/value。
 *  2. 每个实体都有稳定身份（stableId）与版本号（version）。
 *  3. 所有领域量携带单位或坐标基准；导入层保留原始表示，派生层才规范化。
 *  4. 无法转换的值留在原位置并附诊断，绝不为画图而丢弃。
 */

export const SCHEMA_FAMILY = 'tilt-fusion-room';
export const SCHEMA_VERSION = 1;

/** 坐标基准 */
export type CoordinateFrame = 'image_pixels_top_left';
export const COORD_FRAME: CoordinateFrame = 'image_pixels_top_left';

/** 单位词表（领域量必须显式携带） */
export type AngleUnit = 'degree';
export type LengthUnit = 'nanometer';
export type PixelScaleUnit = 'nm_per_pixel';
export type DoseUnit = 'electrons_per_angstrom_squared';
export type ResidualUnit = 'pixel';

/** 稳定身份：同一实体跨版本共享 stableId */
export type StableId = string;

export interface VersionedId {
  stableId: StableId;
  version: number;
}

/** 带单位/坐标基准的标量；raw 保留导入时原始表示 */
export interface DomainQuantity<V, U extends string> {
  value: V;
  unit: U;
  rawText?: string;
}

export interface AngleQ extends DomainQuantity<number, AngleUnit> {}
export interface PixelScaleQ extends DomainQuantity<number, PixelScaleUnit> {}
export interface DoseQ extends DomainQuantity<number, DoseUnit> {}
export interface ResidualQ extends DomainQuantity<number, ResidualUnit> {}

/** 像素坐标（图像左上角原点，x 向右、y 向下） */
export interface PixelPoint {
  frame: CoordinateFrame;
  x: number;
  y: number;
}

/** 无法转换/不可解释的值留在原位置并附诊断 */
export interface Diagnostic {
  code:
    | 'UNPARSEABLE_ANGLE'
    | 'UNPARSEABLE_PIXEL_SCALE'
    | 'UNPARSEABLE_DOSE'
    | 'UNPARSEABLE_COORDINATE'
    | 'MISSING_UNIT'
    | 'OUT_OF_RANGE_TILT'
    | 'REFERENCE_NOT_FOUND'
    | 'DANGLING_TRACK_OBSERVATION';
  severity: 'warning' | 'error';
  message: string;
  fieldPath: string;
}

/* ------------------------------------------------------------------ */
/* 原始实体（七种输入实体，全部版本化、不可变）                        */
/* ------------------------------------------------------------------ */

export type SourceEntityKind =
  | 'raw_frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'exposure_dose'
  | 'fiducial_observation'
  | 'tracking_gap'
  | 'manual_exclusion';

/** 原始帧：像素字节以内容寻址 blob 存储，这里只存摘要与来源 */
export interface RawFrame {
  kind: 'raw_frame';
  frameIndex: number;
  width: number;
  height: number;
  blobSha256: string;
  mediaType: string;
  byteLength: number;
  acquiredAt: string | null;
}

/** 倾角（不假设对称、不假设范围） */
export interface TiltAngle {
  kind: 'tilt_angle';
  frameIndex: number;
  angle: AngleQ | null;
}

/** 像素尺度（nm/pixel） */
export interface PixelScale {
  kind: 'pixel_scale';
  frameIndex: number;
  scale: PixelScaleQ | null;
}

/** 曝光剂量（e-/Å²） */
export interface ExposureDose {
  kind: 'exposure_dose';
  frameIndex: number;
  dose: DoseQ | null;
}

/**
 * fiducial 标记点观测：某条轨迹上的一个标记在某帧中的像素坐标。
 * 轨迹可断裂（tracking_gap），不同观测的轨迹身份可能被错误交换。
 */
export interface FiducialObservation {
  kind: 'fiducial_observation';
  trackId: StableId;
  frameIndex: number;
  point: PixelPoint | null;
  /** 导入时标注的身份可疑度（例如交换重排后），不参与清洗，仅保留 */
  identityConfidence: number;
}

/** 跟踪缺口：trackId 在 [fromFrameIndex..toFrameIndex] 区间无观测 */
export interface TrackingGap {
  kind: 'tracking_gap';
  trackId: StableId;
  fromFrameIndex: number;
  toFrameIndex: number;
  reason: string | null;
}

/** 手工排除原因：人决定某帧不进入有效点集，原因必须留档 */
export interface ManualExclusion {
  kind: 'manual_exclusion';
  frameIndex: number;
  reason: string;
  decidedBy: string;
}

export type SourceEntity =
  | RawFrame
  | TiltAngle
  | PixelScale
  | ExposureDose
  | FiducialObservation
  | TrackingGap
  | ManualExclusion;

/** 一次导入/修订形成的不可变源实体版本 */
export interface SourceRevision {
  stableId: StableId;
  version: number;
  kind: SourceEntityKind;
  payload: SourceEntity;
  contentSha256: string;
  createdAt: string;
  createdBy: string;
  /** 同一 stableId 的上一版本；首版为 null */
  supersedes: number | null;
  /** 本次修订直接依赖的源片段（内容寻址），用于失效范围计算 */
  basedOnClipSha256: string[];
}

/* ------------------------------------------------------------------ */
/* 配准候选与裁定（派生实体 / 复核实体）                               */
/* ------------------------------------------------------------------ */

export type RegistrationKind = 'rigid' | 'local_warp' | 'bad_frame_excluded';

/** 倾转轴：绝不默认固定在图像中心 */
export interface TiltAxis {
  /** 轴线穿过的点（像素，图像坐标基准） */
  anchor: PixelPoint;
  /** 轴线方向角（图像坐标下，单位 degree，相对 +x 轴） */
  orientation: AngleQ;
  /** 轴线到图像中心的距离（像素） */
  eccentricity: ResidualQ;
  /** 拟合证据 */
  fittedFromTracks: StableId[];
  /** 为 true 表示只是“图像中心”默认值——本系统禁止使用默认值 */
  assumedAtImageCenter: false;
}

/** 每帧刚体参数（相对参考帧） */
export interface RigidTransform {
  frameIndex: number;
  translationX: number; // pixel
  translationY: number; // pixel
  rotation: AngleQ;
}

/** 每帧残差 */
export interface PerFrameResidual {
  frameIndex: number;
  meanResidual: ResidualQ;
  maxResidual: ResidualQ;
  usedObservationRefs: VersionedId[];
  excluded: boolean;
  exclusionReason: string | null;
}

export interface LocalWarpOverfitDiagnostic {
  overfit: boolean;
  /** 局部形变自由度相对有效点数的比值 */
  dofPerObservation: number;
  /** 留出轨迹上的残差是否显著恶化 */
  holdoutResidualDelta: ResidualQ | null;
  message: string;
}

export type CandidateDiagnosticCode =
  | 'AXIS_OFF_CENTER'
  | 'TRACK_IDENTITY_SWAP_SUSPECTED'
  | 'MISSING_HIGH_TILT_FRAMES'
  | 'BAD_FRAME_EXCLUDED'
  | 'LOCAL_WARP_OVERFIT'
  | 'AMBIGUOUS_MULTI_SOLUTION'
  | 'FEWER_FRAMES_LOWER_RESIDUAL_REJECTED'
  | 'CONCURRENT_FROZEN';

export interface CandidateDiagnostic {
  code: CandidateDiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  frameIndices: number[];
  trackIds: StableId[];
}

/**
 * 配准候选：不可变。不同候选必须用相同有效点集比较，
 * 禁止用“少帧”换取低残差。
 */
export interface RegistrationCandidate {
  kind: RegistrationKind;
  parameterRevision: VersionedId;
  tiltAxis: TiltAxis;
  rigidTransforms: RigidTransform[];
  perFrameResiduals: PerFrameResidual[];
  /** 该候选使用的有效帧集合（帧索引排序） */
  effectiveFrameSet: number[];
  /** 该候选使用的观测版本引用集合（稳定身份+版本） */
  effectiveObservationSet: VersionedId[];
  /** 候选自身有效点集上的残差（像素） */
  residualOnOwnSet: number;
  /** 在“所有候选公共有效点集”上重算的残差——公平比较依据 */
  residualOnCommonSet: number;
  commonSetObservationCount: number;
  ownSetObservationCount: number;
  overfit: LocalWarpOverfitDiagnostic | null;
  diagnostics: CandidateDiagnostic[];
  /** 多解：同样合法的其它解的签名 */
  alternateSolutionSignatures: string[];
  /** 生成该候选所依据的规则版本 */
  ruleVersion: string;
}

export type Adjudication = 'accepted' | 'rejected';

export interface CandidateRecord extends VersionedId {
  candidate: RegistrationCandidate;
  signature: string;
  createdAt: string;
}

/** 裁定依据的机器可读代码 */
export type BasisCode =
  | 'AXIS_NOT_ASSUMED_AT_CENTER'
  | 'TRACKS_CAN_BREAK_AND_SWAP_IDENTITY'
  | 'COMMON_EFFECTIVE_POINT_SET_COMPARISON'
  | 'NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL'
  | 'KEEP_ALL_LEGAL_SOLUTIONS_WHEN_AMBIGUOUS'
  | 'LOCAL_WARP_OVERFIT_PENALIZED'
  | 'EXCLUSION_REASON_REQUIRED'
  | 'CONFLICT_LATER_WRITER_MUST_SEE_DIFF';

export interface EventBasis {
  code: BasisCode;
  detail: string;
}

export type EventType =
  | 'source_revision_committed'
  | 'parameter_revision_committed'
  | 'candidate_generated'
  | 'candidate_accepted'
  | 'candidate_rejected'
  | 'adjudication_revoked'
  | 'registration_locked'
  | 'lock_revoked'
  | 'conflict_detected';

export interface ArchiveEvent {
  eventId: number;
  eventType: EventType;
  at: string;
  by: string;
  branchId: StableId;
  /** 父事件 id，形成可回溯的事件链 */
  parentEventId: number | null;
  basis: EventBasis[];
  refs: VersionedId[];
  payload: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 参数版本（派生规则参数；变化触发按依赖关系失效，不全局替换）        */
/* ------------------------------------------------------------------ */

export interface RegistrationParameters {
  referenceFrameIndex: number;
  /** 公共点集比较策略 */
  fairComparison: 'intersection_of_effective_observation_sets';
  /** 局部形变允许的最大 dof / 观测数 */
  maxWarpDofPerObservation: number;
  /** 倾角合法范围（degree） */
  tiltRangeDegree: [number, number];
  ruleVersion: string;
}

/* ------------------------------------------------------------------ */
/* 档案（dossier / 反例档案）                                          */
/* ------------------------------------------------------------------ */

export interface EntitySummary {
  ref: VersionedId;
  kind: SourceEntityKind | 'registration_candidate' | 'parameter_set';
  contentSha256: string;
  /** 内容摘要（不含字节体） */
  summary: Record<string, unknown>;
}

export interface CaseManifest {
  caseId: StableId;
  title: string;
  narrative: string;
  scenarioCodes: string[];
  steps: { stepId: string; label: string; kind: 'import' | 'parameter_revision' | 'source_change' | 'conflicting_decisions' }[];
  clipFiles: { sha256: string; file: string; byteLength: number }[];
  schemaFamily: string;
  schemaVersion: number;
}

export interface ExportBundle {
  schemaFamily: string;
  schemaVersion: number;
  exportedAt: string;
  caseId: StableId;
  blobs: { sha256: string; mediaType: string; bytesBase64: string }[];
  sourceRevisions: SourceRevision[];
  events: ArchiveEvent[];
  candidates: CandidateRecord[];
  parameterRevisions: (VersionedId & { parameters: RegistrationParameters })[];
  locks: LockRecord[];
}

export interface LockRecord {
  branchId: StableId;
  candidateRef: VersionedId;
  lockedAt: string;
  lockedBy: string;
  revoked: boolean;
  lockVersion: number;
}

/** 实体查询结果：必须回带引用版本号与内容摘要；缺引用 => CORRUPT */
export interface EntityQueryResult {
  ref: VersionedId;
  summary: EntitySummary;
  referencedVersions: VersionedId[];
}

export class CorruptArchiveError extends Error {
  code = 'CORRUPT_ARCHIVE';
  constructor(message: string, readonly missingRefs: VersionedId[] = []) {
    super(message);
  }
}

export class VersionConflictError extends Error {
  code = 'VERSION_CONFLICT';
  constructor(
    message: string,
    readonly expectedLockVersion: number,
    readonly actualLockVersion: number,
    readonly diff: Record<string, unknown>,
  ) {
    super(message);
  }
}
