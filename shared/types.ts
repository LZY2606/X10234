// 领域数据契约 —— 电子断层 / 倾转序列 / 配准审阅
// 所有领域量都携带单位或坐标基准；导入时保留原始表示，派生层才做规范化。

/** 原始表示：导入时逐字保留，不做换算 */
export interface RawQuantity {
  raw: string;            // 原始文本，例如 "0.42 nm/px"、"3.1 e-/A2"、"1.7e2 e-/sqA"
  basis?: string;         // 坐标基准，例如 "image"（像素坐标，原点在探测器左上角）
}

/** 规范化后的量（派生层产物） */
export interface Quantity {
  value: number;
  unit: string;           // 规范单位：nm/px | deg | e-/A2 | px
  basis?: string;
}

/** 倾斜帧（原始帧元数据；像素内容存于 blob，按内容哈希引用） */
export interface TiltFrame {
  frameIndex: number;
  tiltAngle: RawQuantity;      // 倾角，deg
  exposureDose: RawQuantity;   // 曝光剂量，e-/A2
  imageHash: string;           // 原始帧字节的内容哈希（不可变）
}

/**  tilt-series 输入实体 */
export interface TiltSeriesSource {
  kind: 'tilt-series';
  seriesId: string;
  pixelSize: RawQuantity;      // 像素尺度，nm/px
  frames: TiltFrame[];
}

/** fiducial 标记点坐标（图像坐标系，可断裂、可身份交换） */
export interface FiducialObservation {
  frameIndex: number;
  x: RawQuantity;              // px, basis=image
  y: RawQuantity;
}

export interface Tracklet {
  trackletId: string;
  points: FiducialObservation[];
  gapAfter?: { frames: number[]; reason: string };  // 跟踪缺口
}

export interface FiducialTrackSet {
  kind: 'fiducial-tracks';
  trackSetId: string;
  tracklets: Tracklet[];
  /** 跟踪缺口登记表（版本化） */
  trackingGaps: { trackletId: string; frames: number[]; reason: string }[];
  /** 可能的身份交换：tracklet A 在 frame k 结束、B 在 k+1 接续 */
  identitySwapHints: { a: string; b: string; atFrame: number }[];
}

/** 手工排除原因（版本化） */
export interface ManualExclusionSet {
  kind: 'manual-exclusions';
  exclusions: { frameIndex: number; reason: string; decidedBy: string }[];
}

export type SourcePayload = TiltSeriesSource | FiducialTrackSet | ManualExclusionSet;

/** 配准参数：倾转轴是自由参数，绝不默认固定在图像中心 */
export interface AlignmentParams {
  tiltAxis: { angleDeg: number; offsetPx: number; fixedToImageCenter: false };
  model: 'rigid' | 'local-deformation' | 'exclude-bad-frames';
  excludedFrames: number[];
  localDeformation?: { controlPointSpacingPx: number };
}

/** 配准候选 */
export interface AlignmentCandidate {
  candidateId: string;
  model: AlignmentParams['model'];
  params: AlignmentParams;
  /** 有效点集哈希：不同候选必须用相同有效点集比较，不用少帧换低残差 */
  effectivePointSetHash: string;
  effectivePointCount: number;
  perFrameResiduals: { frameIndex: number; residualPx: number }[];
  meanResidualPx: number;
}

export interface Diagnostic {
  code: string;
  message: string;
  path?: string;        // 无法转换的值留在原位置，path 指向原位置
}

export const RULESET_VERSION = 'ruleset/1.1.0';
