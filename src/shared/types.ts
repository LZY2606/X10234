// 领域数据契约：直接采用电子断层 / tilt-series 词汇，不压成 name/value。
// 所有领域量携带单位或坐标基准；导入保留原始表示，派生层才规范化。

export type AngleUnit = 'degree' | 'radian';
export type LengthUnit = 'nm' | 'angstrom' | 'um';
export type DoseUnit = 'e/A^2' | 'e/nm^2';
export type CoordFrame = 'image_pixel' | 'stage';

// 带单位/基准的量：raw 保留导入原文，normalized 供派生层使用，转换失败留在原位并附诊断。
export interface Quantity<V = number, U = string> {
  raw: V;
  unit: U;
  basis?: CoordFrame;
  normalized?: number;
  normalizedUnit?: string;
  diagnostic?: string;
}

export interface PixelPoint {
  x: number; // image_pixel
  y: number; // image_pixel
  basis: 'image_pixel';
}

export interface RawBlobRef {
  logicalId: string;          // 案例内稳定逻辑名，如 FRAG_f00
  sha256: string;             // 不可变原始字节内容寻址
  mediaType: string;          // 如 application/x-tilt-frame（本仓库自定义原始容器）
  byteLength: number;
}

export interface FrameExposure {
  tilt: Quantity<number, AngleUnit>;
  dose: Quantity<number | null, DoseUnit>; // null 表示无法转换/读数缺失，留在原位附诊断
}

export interface TiltFrame {
  frameId: string;            // 稳定身份 f-XX
  sequence: number;           // 倾转序列顺序
  exposure: FrameExposure;
  raw: RawBlobRef | null;     // null = 声明缺失的高倾角槽位（占位，区别于坏帧）
  placeholder?: string;
}

export interface FiducialTrack {
  trackId: string;            // 稳定身份 trk-*
  marker?: string;            // 如 5nm gold bead
  segments: FiducialSegment[]; // 可断裂：多段
  gaps: TrackGap[];
}

export interface FiducialSegment {
  segmentId: string;
  fromFrameId: string;
  toFrameId: string;
  candidateIdentity?: string; // 可能身份交换：候选关联身份
  observations: MarkerObservation[];
}

export interface MarkerObservation {
  frameId: string;
  point: Quantity<PixelPoint, 'px'>;
}

export interface TrackGap {
  gapId: string;
  betweenFrameIds: [string, string];
  reason: string;             // 如 gold bead leaves field of view at high tilt
}

export interface ManualExclusion {
  exclusionId: string;
  frameId: string;
  reason: string;             // 手工排除原因（原始文本保留）
  kind: 'missing-slot' | 'bad-frame';
}

export interface TiltAxis {
  axisId: string;
  // 轴线偏心：允许偏离图像中心；centerAssumed 表示是否“默认固定在中心”的错误假设。
  offsetPx: { dx: number; dy: number };
  angleDeg: number;
  centerAssumed: boolean;
}

export interface TiltSeriesInput {
  caseId: string;
  revision: string;
  imageSize: { width: number; height: number };
  pixelSize: Quantity<number, LengthUnit>;
  axis: TiltAxis;
  frames: TiltFrame[];
  fiducials: FiducialTrack[];
  exclusions: ManualExclusion[];
}

export type FitScheme =
  | 'rigid'
  | 'local-warp'
  | 'badframe-excluded'
  | 'center-assumed-axis';

export interface EffectivePoint {
  frameId: string;
  trackId: string;
  p: PixelPoint;
  q: PixelPoint;
}

export interface RegistrationParams {
  rulesVersion: string;
  fitScheme: FitScheme;
  holdoutTrackIds: string[];
  extraExcludedFrameIds: string[];
  warpDegreesOfFreedom: number;
  ambiguityTolerancePx: number;
  dofPenalty: number;
  centerAssumed: boolean;
}

export interface FrameResidual {
  frameId: string;
  rms: number;
  usedPoints: number;
  role: 'reference' | 'fitted' | 'excluded' | 'missing' | 'not-present';
}

export interface RegistrationCandidate {
  candidateId: string;
  scheme: FitScheme;
  params: RegistrationParams;
  axisId: string;
  effectiveSetId: string;     // 相同有效点集比较的依据
  effectiveSet: EffectivePoint[];
  commonSetRms: number;       // 在“共同有效点集”上的公平 RMS
  trainRms: number;
  holdoutRms: number | null;
  dofPenalty: number;
  score: number;
  axisPenalty: number;
  excludedFrameIds: string[];
  perFrame: FrameResidual[];
  transforms: Record<string, AffineTransform>;
  ambiguousWith?: string[];   // 多解：同容差内同样合法的其它候选
  diagnostics: string[];
}

export interface AffineTransform {
  a: number; b: number; tx: number;
  c: number; d: number; ty: number;
}

export interface EventRecord {
  eventId: string;
  branch: string;
  seq: number;
  type: string;
  at: string;
  actor: string;
  payload: Record<string, unknown>;
  ruleVersion?: string;
  decisionId?: string;
}
