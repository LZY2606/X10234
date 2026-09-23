// 领域类型：全部使用电子断层领域词汇，所有量携带单位或坐标基准。

export type Quantity = { value: number; unit: string };

export type ImagePoint = {
  x: number;
  y: number;
  unit: 'px';
  frame: 'image'; // 坐标基准：图像像素坐标系，原心在左上
};

export type SourceKind =
  | 'raw_frames'        // 原始帧
  | 'tilt_angles'       // 倾角
  | 'pixel_scale'       // 像素尺度
  | 'exposure_dose'     // 曝光剂量
  | 'fiducial_coordinates' // 标记点坐标
  | 'tracking_gaps'     // 跟踪缺口
  | 'manual_exclusions'; // 手工排除原因

export const SOURCE_KINDS: SourceKind[] = [
  'raw_frames',
  'tilt_angles',
  'pixel_scale',
  'exposure_dose',
  'fiducial_coordinates',
  'tracking_gaps',
  'manual_exclusions'
];

// ---- 各来源版本的内容模式（领域词汇，不压成 name/value） ----

export type RawFramesContent = {
  kind: 'raw_frames';
  frames: Array<{
    frame_id: string;
    index: number;
    width: number;
    height: number;
    pixels: number[][]; // 行主序强度
    intensity_unit: string;
  }>;
};

export type TiltAnglesContent = {
  kind: 'tilt_angles';
  angles: Array<{ frame_id: string; tilt: Quantity }>; // 规范化为 deg
};

export type PixelScaleContent = {
  kind: 'pixel_scale';
  pixel: Quantity; // nm/px 或 A/px
};

export type ExposureDoseContent = {
  kind: 'exposure_dose';
  doses: Array<{ frame_id: string; dose: Quantity }>; // e-/A^2；不可转换的保留原样
};

export type FiducialCoordinatesContent = {
  kind: 'fiducial_coordinates';
  tracks: Array<{
    track_id: string;
    observations: Array<{ frame_id: string; position: ImagePoint }>;
  }>;
};

export type TrackingGapsContent = {
  kind: 'tracking_gaps';
  gaps: Array<{ track_id: string; from_frame: string; to_frame: string; reason: string }>;
};

export type ManualExclusionsContent = {
  kind: 'manual_exclusions';
  exclusions: Array<{ frame_id: string; reason: string; decided_by: string }>;
};

export type SourceContent =
  | RawFramesContent
  | TiltAnglesContent
  | PixelScaleContent
  | ExposureDoseContent
  | FiducialCoordinatesContent
  | TrackingGapsContent
  | ManualExclusionsContent;

// ---- 解释（分支）参数 ----

export type AxisMode = 'free' | 'center'; // 倾转轴可偏心；禁止默认固定在图像中心
export type FramePolicy = 'all' | 'exclude_flagged';
export type ModelKind = 'rigid' | 'local_deform' | 'robust_exclusion';

export type InterpretationParams = {
  axisMode: AxisMode;
  framePolicy: FramePolicy;
  models: ModelKind[];
  allowAmbiguous?: boolean;
};

export type CandidateStatus = 'proposed' | 'adopted' | 'rejected';

export type Diagnostic = {
  code: string;
  message: string;
  at?: string; // 位置（如 frame_id / track_id）
  raw?: unknown; // 无法转换的原始值留在原位置
};
