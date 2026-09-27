/**
 * 领域词汇表：电子断层 / 倾转序列 / 配准。
 * 所有领域量携带单位或坐标基准；导入保留原始表示，派生层才规范化。
 * 禁止把这些实体压成 name/value。
 */

export type Uid = string;
export type ContentDigest = string;
export type EventId = number;
export type SemVer = string;

/** 坐标基准：像素坐标相对图像左上角，x 向右、y 向下；模型坐标以帧几何中心为原点。 */
export type CoordinateBasis =
  | 'image-pixel:top-left:x-right-y-down'
  | 'model-pixel:center'
  | 'raw-pixel:top-left';

/** 所有领域量的显式单位。unconverted 表示无法换算，必须留原位并附诊断。 */
export interface Unit {
  kind: 'angle' | 'length' | 'dose' | 'pixel' | 'dimensionless' | 'unconverted';
  name: string;
}

export interface Quantity {
  /** 原始表示，逐字保留 */
  raw: string;
  /** 规范化后的数值（无法换算时为 null） */
  value: number | null;
  unit: Unit;
  /** 无法转换时的诊断代码，例如 DOSE_UNIT_UNKNOWN */
  diagnostic?: string;
}

export const UNITS = {
  degree: { kind: 'angle', name: 'deg' },
  radian: { kind: 'angle', name: 'rad' },
  nanometer: { kind: 'length', name: 'nm' },
  angstrom: { kind: 'length', name: 'A' },
  electronDosePerArea: { kind: 'dose', name: 'e-/A^2' },
  pixel: { kind: 'pixel', name: 'px' },
  dimensionless: { kind: 'dimensionless', name: '1' },
  unconverted: (name: string): Unit => ({ kind: 'unconverted', name }),
} satisfies Record<string, Unit | ((name: string) => Unit)>;

/** 倾转轴参数。axisCenter 为其与图像的交点；offsetCenter 为图像几何中心。二者不必相同。 */
export interface TiltAxisParams {
  /** 相对图像 x 轴的夹角，单位 deg，图像像素坐标基准 */
  angleDeg: number;
  /** 轴在图像上的经过点（像素，图像基准）。默认不假设为图像中心。 */
  axisCenter: { x: number; y: number };
  /** 图像几何中心（像素，图像基准），用于计算偏心量 */
  frameCenter: { x: number; y: number };
  coordinateBasis: CoordinateBasis;
}

export function axisEccentricityPx(axis: TiltAxisParams): number {
  return Math.hypot(
    axis.axisCenter.x - axis.frameCenter.x,
    axis.axisCenter.y - axis.frameCenter.y,
  );
}

/** fiducial 轨迹段：同一物理标记的一段连续观测；轨迹可断裂，断裂后可身份交换。 */
export interface TrackSegment {
  trackId: Uid;
  /** 连续帧索引区间（含端点） */
  fromFrameIndex: number;
  toFrameIndex: number;
  /** 该段内标记观测：frameIndex -> 图像坐标（原始像素 + 规范化模型坐标） */
  observations: MarkerObservation[];
  /** 与下一段的连接状态：identity 为同一标记，swapped 为身份交换，gap 为跟踪缺口 */
  joinToNext: { kind: 'identity' } | { kind: 'swapped'; otherTrackId: Uid } | { kind: 'gap' };
}

export interface MarkerObservation {
  frameIndex: number;
  raw: { x: string; y: string; coordinateBasis: CoordinateBasis };
  /** 规范化模型坐标（无法换算则为 null，附 diagnostic） */
  normalized: { x: number; y: number } | null;
  diagnostic?: string;
}

export type FrameExclusionReason =
  | { kind: 'not-excluded' }
  | { kind: 'bad-frame'; manual: boolean; reason: string }
  | { kind: 'missing-high-tilt'; reason: string };

/** 原始帧实体（来源层，不可变；多个解释版本共享同一份字节） */
export interface RawFrame {
  frameIndex: number;
  width: number;
  height: number;
  /** 8-bit 灰度像素，raster order，row-major */
  blobDigest: ContentDigest;
  byteLength: number;
}

/** 单帧上的来源量：倾角、像素尺度、剂量、手工排除原因（各自独立版本化） */
export interface FrameProvenance {
  frameIndex: number;
  tiltAngle: Quantity;
  pixelScale: Quantity; // nm per px（图像平面）
  dose: Quantity; // e-/A^2
  exclusion: FrameExclusionReason;
}

/** 有效点集：候选打分只允许使用 (帧, 轨迹观测) 的同一集合，禁止用少帧换低残差 */
export interface EffectivePointSet {
  /** key = `${frameIndex}:${trackId}` */
  keys: string[];
  frameIndices: number[];
  description: string;
}

export type CandidateKind = 'rigid' | 'local-warp' | 'rigid-with-exclusions';

export interface PerFrameResidual {
  frameIndex: number;
  /** 加权 RMS，像素 */
  rmsPx: number;
  used: boolean;
  excludedReason?: string;
}

export interface RegistrationCandidate {
  candidateId: Uid;
  kind: CandidateKind;
  branchId: Uid;
  parentCandidateId: Uid | null;
  ruleVersion: SemVer;
  /** 该候选使用的有效点集身份（摘要） */
  pointSetDigest: ContentDigest;
  excludedFrameIndices: number[];
  tiltAxis: TiltAxisParams;
  residuals: PerFrameResidual[];
  score: {
    overallRmsPx: number;
    /** 在公共有效点集上重算的 RMS，供公平比较 */
    commonPointSetRmsPx: number;
    degreesOfFreedom: number;
    usedFrameCount: number;
    overfitFlag: boolean;
    ambiguityFlag: boolean;
  };
  diagnostics: Diagnostic[];
  /** 拟合出的模型，供叠影视图使用 */
  model: SerializedAlignmentModel;
}

export interface SerializedAlignmentModel {
  /** 每帧：平移（px，沿轴/离轴）、帧内微旋转（deg）；local-warp 额外含二次项 */
  perFrame: Array<{
    frameIndex: number;
    alongAxisShift: number;
    offAxisShift: number;
    inPlaneRotationDeg: number;
    warp?: { quadraticAlong: number; quadraticOff: number };
  }>;
  /** 轨迹身份裁定：观测段 -> 物理标记 id；交换会产生与原 trackId 不同的映射 */
  trackIdentity: Record<string, Uid>;
}

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  frameIndex?: number;
  trackId?: Uid;
}

export type AdjudicationOutcome = 'accepted' | 'rejected';

/** 裁定分支：接受/否定/参数调整都是新事件，可撤销恢复前一分支 */
export interface Adjudication {
  adjudicationId: Uid;
  candidateId: Uid;
  outcome: AdjudicationOutcome;
  note: string;
  /** 接受后形成供重建引用的稳定句柄 */
  reconstructionRef?: string;
  /** 撤销链：撤销时恢复到前一分支头 */
  undoneFromEventId?: EventId;
}

export interface DependencyEdge {
  fromEntity: string;
  fromVersion: EventId;
  toEntity: string;
  toVersion: EventId;
  /** local: 只影响局部依赖；global: 影响所有依赖该源的结论 */
  scope: 'local' | 'global';
}

/** 查询任一实体时的返回：稳定身份 + 引用版本 + 内容摘要 */
export interface EntityView {
  stableId: Uid;
  kind: string;
  version: EventId;
  contentDigest: ContentDigest;
  summary: Record<string, unknown>;
  references: Array<{ entity: string; version: EventId; digest: ContentDigest }>;
}
