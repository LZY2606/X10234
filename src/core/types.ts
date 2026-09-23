/**
 * 领域词汇数据契约（电子断层倾转序列配准）。
 * 禁止退化成 name/value 表；所有领域量携带单位或坐标基准。
 */

export type CoordinateBasis = 'pixels@raw-frame' | 'fraction-of-frame';
export type AngleUnit = 'degree';
export type LengthUnit = 'nanometer' | 'angstrom' | 'pixel';
export type DoseUnit = 'electron-per-angstrom-squared';
export type FrameId = string;
export type MarkerId = string;
export type TrackId = string;
export type CandidateId = string;
export type BranchId = string;
export type EventId = string;
export type SeriesId = string;

/** 带单位与坐标基准的标量；原始表示保留在 rawRepresentation。 */
export interface DimensionedValue {
  value: number;
  unit: string;
  coordinateBasis?: CoordinateBasis;
  rawRepresentation: string;
  diagnostic?: string;
}

/** 原始帧（不可变内容片段）。 */
export interface RawFrame {
  frameId: FrameId;
  acquisitionIndex: number;
  widthPx: number;
  heightPx: number;
  /** 合成/文件内容的稳定哈希 */
  contentHash: string;
  kind: 'micrograph' | 'dark-reference';
}

/** 倾角测量（角度单位显式）。 */
export interface TiltAngle {
  frameId: FrameId;
  angle: DimensionedValue; // unit: degree
}

/** 像素尺度（带物理单位）。 */
export interface PixelScale {
  frameId?: FrameId;
  scale: DimensionedValue; // unit: nanometer/pixel 等
}

/** 曝光剂量。 */
export interface ExposureDose {
  frameId: FrameId;
  dose: DimensionedValue; // unit: e-/Å^2
}

/** fiducial 标记点坐标（带坐标基准）。 */
export interface FiducialCoordinate {
  markerId: MarkerId;
  frameId: FrameId;
  x: DimensionedValue;
  y: DimensionedValue;
  /** 该点坐标是否在跟踪中缺失 */
  observed: boolean;
}

/** 跟踪缺口：某条轨迹在某帧缺失观测。 */
export interface TrackingGap {
  trackId: TrackId;
  frameId: FrameId;
  reason: 'out-of-field' | 'occluded' | 'low-contrast' | 'untracked';
}

/** 手工排除帧的原因（与算法排除分开）。 */
export interface ManualExclusion {
  frameId: FrameId;
  reason: string;
  decidedBy: string;
}

/** 轨迹片段：fiducial 轨迹可断裂；片段间可能发生身份交换。 */
export interface TrackSegment {
  trackId: TrackId;
  markerId: MarkerId;
  frameIdRange: [number, number]; // acquisition index 闭区间
  frames: FrameId[];
  /** 与另一片段发生身份交换的记录（互指） */
  identitySwapWith?: TrackId;
  identitySwapAtFrame?: FrameId;
}

/** 倾转轴：不允许默认固定在图像中心；由拟合给出并带不确定度。 */
export interface TiltAxisEstimate {
  /** 轴线与图像 x 轴夹角（度） */
  axisAngleDeg: number;
  /** 轴线在参考帧上的过点（像素），偏心即指此点偏离图像中心 */
  axisPointXPx: number;
  axisPointYPx: number;
  centered: boolean; // false 表示显式偏心
  uncertaintyPx: number;
  sourceCandidateId?: CandidateId;
}

export type RegistrationKind = 'rigid' | 'local-warp' | 'bad-frame-exclusion';

/** 一帧的刚体/形变参数。 */
export interface FrameTransform {
  frameId: FrameId;
  /** 相对参考帧：平移（像素）、旋转（度） */
  shiftXPx: number;
  shiftYPx: number;
  rotationDeg: number;
  /** 局部形变（local-warp 才有）：双线性残差位移幅度 */
  localWarpMagnitudePx?: number;
  excluded: boolean;
  exclusionReason?: string;
}

/** 每帧残差。 */
export interface PerFrameResidual {
  frameId: FrameId;
  rmsPx: number;
  maxPx: number;
  effectivePointCount: number;
  angleDeg: number;
}

/** 配准候选：多候选显式保存。 */
export interface RegistrationCandidate {
  candidateId: CandidateId;
  seriesId: SeriesId;
  kind: RegistrationKind;
  branchId: BranchId;
  ruleVersion: number;
  parameterRevision: number;
  frameTransforms: FrameTransform[];
  perFrameResidual: PerFrameResidual[];
  effectiveFrameIds: FrameId[];
  excludedFrameIds: FrameId[];
  tiltAxis: TiltAxisEstimate;
  summaryRmsPx: number;
  diagnostics: CandidateDiagnostic[];
  /** 多解标记：无法唯一决定时的全部合法候选 */
  ambiguityGroupId?: string;
  ambiguous: boolean;
  createdAt: string;
}

export type DiagnosticCode =
  | 'axis-off-center'
  | 'identity-swap-suspected'
  | 'missing-high-tilt-frame'
  | 'bad-frame-excluded'
  | 'local-warp-overfit'
  | 'multiple-solutions'
  | 'effective-set-mismatch'
  | 'fewer-frames-lower-residual-rejected';

export interface CandidateDiagnostic {
  code: DiagnosticCode;
  severity: 'info' | 'warning' | 'reject';
  message: string;
  affectedFrameIds: FrameId[];
  affectedTrackIds?: TrackId[];
}

/** 裁定（接受/否定/参数调整），可撤销，形成分支。 */
export interface Adjudication {
  eventId: EventId;
  branchId: BranchId;
  decision: 'accept' | 'reject' | 'parameter-adjustment';
  chosenCandidateId?: CandidateId;
  rejectedCandidateIds: CandidateId[];
  note: string;
  decidedBy: string;
  /** 撤销时指向前一分支头事件 */
  supersededBy?: EventId;
  createdAt: string;
}

/** 机器可读的判断依据事件。 */
export interface CriterionEvent {
  eventId: EventId;
  code:
    | 'axis-not-centered-by-default'
    | 'tracks-can-break-and-swap-identity'
    | 'compare-on-same-effective-point-set'
    | 'no-fewer-frames-for-lower-residual'
    | 'preserve-all-valid-candidates-when-ambiguous';
  detail: string;
  relatedCandidateIds: CandidateId[];
  createdAt: string;
}
