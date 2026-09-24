import type { DomainQuantity, PointXY } from '../shared/model';

export interface FrameSpec {
  frameId: string;
  index: number;
  tiltDeg: number;            // 真实倾角
  pixelSize: number;          // angstrom/pixel（名义，允许来源层异常值）
  dose: number;               // e-/A^2
  width: number;
  height: number;
  excluded?: boolean;
  excludeReason?: string;
  missing?: boolean;          // 缺失（尤其高倾角）
  bad?: boolean;              // 坏帧
  rippleN?: number;           // 仅局部帧存在的法向涟漪（诱发局部形变过拟合）
  presentTracks: string[];    // 该帧可见轨迹
}

export interface TrackSpec {
  trackId: string;
  u0: number;                 // 沿轴坐标（像素）
  z: number;                  // 深度，决定随倾角的法向运动
  gaps: { from: string; to: string; reason: string }[];
  // 轨迹身份交换：在某帧处该 track 的观测被错接到另一 track
  swapAfterFrame?: string;
  swapTargetId?: string;     // 被错接到的轨迹身份
}

export interface CaseGeometry {
  axisAngleDeg: number;       // 真实轴角（偏心）
  axisOffsetPx: number;       // 真实轴线偏心，非 0
  imageCenter: PointXY;
  noisePx: number;
  badShiftPx: number;
}

export interface CaseSpec {
  caseId: string;
  title: string;
  frames: FrameSpec[];
  tracks: TrackSpec[];
  geometry: CaseGeometry;
  pixelQuantity: DomainQuantity;
}
