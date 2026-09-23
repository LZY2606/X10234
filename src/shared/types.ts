// 领域类型：电子断层 / 倾转序列 / 配准审阅
// 所有领域量都携带单位或坐标基准；原始表示在导入层保留，派生层才做规范化。

export type Unit =
  | 'deg'        // 倾角
  | 'nm/px'      // 像素尺度
  | 'e-/A^2'     // 曝光剂量
  | 'px'         // 像素坐标
  | 'nm'         // 物理长度
  | 'counts';    // 未标定计数（不可直接换算，保留原位并附诊断）

export type CoordFrame = 'image_px' | 'specimen_nm' | 'tilt_axis_local';

export interface Quantity<U extends Unit = Unit> {
  value: number;
  unit: U;
}

export interface FiducialPoint {
  trackId: string;          // fiducial 轨迹身份（可断裂、可身份交换）
  segmentId: string;        // 轨迹段：断裂处分段
  frameIndex: number;
  x: Quantity<'px'>;
  y: Quantity<'px'>;
  coordFrame: CoordFrame;
}

export interface TrackingGap {
  trackId: string;
  fromFrame: number;
  toFrame: number;
  reason: string;
}

export interface ExclusionReason {
  frameIndex: number;
  reason: string;           // 手工排除原因（人写）
  decidedBy: string;
}

export type RawKind =
  | 'raw_frames'
  | 'tilt_angles'
  | 'pixel_scale'
  | 'dose'
  | 'fiducial_points'
  | 'tracking_gaps'
  | 'exclusion_reasons';

export const RAW_KINDS: RawKind[] = [
  'raw_frames', 'tilt_angles', 'pixel_scale', 'dose',
  'fiducial_points', 'tracking_gaps', 'exclusion_reasons',
];

export interface SourceRef {
  id: string;
  version: number;
  digest: string;           // 内容摘要：查询时必须带回，缺引用即报损坏
}

// 倾转轴：不能被默认固定在图像中心 —— 偏心量是拟合参数
export interface TiltAxis {
  angle: Quantity<'deg'>;
  offsetX: Quantity<'px'>;   // 相对图像中心的偏心
  offsetY: Quantity<'px'>;
  fixedToCenter: false;       // 领域规则：永不为 true
}

export interface AlignmentParams {
  tiltAxis: TiltAxis;
  magnificationRotation: Quantity<'deg'>;
  allowLocalDeformation: boolean;
  maxLocalDeformNm: Quantity<'nm'>;  // 局部形变上限，防过拟合
}

export type CandidateKind = 'rigid' | 'local_deform' | 'exclude_bad_frames';

export interface EffectivePointSet {
  frameIndices: number[];     // 参与比较的有效帧
  trackIds: string[];         // 参与比较的有效轨迹
  digest: string;             // 同一比较下所有候选必须一致
}

export interface FrameResidual {
  frameIndex: number;
  rms: Quantity<'px'>;
  perTrack: Record<string, Quantity<'px'>>;
}

export type RationaleCode =
  | 'AXIS_ECCENTRIC'          // 轴线偏心
  | 'TRAJECTORY_IDENTITY_SWAP'// 轨迹身份交换
  | 'MISSING_HIGH_TILT'       // 缺失高倾角帧
  | 'BAD_FRAME_EXCLUSION'     // 坏帧排除
  | 'LOCAL_DEFORM_OVERFIT'    // 局部形变过拟合
  | 'MULTIPLE_SOLUTIONS'      // 多解
  | 'CONCURRENT_FREEZE';      // 并发冻结

export type ScenarioKind =
  | 'axis_eccentricity'
  | 'trajectory_identity_swap'
  | 'missing_high_tilt_frames'
  | 'bad_frame_exclusion'
  | 'local_deform_overfit'
  | 'multiple_solutions'
  | 'concurrent_freeze';

export const SCENARIOS: ScenarioKind[] = [
  'axis_eccentricity', 'trajectory_identity_swap', 'missing_high_tilt_frames',
  'bad_frame_exclusion', 'local_deform_overfit', 'multiple_solutions', 'concurrent_freeze',
];

export type DecisionKind = 'accept' | 'reject' | 'adjust' | 'lock' | 'unlock' | 'revert' | 'conflict_freeze';

export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  entityVersion: number | null;
  payload: T;
  createdAt: string;
}

export interface Diagnostic {
  code: 'UNIT_UNCONVERTIBLE' | 'MISSING_REFERENCE' | 'OUT_OF_RANGE' | 'GAP_IN_TRACK';
  message: string;
  location: string;           // 无法转换的值留在原位置并附诊断
  raw?: unknown;
}

export interface VersionConflict {
  entityType: string;
  entityId: string;
  baseVersion: number;
  currentVersion: number;
  theirs: unknown;            // 双方差异
  yours: unknown;
}
