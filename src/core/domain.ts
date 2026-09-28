/**
 * 倾转帧拼合室 —— 领域数据契约
 *
 * 设计原则：
 *  - 实体直接使用电子断层领域词汇（tilt frame / tilt angle / pixel scale / dose /
 *    fiducial track / tracking gap / manual exclusion），不压成 name/value。
 *  - 所有领域量携带单位或坐标基准（Quantity + datum），导入时保留原始表示，
 *    规范化只发生在派生层；无法转换的值留在原位置并附诊断。
 *  - 倾转轴不默认固定在图像中心；fiducial 轨迹可断裂、可发生身份交换。
 *  - 每个实体有稳定身份（stableId），并记录内容哈希（sha256）与版本号。
 */

// ---------------------------------------------------------------------------
// 量与单位：原始表示原样保留，派生层才规范化
// ---------------------------------------------------------------------------

/** 坐标基准：所有 fiducial 坐标必须声明，缺省即损坏 */
export type CoordinateDatum =
  | 'px/unbinned@raw-frame' // 原始未合并像素，帧左上为原点，y 向下
  | 'px/binned:1'
  | 'px/binned:2'
  | 'px/binned:4';

/** 倾转角约定 */
export type TiltAngleConvention =
  | 'degrees/signed/raw-stage' // 显微镜原始台倾转，带符号
  | 'degrees/signed/geometric'; // 几何约定（绕倾转轴右手系）

/** 剂量单位 */
export type DoseUnit = 'e-/A^2' | 'e-/nm^2' | 'counts/frame';
/** 像素尺度单位 */
export type PixelScaleUnit = 'A/pixel' | 'nm/pixel' | 'um/pixel';

/**
 * 带单位的量。raw 是显微镜导出的原文（数字 + 原文单位串），
 * normalized 仅在派生层可换算时填充；不可换算时 diagnostic 给出原因，
 * 值仍留在 raw 中，绝不删除。
 */
export interface Quantity<V = number> {
  rawValue: V;
  rawUnit: string; // 原文单位，逐字保留
  normalized?: { value: number; unit: string };
  conversionDiagnostic?: string;
}

// ---------------------------------------------------------------------------
// 稳定身份与版本
// ---------------------------------------------------------------------------

/** 跨导入/导出/删除重建保持不变的稳定身份前缀，见 id.ts */
export type StableId = string;

export interface VersionedRef {
  /** 被引用实体稳定身份 */
  stableId: StableId;
  /** 引用时锁定的版本号；解析必须取该版本，缺失 => 损坏，不允许回退最新 */
  version: number;
  /** 该版本内容摘要（sha256），用于完整性核对 */
  contentSha256?: string;
}

export interface ContentFingerprint {
  stableId: StableId;
  version: number;
  /** 规范化内容（去掉派生字段）的 sha256 */
  sha256: string;
  /** 供人/机快速核对的内容摘要（确定性字段子集） */
  summary: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 输入实体：全部版本化
// ---------------------------------------------------------------------------

export interface FrameDims {
  widthPx: number;
  heightPx: number;
}

/** 原始帧：像素字节不可变（以 blobId 引用内容寻址存储），不在库内就地改写 */
export interface TiltFrame {
  kind: 'TiltFrame';
  stableId: StableId; // frm_…
  version: number;
  /** 帧在倾转序列中的顺序位置（0 基），与倾角一一对应 */
  acquisitionIndex: number;
  /** 不可变原始像素内容 */
  blob: { blobId: string; sha256: string; byteLength: number; mediaType: string };
  dims: FrameDims;
  /** 帧内自带的曝光元数据（若有），原文保留 */
  headerNotes?: string;
  branchId: StableId;
}

/** 倾角（每帧一条；raw 原文保留，约定显式声明） */
export interface TiltAngle {
  kind: 'TiltAngle';
  stableId: StableId; // ang_…
  version: number;
  frameId: StableId;
  acquisitionIndex: number;
  angle: Quantity<number>;
  convention: TiltAngleConvention;
  branchId: StableId;
}

/** 像素尺度 */
export interface PixelScale {
  kind: 'PixelScale';
  stableId: StableId; // pxsc_…
  version: number;
  /** 空 stableId 表示全序列共用尺度；否则仅作用于单帧 */
  frameId: StableId | null;
  scale: Quantity<number>;
  branchId: StableId;
}

/** 曝光剂量 */
export interface ExposureDose {
  kind: 'ExposureDose';
  stableId: StableId; // dose_…
  version: number;
  frameId: StableId;
  acquisitionIndex: number;
  cumulative: Quantity<number>; // 累计剂量
  perFrame: Quantity<number>; // 单帧剂量
  branchId: StableId;
}

/** 单帧上的 fiducial 标记点观测坐标 */
export interface FiducialObservation {
  /** 该观测在本帧上的标记号（1 基，显微镜跟踪器输出） */
  markerLabel: number;
  x: number;
  y: number;
  datum: CoordinateDatum;
  /** 定位质量（原文保留，如相关系数）；可能缺失 */
  fitQuality?: number;
}

/**
 * fiducial 轨迹：同一物理金粒在各帧的观测。
 * 轨迹可断裂（segments 多段），且不同帧段之间可能发生身份交换——
 * identityLinks 记录“被判定为同一物理颗粒”的段间链接，每个链接可被推翻。
 */
export interface FiducialTrack {
  kind: 'FiducialTrack';
  stableId: StableId; // trk_…
  version: number;
  physicalBeadId: StableId; // bead_…（物理颗粒身份，与轨迹可分离）
  segments: TrackSegment[];
  /** 段间身份链接（断裂处的接续判定，可能被标记 swapped / rejected） */
  identityLinks: TrackIdentityLink[];
  branchId: StableId;
}

export interface TrackSegment {
  segmentId: StableId; // seg_…
  /** 连续 acquisitionIndex 区间 [from, to]，含端点 */
  indexRange: { from: number; to: number };
  observations: FiducialObservation[];
}

export type IdentityLinkStatus =
  | 'provisional' // 导入器初判
  | 'accepted' // 人工/规则确认同一颗粒
  | 'swapped' // 此处发生身份交换（两条轨迹在此帧交换了 marker label）
  | 'rejected'; // 判定不是同一颗粒（真断裂）

export interface TrackIdentityLink {
  linkId: StableId; // lnk_…
  fromSegmentId: StableId;
  toSegmentId: StableId;
  /** 断裂/交换发生在 gapFrameIndex（该帧无观测）前后 */
  gapFrameIndex: number;
  status: IdentityLinkStatus;
  reason?: string;
  /** 当 status=swapped 时，指向与之交换的另一条轨迹的链接 */
  swappedWithLinkId?: StableId;
}

/** 跟踪缺口：哪些帧缺失哪些标记的观测（区别于“有观测但坏”） */
export interface TrackingGap {
  kind: 'TrackingGap';
  stableId: StableId; // gap_…
  version: number;
  frameId: StableId;
  acquisitionIndex: number;
  missingMarkerLabels: number[];
  reason: Quantity<string> | null; // 原文原因，如 "out-of-field"；可空
  branchId: StableId;
}

/** 手工排除原因（不可由系统自动生成；必须有人与理由） */
export type ExclusionScope =
  | { scope: 'frame'; frameId: StableId }
  | { scope: 'track-segment'; trackId: StableId; segmentId: StableId }
  | { scope: 'observation'; trackId: StableId; frameId: StableId };

export interface ManualExclusion {
  kind: 'ManualExclusion';
  stableId: StableId; // exc_…
  version: number;
  target: ExclusionScope;
  reasonCode:
    | 'bad-frame/crack'
    | 'bad-frame/drift-burst'
    | 'bad-frame/focus-loss'
    | 'bad-frame/ice-contamination'
    | 'outlier-observation'
    | 'tracker-mislabel';
  /** 人工自由说明，原文保留 */
  note: string;
  /** 决定人（案例包中为角色名） */
  decidedBy: string;
  decidedAt: string; // ISO8601
  /** 撤销该排除的后续事件 id（未撤销为 null） */
  undoneByEventId: StableId | null;
  branchId: StableId;
}

/** 倾转序列：把上述材料装配为一个可审阅对象 */
export interface TiltSeries {
  kind: 'TiltSeries';
  stableId: StableId; // ts_…
  version: number;
  name: string;
  frameIds: StableId[]; // 按 acquisitionIndex 有序
  angleIds: StableId[];
  doseIds: StableId[];
  trackIds: StableId[];
  gapIds: StableId[];
  scaleIds: StableId[];
  exclusionIds: StableId[];
  /** 图像几何基准（像素坐标默认基准） */
  coordinateDatum: CoordinateDatum;
  branchId: StableId;
}

// ---------------------------------------------------------------------------
// 倾转轴：显式模型，绝不默认图像中心
// ---------------------------------------------------------------------------

export interface TiltAxisModel {
  kind: 'TiltAxisModel';
  stableId: StableId; // tax_…
  version: number;
  /** 轴线在参考帧（0° 最近帧）像素坐标中的截距点（轴线上一点） */
  pivot: { x: number; y: number; datum: CoordinateDatum };
  /** 轴线方向角（相对图像 +x 轴，度） */
  directionDeg: number;
  /**
   * pivot 相对图像中心的偏移（派生量，用于强调“不许默认中心”）。
   * null 表示尚不能计算（缺帧尺寸）。
   */
  eccentricityFromCenterPx: { x: number; y: number; magnitude: number } | null;
  /** 是否为未经数据支持、仅作初值的占位（true 时不得进入裁定比较） */
  assumedCenter: boolean;
  branchId: StableId;
}

// ---------------------------------------------------------------------------
// 配准候选与逐帧残差
// ---------------------------------------------------------------------------

export type TransformKind = 'rigid' | 'local-deform';

export interface RigidTransform {
  kind: 'rigid';
  /** 帧 -> 参考帧 的 2D 刚体参数（平移；旋转并入轴线模型后残差化） */
  tx: number;
  ty: number;
  rotationDeg: number;
}

/** 局部形变：分段仿射/网格（控制点），自由度更高，有过拟合风险 */
export interface LocalDeformTransform {
  kind: 'local-deform';
  /** 控制点网格上每点位移（未正则化时自由度 = 2*点数） */
  controlPoints: { x: number; y: number; dx: number; dy: number }[];
  gridCols: number;
  gridRows: number;
  regularization: number; // 0 表示无正则（高过拟合风险）
  dof: number;
}

export type FrameTransform = RigidTransform | LocalDeformTransform;

export interface PerFrameResidual {
  acquisitionIndex: number;
  frameId: StableId;
  /** 该帧所有有效观测到模型轨迹的 RMS 残差（px） */
  rmsPx: number;
  /** 最大单点残差（px） */
  maxPx: number;
  usedObservationCount: number;
  excluded: boolean;
}

export type CandidateStatus =
  | 'computed'
  | 'diagnostic'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'locked';

export interface RegistrationCandidate {
  kind: 'RegistrationCandidate';
  stableId: StableId; // cand_…
  version: number;
  label: string; // 例如 rigid-v1 / local-deform-v2 / drop-badframes-v1
  transformKind: TransformKind;
  /** 所依据的轴线模型版本引用 */
  axisRef: VersionedRef;
  /** 参与拟合的有效点集的规范指纹——公平比较的关键 */
  effectivePointSet: {
    /** 参与帧的 acquisitionIndex 集合（排除坏帧后的有效帧） */
    frameIndices: number[];
    /** 有效 (physicalBeadId, frameIndex) 观测集合的规范哈希 */
    pointSetSha256: string;
    observationCount: number;
  };
  transforms: Record<StableId, FrameTransform>; // frameId -> transform
  perFrame: PerFrameResidual[];
  /** 总体加权 RMS（px，规范化像素尺度基准） */
  aggregateRmsPx: number;
  /** 自由度（用于过拟合诊断） */
  totalDof: number;
  diagnostics: CandidateDiagnostic[];
  /** 多解标记：无法唯一决定时列出全部合法候选 stableId */
  ambiguityGroup?: { groupId: StableId; memberCandidateIds: StableId[] };
  status: CandidateStatus;
  /** 裁定事件引用 */
  decisionEventId?: StableId;
  branchId: StableId;
}

export interface CandidateDiagnostic {
  code:
    | 'axis/assumed-center'
    | 'axis/eccentric'
    | 'track/identity-swap'
    | 'frame/missing-high-tilt'
    | 'frame/excluded-bad'
    | 'local-deform/overfit'
    | 'solution/non-unique'
    | 'pointset/unequal-comparison'
    | 'input/unconvertible-quantity'
    | 'track/gap';
  severity: 'info' | 'warning' | 'error';
  message: string;
  affected: StableId[]; // 受影响对象 stableId
  evidenceRefs: VersionedRef[];
}

// ---------------------------------------------------------------------------
// 裁定 / 锁定（供重建引用）
// ---------------------------------------------------------------------------

export type DecisionKind = 'accept' | 'reject' | 'parameter-revision' | 'lock' | 'revert';

export interface AdjudicationDecision {
  kind: 'AdjudicationDecision';
  stableId: StableId; // dec_…
  version: number;
  decision: DecisionKind;
  candidateId: StableId | null; // lock/accept/reject 指向候选
  note: string;
  decidedBy: string;
  decidedAt: string;
  /** 乐观并发：基于的候选/序列状态版本 */
  expectedStateVersion: number;
  /** revert 时回退到的目标事件 id */
  revertToEventId?: StableId;
  /** 锁定后供重建引用的句柄（lock 时生成） */
  reconstructionHandle?: StableId; // rec_…
  branchId: StableId;
}

// ---------------------------------------------------------------------------
// 实体联合与查询返回
// ---------------------------------------------------------------------------

export type ArchiveEntity =
  | TiltFrame
  | TiltAngle
  | PixelScale
  | ExposureDose
  | FiducialTrack
  | TrackingGap
  | ManualExclusion
  | TiltSeries
  | TiltAxisModel
  | RegistrationCandidate
  | AdjudicationDecision;

export type EntityKind = ArchiveEntity['kind'];

/** 查询任一实体的返回：实体 + 它引用的版本号与内容摘要；缺引用即损坏 */
export interface EntityEnvelope {
  entity: ArchiveEntity;
  fingerprint: ContentFingerprint;
  /** 该实体版本引用到的全部版本化引用 */
  references: VersionedRef[];
  /** 解析失败（引用版本缺失/摘要不符）时的损坏报告，不退回最新版 */
  corruption: CorruptionReport | null;
}

export interface CorruptionReport {
  code: 'ref/missing-version' | 'ref/content-mismatch' | 'ref/dangling' | 'quantity/unconvertible';
  missingRef: VersionedRef;
  message: string;
}

// ---------------------------------------------------------------------------
// 坏帧 / 缺失 等反例触发所需要的帧分类
// ---------------------------------------------------------------------------

export type FrameRole = 'normal' | 'bad' | 'missing-high-tilt';
