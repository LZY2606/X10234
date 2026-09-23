// 领域类型：所有领域量都携带单位或坐标基准。
export interface Quantity {
  value: number;
  unit: string; // 例如 "degree" | "angstrom/pixel" | "e-/A^2" | "pixel"
}

export interface Vec2 {
  x: number;
  y: number;
  basis: string; // 坐标基准，例如 "pixel-topleft"
}

export type EntityKind =
  | 'tilt-series'
  | 'fiducial-tracks'
  | 'alignment-params'
  | 'alignment-candidate';

export interface TiltFrame {
  index: number;
  tiltAngle: Quantity;
  dose: Quantity | { raw: string }; // 无法转换的值留在原位置
  imageRef: string; // raw blob hash
  excluded?: { reason: string; by: string };
}

export interface TiltSeriesData {
  kind: 'tilt-series';
  seriesId: string;
  pixelSize: Quantity;
  tiltAxis: { angle: Quantity; offset: Quantity }; // offset 相对图像中心，单位 pixel
  frames: TiltFrame[];
}

export interface TrackPoint {
  frame: number;
  pos: Vec2;
}

export interface FiducialTrack {
  trackId: string;
  points: TrackPoint[];
  gapsAfter: number[]; // 轨迹在这些帧之后断裂
}

export interface FiducialTracksData {
  kind: 'fiducial-tracks';
  tracks: FiducialTrack[];
  identitySwaps: { atFrame: number; trackA: string; trackB: string }[];
}

export interface AlignmentParamsData {
  kind: 'alignment-params';
  axisFixedAtCenter: boolean; // 规则：不允许默认固定在图像中心
  maxIterations: number;
  localDeformControlPoints: number;
}

export interface CandidateResidual {
  frame: number;
  residual: Quantity; // 单位 pixel
}

export type CandidateMethod = 'rigid' | 'local-deform' | 'exclude-bad-frames';
export type CandidateStatus = 'open' | 'accepted' | 'rejected' | 'undecided' | 'locked';

export interface AlignmentCandidateData {
  kind: 'alignment-candidate';
  method: CandidateMethod;
  label: string;
  usesFrames: number[];
  usesTracks: string[];
  residuals: CandidateResidual[];
  status: CandidateStatus;
}

export type EntityData =
  | TiltSeriesData
  | FiducialTracksData
  | AlignmentParamsData
  | AlignmentCandidateData;

export interface DepRef {
  entityId: string;
  version: number;
}

export interface EntityView {
  entityId: string;
  kind: EntityKind;
  branchId: string;
  version: number;
  digest: string;
  refs: { hash: string; digest: string; mediaType: string }[];
  deps: DepRef[];
  data: EntityData;
  createdAt: string;
}
