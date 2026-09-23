import type {
  Dose,
  FiducialObservation,
  ManualExclusion,
  PixelScale,
  RawFrame,
  Quantity,
  TiltAngle,
  TrackingGap
} from "../shared/types";
import { SERIES_ID, frameId, obsId, segmentId, trackId } from "../shared/ids";
import { contentHash, sha256 } from "../shared/hash";
import {
  Marker3D,
  projectMarker,
  renderFrame,
  seededRng,
  gaussian,
  Axis2D
} from "./geometry";
import { encodeGrayPng } from "./png";

export const FRAME_W = 160;
export const FRAME_H = 120;
export const TRUE_AXIS: Axis2D = { directionDeg: 18, anchor: { x: 68, y: 54 } };

/** 仪器日志错误默认：把轴锚死在图像中心（反例：轴线偏心）。 */
export const INSTRUMENT_CENTER_AXIS = {
  kind: "tiltAxis" as const,
  seriesId: SERIES_ID,
  directionDeg: 18,
  anchored: true,
  anchor: {
    x: FRAME_W / 2,
    y: FRAME_H / 2,
    basis: { kind: "image-pixel-grid", origin: "top-left", unit: "pixel" as const }
  },
  anchorProvenance: { source: "instrument-log" as const, refs: [] }
};

interface MarkerDef extends Marker3D {}

const DEMO_MARKERS: MarkerDef[] = [
  { trackId: trackId(1), a: -42, q: -18, h: -14 },
  { trackId: trackId(2), a: -10, q: 22, h: 16 },
  { trackId: trackId(3), a: 26, q: -8, h: 24 },
  { trackId: trackId(4), a: 46, q: 14, h: -22 },
  { trackId: trackId(5), a: 6, q: -30, h: 8 },
  { trackId: trackId(6), a: -30, q: 30, h: -4 }
];

export interface AcquisitionSpec {
  id: string;
  seriesId: string;
  tilts: number[];
  markers: MarkerDef[];
  axis: Axis2D;
  /** 确定性漂移曲线（px）。 */
  drift?: (index: number, tilt: number) => { dx: number; dy: number };
  noisePx?: number;
  seed: number;
  /** 跟踪缺口：trackId -> 缺失帧索引集合。 */
  gaps?: Record<string, number[]>;
  /** 身份交换：trackId 在这些帧索引起把观测挂到 partnerTrack。 */
  swaps?: { fromIndex: number; pair: [string, string] }[];
  /** 坏帧：帧索引 -> 原因。 */
  badFrames?: Record<number, { reasonCode: ManualExclusion["reasonCode"]; reason: string; blur: boolean }>;
  /** 高倾角整帧缺失（无 rawFrame）：帧索引集合。 */
  missingFrames?: number[];
  /** 不可转换的坏剂量：帧索引 -> 原始原始字符串。 */
  badDoseRaw?: Record<number, string>;
  /** 观测离群点：帧索引 -> 受影响 track 偏移，驱动局部形变过拟合。 */
  outliers?: Record<number, { track: string; dx: number; dy: number }[]>;
  width?: number;
  height?: number;
}

export interface GeneratedFrame extends RawFrame {
  png: Buffer;
  tiltDeg: number;
  driftX: number;
  driftY: number;
  blur: boolean;
}

export interface GeneratedAcquisition {
  spec: AcquisitionSpec;
  frames: GeneratedFrame[];
  angles: TiltAngle[];
  scales: PixelScale[];
  doses: (Dose & { invalid?: { raw: string; unit: string } })[];
  observations: FiducialObservation[];
  gaps: TrackingGap[];
  exclusions: ManualExclusion[];
  /** blob 去重映射 sha -> png。 */
  blobs: Map<string, Buffer>;
  markerPositions: { frameIndex: number; tilt: number; dots: { x: number; y: number; trackId: string }[] }[];
}

/** 计算某物理标记在某帧被跟踪成的 label（缺口后发生身份交换）。 */
function labelAtFrameFor(spec: AcquisitionSpec, markerTrack: string, frameIndex: number): string {
  let label = markerTrack;
  for (const sw of spec.swaps ?? []) {
    if (frameIndex < sw.fromIndex) continue;
    const [a, b] = sw.pair;
    if (label === a) label = b;
    else if (label === b) label = a;
  }
  return label;
}

/** 构造一次完整采集（帧 PNG、倾角、尺度、剂量、观测、缺口、排除）。 */
export function buildAcquisition(spec: AcquisitionSpec): GeneratedAcquisition {
  const width = spec.width ?? FRAME_W;
  const height = spec.height ?? FRAME_H;
  const rng = seededRng(spec.seed);
  const noise = spec.noisePx ?? 0.6;
  const missing = new Set(spec.missingFrames ?? []);
  const bad = spec.badFrames ?? {};
  const blobs = new Map<string, Buffer>();
  const frames: GeneratedFrame[] = [];
  const angles: TiltAngle[] = [];
  const scales: PixelScale[] = [];
  const doses: GeneratedAcquisition["doses"] = [];
  const observations: FiducialObservation[] = [];
  const markerPositions: GeneratedAcquisition["markerPositions"] = [];

  const presentIndices = spec.tilts.map((_, i) => i).filter((i) => !missing.has(i));

  // 每 track 每段帧计数（用于 segment 命名：缺口后换段）
  const segCounter: Record<string, number> = {};
  const lastSegTrack = new Map<string, { seg: number; frame: number }>();

  presentIndices.forEach((ordered, frameIndexFull) => {
    const tilt = spec.tilts[frameIndexFull];
    const drift = spec.drift ? spec.drift(frameIndexFull, tilt) : { dx: 0, dy: 0 };
    const blur = bad[frameIndexFull]?.blur ?? false;
    const dots: { x: number; y: number; trackId: string }[] = [];
    for (let mi = 0; mi < spec.markers.length; mi++) {
      const marker = spec.markers[mi];
      const ideal = projectMarker(marker, spec.axis, tilt);
      dots.push({ x: ideal.x, y: ideal.y, trackId: marker.trackId });
    }
    const gray = renderFrame({
      width,
      height,
      dots: dots.map((d) => ({ x: d.x, y: d.y })),
      driftX: drift.dx,
      driftY: drift.dy,
      blur,
      tiltDeg: tilt,
      seed: spec.seed + frameIndexFull
    });
    const png = encodeGrayPng(width, height, gray);
    const sha = sha256(png);
    blobs.set(sha, png);
    const fid = frameId(frameIndexFull);
    frames.push({
      kind: "rawFrame",
      seriesId: spec.seriesId,
      frameId: fid,
      frameIndex: frameIndexFull,
      sourceLabel: `${spec.id}/frame_${String(frameIndexFull).padStart(2, "0")}_${tilt >= 0 ? "p" : "m"}${Math.abs(tilt)}.png`,
      width,
      height,
      blobSha: sha,
      byteLength: png.length,
      pixelBasis: { kind: "image-pixel-grid", origin: "top-left", unit: "pixel" as const },
      png,
      tiltDeg: tilt,
      driftX: drift.dx,
      driftY: drift.dy,
      blur
    });

    const rawTilt = `${tilt}.000`;
    angles.push({
      kind: "tiltAngle",
      seriesId: spec.seriesId,
      frameId: fid,
      orderedIndex: ordered,
      angle: { value: tilt, unit: "degree" as const, raw: rawTilt }
    });

    // 剂量：累计 e/nm²；指定帧故意保留无法转换的原始表示
    const cumulativeDose = +(12 + ordered * 2.4 + Math.abs(tilt) * 0.05).toFixed(2);
    if (spec.badDoseRaw && spec.badDoseRaw[frameIndexFull] !== undefined) {
      const raw = spec.badDoseRaw[frameIndexFull];
      doses.push({
        kind: "dose",
        seriesId: spec.seriesId,
        frameId: fid,
        cumulative: true,
        dose: { value: NaN, unit: "dimensionless", raw },
        invalid: { raw, unit: "unknown-unit" }
      });
    } else {
      doses.push({
        kind: "dose",
        seriesId: spec.seriesId,
        frameId: fid,
        cumulative: true,
        dose: { value: cumulativeDose, unit: "e_per_nm2" as const, raw: `${cumulativeDose} e-/nm^2` }
      });
    }

    // 每个标记的观测：叠加观测噪声；应用身份交换标签与缺口
    const dotsWithTrack: { x: number; y: number; trackId: string }[] = [];
    for (let mi = 0; mi < spec.markers.length; mi++) {
      const marker = spec.markers[mi];
      // 在该帧，marker 当前被跟踪成哪个 label（缺口两侧交换）
      const labelAtFrame = labelAtFrameFor(spec, marker.trackId, frameIndexFull);
      const observedTrack = labelAtFrame;
      const missingTracks = spec.gaps ?? {};
      if ((missingTracks[marker.trackId] ?? []).includes(frameIndexFull)) continue;
      if ((missingTracks[observedTrack] ?? []).includes(frameIndexFull)) continue;
      const ideal = projectMarker(marker, spec.axis, tilt);
      let outlierX = 0;
      let outlierY = 0;
      for (const out of spec.outliers?.[frameIndexFull] ?? []) {
        // 离群按物理标记挂在当前 label 上
        if (out.track === marker.trackId) {
          outlierX = out.dx;
          outlierY = out.dy;
        }
      }
      const x = ideal.x + drift.dx + outlierX + gaussian(rng) * noise;
      const y = ideal.y + drift.dy + outlierY + gaussian(rng) * noise;
      // 跟踪缺口之后段号 +1（track 可断裂）；同一帧内保持一致
      const prev = lastSegTrack.get(observedTrack);
      let segNum = prev?.seg ?? 0;
      if (prev && (spec.gaps?.[observedTrack] ?? []).some((g) => g > prev.frame && g <= frameIndexFull)) {
        segNum = prev.seg + 1;
      }
      lastSegTrack.set(observedTrack, { seg: segNum, frame: frameIndexFull });
      const seg = segmentId(observedTrack, segNum);
      observations.push({
        kind: "fiducialObservation",
        seriesId: spec.seriesId,
        frameId: fid,
        observationId: obsId(observedTrack, fid),
        trackId: observedTrack,
        segmentId: seg,
        position: {
          x: +x.toFixed(3),
          y: +y.toFixed(3),
          basis: { kind: "image-pixel-grid", origin: "top-left", unit: "pixel" as const }
        }
      });
      dotsWithTrack.push({ x, y, trackId: observedTrack });
    }
    markerPositions.push({ frameIndex: frameIndexFull, tilt, dots: dotsWithTrack });
  });

  // 像素尺度：nm/px 与个别 Å/px 表示（保留原始串）
  scales.push({
    kind: "pixelScale",
    seriesId: spec.seriesId,
    scale: { value: 0.84, unit: "nm_per_pixel" as const, raw: "0.84 nm/pixel" }
  });

  // 跟踪缺口：依据 gaps 声明构造断裂（前后段）
  const gaps: TrackingGap[] = [];
  for (const [track, idxs] of Object.entries(spec.gaps ?? {})) {
    const sorted = [...idxs].sort((a, b) => a - b);
    const runs: number[][] = [];
    for (const i of sorted) {
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else runs.push([i]);
    }
    for (const run of runs) {
      gaps.push({
        kind: "trackingGap",
        seriesId: spec.seriesId,
        trackId: track,
        segmentFrom: segmentId(track, 0),
        segmentTo: segmentId(track, run[run.length - 1] + 1 === spec.tilts.length ? 0 : 1),
        missingFrameIds: run.filter((i) => !missing.has(i)).map(frameId),
        reason: "out-of-field",
        note: `track ${track} 在 ${run.map(frameId).join(",")} 处断裂；高倾角出视野`
      });
    }
  }

  // 手工排除坏帧
  const exclusions: ManualExclusion[] = Object.entries(bad).map(([idxStr, b]) => {
    const idx = Number(idxStr);
    return {
      kind: "manualExclusion",
      seriesId: spec.seriesId,
      frameId: frameId(idx),
      reasonCode: b.reasonCode,
      reason: b.reason,
      decidedBy: "em-team@lab"
    };
  });

  return { spec, frames, angles, scales, doses, observations, gaps, exclusions, blobs, markerPositions };
}
