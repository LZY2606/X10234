import { createHash } from "node:crypto";
import type {
  FiducialObservation,
  RawFrame,
  TrackingGap,
  TiltAngle,
} from "./domain.js";

/** 帧合成与倾转投影几何（确定性，无随机源，最小/组合输入可复现）。 */

export const FRAME_W = 120;
export const FRAME_H = 96;

export interface Marker3D {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface SynthOptions {
  width?: number;
  height?: number;
  tiltAnglesDeg: number[];
  /** 投影中心（光轴落点）相对图像中心的偏移 —— 轴线偏心。 */
  centerShiftPx?: { x: number; y: number };
  /** 倾转轴在图像面内的角度（度）。 */
  axisAngleDeg?: number;
  markers: Marker3D[];
  /** 帧序号 -> 额外平移（坏帧抖动）。 */
  jitterBySeq?: Record<number, { x: number; y: number }>;
  /** 帧序号 -> 局部形变：标记点附加偏移。 */
  warpBySeq?: Record<number, { x: number; y: number }>;
  /** 缺失帧序号（缺失高倾角帧）。 */
  missingSeqs?: number[];
  /** 两条轨迹在某帧区间身份交换。 */
  swapTracks?: { trackA: string; trackB: string; fromSeq: number; toSeq: number };
  /** 某轨迹断裂区间（缺观测 + TrackingGap）。 */
  gap?: { trackId: string; fromSeq: number; toSeq: number };
  /** 序列采集顺序（如 dose-symmetric）；缺省按角度单调。 */
  acquisitionOrder?: number[];
}

const deg2rad = (d: number) => (d * Math.PI) / 180;

export interface SynthResult {
  frames: RawFrame[];
  tilts: TiltAngle[];
  observations: FiducialObservation[];
  gaps: TrackingGap[];
  presentSeqs: number[];
  blobBytesBySeq: Map<number, Buffer>;
}

/** 单个 fiducial 在给定倾角下的投影像素坐标。 */
export function projectMarker(
  marker: Marker3D,
  thetaDeg: number,
  centerShiftPx: { x: number; y: number },
  axisAngleDeg: number,
  width: number,
  height: number
): { x: number; y: number } {
  const theta = deg2rad(thetaDeg);
  // 绕倾转轴旋转后的坐标（轴沿图像 x' 方向）
  const xp = marker.x;
  const yp = marker.y * Math.cos(theta) - marker.z * Math.sin(theta);
  // 轴线在图像面内有方向角时旋转回图像坐标
  const a = deg2rad(axisAngleDeg);
  const xr = xp * Math.cos(a) - yp * Math.sin(a);
  const yr = xp * Math.sin(a) + yp * Math.cos(a);
  return {
    x: width / 2 + centerShiftPx.x + xr,
    y: height / 2 + centerShiftPx.y + yr,
  };
}

/** 合成 8-bit 灰度帧字节：暗背景 + 亮 fiducial 投影斑 + 轻微剂量相关噪声。 */
export function renderFrame(
  width: number,
  height: number,
  spots: Array<{ x: number; y: number; intensity: number }>,
  angleDeg: number,
  cumulativeDose: number
): Buffer {
  const buf = Buffer.alloc(width * height, 8);
  for (const spot of spots) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const px = Math.round(spot.x + dx);
        const py = Math.round(spot.y + dy);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > 4) continue;
        const v = Math.min(255, 20 + spot.intensity * Math.exp(-d2 / 2.2));
        buf[py * width + px] = Math.max(buf[py * width + px], Math.round(v));
      }
    }
  }
  // 剂量相关的确定性底纹（证明帧字节随剂量变化且可复现）
  const band = Math.round((Math.sin(angleDeg * 0.7) + 1) * 4 + cumulativeDose * 0.4) % 7;
  for (let i = 0; i < buf.length; i += 137) {
    buf[i] = Math.min(255, buf[i] + band);
  }
  return buf;
}

export function synthesize(opts: SynthOptions): SynthResult {
  const width = opts.width ?? FRAME_W;
  const height = opts.height ?? FRAME_H;
  const centerShift = opts.centerShiftPx ?? { x: 0, y: 0 };
  const axisAngle = opts.axisAngleDeg ?? 0;
  const missing = new Set(opts.missingSeqs ?? []);

  const order = opts.acquisitionOrder ?? opts.tiltAnglesDeg.map((_, i) => i);
  const presentSeqs = opts.tiltAnglesDeg.map((_, i) => i).filter((s) => !missing.has(s));

  const frames: RawFrame[] = [];
  const tilts: TiltAngle[] = [];
  const observations: FiducialObservation[] = [];
  const gaps: TrackingGap[] = [];
  const blobBytesBySeq = new Map<number, Buffer>();

  // 轨迹分段身份：默认 "seg-A"，缺口后变 "seg-B"，交换区间另给身份。
  const segmentFor = (trackId: string, seq: number): string => {
    if (opts.swapTracks) {
      const { trackA, trackB, fromSeq, toSeq } = opts.swapTracks;
      if (seq >= fromSeq && seq <= toSeq && (trackId === trackA || trackId === trackB)) {
        return `seg-${trackId === trackA ? trackB : trackA}-x`;
      }
    }
    if (opts.gap && trackId === opts.gap.trackId) {
      return seq >= opts.gap.toSeq ? "seg-B" : "seg-A";
    }
    return "seg-A";
  };

  let cumDose = 0;
  for (const seq of presentSeqs) {
    const angle = opts.tiltAnglesDeg[seq];
    const acquisitionIndex = order.indexOf(seq);
    cumDose += 2.0 * Math.abs(Math.cos(deg2rad(angle))) + 0.4;
    const frameId = `frame-s${seq}`;
    const spots: Array<{ x: number; y: number; intensity: number }> = [];

    for (const marker of opts.markers) {
      // 该观测实际挂在哪条轨迹上（身份交换只改轨迹归属，不改物理点）
      let trackId = marker.id;
      if (opts.swapTracks && seq >= opts.swapTracks.fromSeq && seq <= opts.swapTracks.toSeq) {
        if (marker.id === opts.swapTracks.trackA) trackId = opts.swapTracks.trackB;
        else if (marker.id === opts.swapTracks.trackB) trackId = opts.swapTracks.trackA;
      }
      // 缺口轨迹在断裂区间不给观测
      if (
        opts.gap &&
        marker.id === opts.gap.trackId &&
        seq >= opts.gap.fromSeq &&
        seq < opts.gap.toSeq
      ) {
        continue;
      }
      const p = projectMarker(marker, angle, centerShift, axisAngle, width, height);
      const jitter = opts.jitterBySeq?.[seq];
      const warp = opts.warpBySeq?.[seq];
      const x = p.x + (jitter?.x ?? 0) + (warp?.x ?? 0);
      const y = p.y + (jitter?.y ?? 0) + (warp?.y ?? 0);
      spots.push({ x, y, intensity: marker.id === opts.gap?.trackId ? 150 : 190 });
      observations.push({
        id: `obs-${trackId}-s${seq}`,
        trackId,
        segmentId: segmentFor(marker.id, seq),
        frameId,
        xPx: round4(x),
        yPx: round4(y),
        rawX: x.toFixed(3),
        rawY: y.toFixed(3),
        confidence: jitter ? 0.35 : 0.9,
      });
    }

    const bytes = renderFrame(width, height, spots, angle, cumDose);
    blobBytesBySeq.set(seq, bytes);
    const blobId = "blob-" + createHash("sha256").update(bytes).digest("hex").slice(0, 16);

    frames.push({
      id: frameId,
      seq,
      blobId,
      widthPx: width,
      heightPx: height,
      rawLabel: `tilt_${String(acquisitionIndex + 1).padStart(3, "0")}.mrc`,
    });
    tilts.push({
      id: `tilt-s${seq}`,
      frameId,
      angle: { value: angle, unit: "degree", raw: `${angle}.0` },
      tiltScheme: "dose-symmetric",
    });
  }

  if (opts.gap) {
    const { trackId, fromSeq, toSeq } = opts.gap;
    gaps.push({
      id: `gap-${trackId}-s${fromSeq}-s${toSeq - 1}`,
      trackId,
      segmentBeforeId: "seg-A",
      segmentAfterId: "seg-B",
      fromFrameId: `frame-s${fromSeq - 1}`,
      toFrameId: `frame-s${toSeq}`,
      reason: "fiducial 离开视场后重新进入，自动跟踪中断",
    });
  }

  return { frames, tilts, observations, gaps, presentSeqs, blobBytesBySeq };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
