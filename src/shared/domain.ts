/**
 * 倾转帧拼合室 —— 领域数据契约
 *
 * 所有领域量都携带单位或坐标基准；导入时保留 original 原始表示，
 * 规范化只发生在派生层（registration.ts）。无法转换的值留在原位置并附诊断。
 * 这里显式使用电镜断层领域词汇（倾角、像素尺度、剂量、fiducial 标记、轨迹缺口……），
 * 不使用 name/value 式的通用压缩。
 */

export const SCENARIO_TAGS = [
  'axis-offset',
  'track-identity-swap',
  'missing-high-tilt',
  'bad-frame-exclusion',
  'local-warp-overfit',
  'multi-solution',
  'concurrent-freeze',
] as const;
export type ScenarioTag = (typeof SCENARIO_TAGS)[number];

export type AngleUnit = 'degree' | 'radian';
export type LengthUnit = 'nm' | 'angstrom' | 'pixel';
export type DoseUnit = 'e-/A^2' | 'e-/nm^2' | 'counts';

/** 角度；coordinateFrame 标明来源基准（样品台测角器读数），original 保留原始记法 */
export interface TiltAngle {
  frameId: string;
  value: number;
  unit: AngleUnit;
  original?: string;
  coordinateFrame: 'goniometer-stage';
}

/** 像素尺度，x/y 分别给长度量纲；physicalBasis 记录标定来源 */
export interface PixelScale {
  frameId: string;
  x: { value: number; unit: LengthUnit; original?: string };
  y: { value: number; unit: LengthUnit; original?: string };
  physicalBasis: 'calibration-metadata' | 'manual-override' | 'unknown';
}

/** 每帧曝光剂量 */
export interface ExposureDose {
  frameId: string;
  value: number;
  unit: DoseUnit;
  original?: string;
}

/** 图像像素坐标，坐标基准固定为左上角原点、像素单位 */
export interface PixelPoint {
  x: number;
  y: number;
  coordinateFrame: 'image-pixels';
  origin: 'top-left';
}

export type GapReason = 'out-of-field' | 'occluded' | 'tracker-lost' | 'high-tilt-missing-frame';

/** 一帧上某个跟踪标签的观测；observed=false 表示跟踪缺口 */
export interface MarkerObservation {
  trackId: string;
  frameId: string;
  point: PixelPoint;
  observed: boolean;
  gapReason?: GapReason;
}

export type ExclusionTarget =
  | { kind: 'frame'; frameId: string }
  | { kind: 'marker'; trackId: string; frameId: string };

export interface ManualExclusion {
  target: ExclusionTarget;
  reasonCode: string;
  reasonText: string;
  decidedBy: string;
}

/** 倾转轴：显式给出，绝不默认图像中心。source 标明来源 */
export interface AxisSpec {
  axisId: string;
  /** 轴线经过的像素点（坐标基准 image-pixels / top-left） */
  pivot: PixelPoint;
  /** 轴线在图像内的方向角（相对图像 +x 轴，单位 degree） */
  directionDeg: number;
  source: 'microscope-metadata' | 'manual-parameter' | 'fiducial-fit';
  lockedToImageCenter: boolean;
}

export type EntityKind =
  | 'raw-frame'
  | 'tilt-angle'
  | 'pixel-scale'
  | 'exposure-dose'
  | 'marker-observation'
  | 'tracking-gap'
  | 'manual-exclusion';

export interface RawFrameEntity {
  kind: 'raw-frame';
  seq: number;
  contentSha: string;
  media: 'image/x-portable-graymap';
  width: number;
  height: number;
  originalFileName: string;
}
export interface TiltAngleEntity {
  kind: 'tilt-angle';
  frameId: string;
  angle: TiltAngle;
}
export interface PixelScaleEntity {
  kind: 'pixel-scale';
  frameId: string;
  scale: PixelScale;
}
export interface ExposureDoseEntity {
  kind: 'exposure-dose';
  frameId: string;
  dose: ExposureDose;
}
export interface MarkerObservationEntity {
  kind: 'marker-observation';
  trackId: string;
  frameId: string;
  observation: MarkerObservation;
}
export interface TrackingGapEntity {
  kind: 'tracking-gap';
  trackId: string;
  fromSeq: number;
  toSeq: number;
  reason: GapReason;
}
export interface ManualExclusionEntity {
  kind: 'manual-exclusion';
  exclusion: ManualExclusion;
}

export type InputEntityPayload =
  | RawFrameEntity
  | TiltAngleEntity
  | PixelScaleEntity
  | ExposureDoseEntity
  | MarkerObservationEntity
  | TrackingGapEntity
  | ManualExclusionEntity;

export interface InputEntity {
  id: string;
  version: number;
  payload: InputEntityPayload;
}

/** 导入清单中的二进制引用（相对案例目录 + 校验和） */
export interface BlobSpec {
  sha256: string;
  path: string;
  media: 'image/x-portable-graymap';
}

/** 案例包里一次导入的最小/组合输入（电镜小组的材料语言） */
export interface CaseBundle {
  tool: 'tilt-frame-room';
  caseCode: string;
  title: string;
  scope: 'minimal' | 'combined';
  scenarioTags: ScenarioTag[];
  narrativeStep: number;
  blobs: BlobSpec[];
  frames: Array<{ id: string; seq: number; contentSha: string; width: number; height: number; originalFileName: string }>;
  tiltAngles: TiltAngle[];
  pixelScales: PixelScale[];
  doses: ExposureDose[];
  markers: MarkerObservation[];
  trackingGaps: Array<{ trackId: string; fromSeq: number; toSeq: number; reason: GapReason }>;
  exclusions: ManualExclusion[];
  axisHints: AxisSpec[];
  /** 组合输入引用的最小输入片段（同一 blob 只存一份不可变内容） */
  sharedWith?: string[];
}

/** 无法转换/无法规范化的领域值留在原位并附诊断 */
export interface ValueDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  entityId?: string;
  field?: string;
  message: string;
}

export function toDegrees(a: TiltAngle): number {
  return a.unit === 'degree' ? a.value : (a.value * 180) / Math.PI;
}

export function pixelLengthToNm(v: { value: number; unit: LengthUnit }): number | null {
  if (v.unit === 'nm') return v.value;
  if (v.unit === 'angstrom') return v.value / 10;
  return null; // 像素无法在没有标定时转物理长度：留在派生层处理
}
