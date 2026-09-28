import { seededRandom } from "../core/numeric.ts";
import { encodeGrayPng } from "../core/png.ts";
import { sha256Hex, stableId } from "../core/hashing.ts";
import type { SourceEntity, TiltDirection } from "../core/types.ts";

export interface MarkerSpec {
  trackId: string;
  x0: number; // 零倾角像面 x（像素，相对左上角原点）
  y0: number;
  z: number; // 离焦面深度（像素）
}

export interface TrackingGapSpec {
  trackId: string;
  fromOrdinal: number;
  toOrdinal: number;
  reason: string;
}

export interface SeriesSpec {
  seriesId: string;
  width: number;
  height: number;
  axisX: number; // 真实轴线（像素），故意偏离中心
  axisY: number;
  axisAngleDeg: number;
  tiltAnglesDeg: number[];
  nmPerPixel: string;
  doseSchedule: string[];
  markers: MarkerSpec[];
  driftPerFrame?: { dx: number; dy: number }[];
  noise?: number;
  badFrames?: number[];
  warpFrames?: number[];
  missingFrames?: number[]; // 完全缺失（高倾角）
  /** trackId -> 在指定 ordinal 之后换成另一身份 */
  swapAfter?: { trackId: string; otherTrackId: string; ordinal: number }[];
  gaps?: TrackingGapSpec[];
  exclusions?: { ordinal: number; reasonCode: string; reason: string }[];
  seed: number;
}

export interface GeneratedSeries {
  seriesId: string;
  frames: {
    frameId: string;
    ordinal: number;
    tiltDeg: number;
    blobSha256: string;
    bytes: Uint8Array;
    width: number;
    height: number;
    observed: { trackId: string; segmentId: string; x: number; y: number; confidence: number }[];
  }[];
  entities: SourceEntity[];
  truth: {
    axisX: number;
    axisY: number;
    axisAngleDeg: number;
    markers: MarkerSpec[];
  };
}

/** 2D 投影：绕图像内倾斜轴(axisX,axisY,axisAngle) 按 θ 旋转 3D 点 */
export function projectMarker(
  m: { x0: number; y0: number; z: number },
  thetaRad: number,
  axis: { x: number; y: number; angle: number },
): { x: number; y: number } {
  const dx = m.x0 - axis.x;
  const dy = m.y0 - axis.y;
  const ca = Math.cos(axis.angle);
  const sa = Math.sin(axis.angle);
  // 转到轴线坐标系（u 沿轴，v 垂直轴）
  const u = ca * dx + sa * dy;
  const v = -sa * dx + ca * dy;
  // 绕 u 轴倾转：v' = v cosθ + z sinθ
  const v2 = v * Math.cos(thetaRad) + m.z * Math.sin(thetaRad);
  const dx2 = ca * u - sa * v2;
  const dy2 = sa * u + ca * v2;
  return { x: axis.x + dx2, y: axis.y + dy2 };
}

function drawSpot(
  pixels: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  intensity: number,
): void {
  const r = Math.ceil(radius) + 1;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius + 0.5) continue;
      const falloff = Math.max(0, 1 - d / (radius + 0.5));
      const idx = y * width + x;
      pixels[idx] = Math.min(255, pixels[idx]! + Math.round(intensity * falloff));
    }
  }
}

export function generateSeries(spec: SeriesSpec): GeneratedSeries {
  const blobs: Map<string, Uint8Array> = new Map();
  const frames: GeneratedSeries["frames"] = [];
  const entities: SourceEntity[] = [];

  const drift =
    spec.driftPerFrame ?? spec.tiltAnglesDeg.map((_, i) => ({ dx: 1.2 * i, dy: 0.8 * Math.sin(i) }));
  const noise = spec.noise ?? 6;
  const missing = new Set(spec.missingFrames ?? []);
  const bad = new Set(spec.badFrames ?? []);
  const warped = new Set(spec.warpFrames ?? []);

  let exposure = 0;
  for (let ordinal = 0; ordinal < spec.tiltAnglesDeg.length; ordinal++) {
    if (missing.has(ordinal)) continue;
    const tiltDeg = spec.tiltAnglesDeg[ordinal]!;
    const theta = (tiltDeg * Math.PI) / 180;
    // 每帧独立确定性种子：相同物理参数（含基线 seed、倾角、轴线）
    // 在最小输入与组合输入中产生逐字节相同的原始片段。
    const rand = seededRandom(
      (spec.seed ^ Math.round((tiltDeg + 90) * 137) ^ Math.round(spec.axisX * 7) ^
        Math.round(spec.axisY * 3)) >>> 0,
    );
    const frameId = stableId("frame", spec.seriesId, ordinal);
    exposure += 1;
    const w = spec.width;
    const h = spec.height;
    const pixels = new Uint8Array(w * h);

    // 低剂量底噪 + 随倾角衰减的衬度
    const contrast = Math.cos(theta) * 0.9 + 0.1;
    for (let i = 0; i < pixels.length; i++) pixels[i] = 18 + Math.floor(rand() * noise);

    const observed: GeneratedSeries["frames"][number]["observed"] = [];
    for (const marker of spec.markers) {
      let identity = marker;
      for (const sw of spec.swapAfter ?? []) {
        if (ordinal > sw.ordinal && sw.trackId === marker.trackId) {
          identity = spec.markers.find((mm) => mm.trackId === sw.otherTrackId) ?? marker;
        }
        if (ordinal > sw.ordinal && sw.otherTrackId === marker.trackId) {
          identity = spec.markers.find((mm) => mm.trackId === sw.trackId) ?? marker;
        }
      }
      const p = projectMarker(
        identity,
        theta,
        { x: spec.axisX, y: spec.axisY, angle: (spec.axisAngleDeg * Math.PI) / 180 },
      );
    const d = drift[ordinal] ?? { dx: 0, dy: 0 };
    let ox = 0;
    let oy = 0;
    const isBad = bad.has(ordinal);
    if (isBad) {
      ox = 9 * (rand() - 0.5);
      oy = 9 * (rand() - 0.5);
    }
    const isWarped = warped.has(ordinal);
    if (isWarped) {
        // 局部真实形变（平滑、低频）
        ox += 3.2 * Math.sin((p.y / h) * Math.PI * 2);
        oy += 2.4 * Math.cos((p.x / w) * Math.PI);
      }
      const jx = (rand() - 0.5) * 0.8;
      const jy = (rand() - 0.5) * 0.8;
      const x = p.x + d.dx + ox + jx;
      const y = p.y + d.dy + oy + jy;
      drawSpot(pixels, w, h, x, y, 2.4, Math.round(150 * contrast));
      const swapped = (spec.swapAfter ?? []).some(
        (s) =>
          ordinal > s.ordinal && (s.trackId === marker.trackId || s.otherTrackId === marker.trackId),
      );
      const segmentId = swapped
        ? stableId("seg", marker.trackId, `post-${ordinal}`)
        : stableId("seg", marker.trackId, "a");
      observed.push({
        trackId: marker.trackId,
        segmentId,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        confidence: isBad ? 0.35 : 0.92,
      });
    }

    // 漂移条纹（坏帧更重）
    const streak = isBad ? 26 : 8;
    for (let i = 0; i < w * 3; i++) {
      const x = Math.floor(rand() * w);
      const y = Math.floor(rand() * h);
      if (pixels[y * w + x] !== undefined) pixels[y * w + x] = Math.min(255, pixels[y * w + x]! + streak);
    }

    const bytes = encodeGrayPng(w, h, pixels);
    const blobSha256 = sha256Hex(bytes);
    blobs.set(blobSha256, bytes);
    frames.push({
      frameId,
      ordinal,
      tiltDeg,
      blobSha256,
      bytes,
      width: w,
      height: h,
      observed,
    });
  }

  // 领域实体（保留原始字符串表示）
  for (const f of frames) {
    entities.push({
      kind: "TiltFrame",
      frameId: f.frameId,
      ordinal: f.ordinal,
      exposureIndex: f.ordinal + 1,
      width: f.width,
      height: f.height,
      blobSha256: f.blobSha256,
      mediaType: "image/png",
      acquiredNote: bad.has(f.ordinal) ? "motion-streak-suspected" : undefined,
    });
    const dir: TiltDirection = f.tiltDeg === 0 ? "untilted" : f.tiltDeg > 0 ? "positive" : "negative";
    entities.push({
      kind: "TiltAngle",
      frameId: f.frameId,
      angle: { raw: `${f.tiltDeg}`, value: (f.tiltDeg * Math.PI) / 180, unit: "degree", targetUnit: "radian" },
      direction: dir,
    });
    entities.push({
      kind: "PixelScale",
      frameId: f.frameId,
      nmPerPixel: { raw: spec.nmPerPixel, value: Number(spec.nmPerPixel), unit: "nm", targetUnit: "nm" },
    });
    entities.push({
      kind: "ExposureDose",
      frameId: f.frameId,
      electronsPerSquareAngstrom: {
        raw: spec.doseSchedule[f.ordinal] ?? "2.0",
        value: Number(spec.doseSchedule[f.ordinal] ?? 2),
        unit: "e/A^2",
        targetUnit: "e/A^2",
      },
    });
    for (const obs of f.observed) {
      entities.push({
        kind: "MarkerObservation",
        frameId: f.frameId,
        trackId: obs.trackId,
        segmentId: obs.segmentId,
        x: { raw: `${obs.x}`, value: obs.x, unit: "px", targetUnit: "px" },
        y: { raw: `${obs.y}`, value: obs.y, unit: "px", targetUnit: "px" },
        basis: { frame: "pixel", origin: "top-left" },
        confidence: obs.confidence,
      });
    }
  }

  for (const gap of spec.gaps ?? []) {
    const fromFrame = frames.find((f) => f.ordinal === gap.fromOrdinal);
    const toFrame = frames.find((f) => f.ordinal === gap.toOrdinal);
    if (!fromFrame || !toFrame) continue;
    entities.push({
      kind: "TrackingGap",
      gapId: stableId("gap", spec.seriesId, gap.trackId, gap.fromOrdinal, gap.toOrdinal),
      trackId: gap.trackId,
      fromFrameId: fromFrame.frameId,
      toFrameId: toFrame.frameId,
      reason: gap.reason,
    });
  }
  for (const ex of spec.exclusions ?? []) {
    const f = frames.find((ff) => ff.ordinal === ex.ordinal);
    if (!f) continue;
    entities.push({
      kind: "ManualExclusion",
      frameId: f.frameId,
      reasonCode: ex.reasonCode,
      reason: ex.reason,
    });
  }

  return {
    seriesId: spec.seriesId,
    frames,
    entities,
    truth: { axisX: spec.axisX, axisY: spec.axisY, axisAngleDeg: spec.axisAngleDeg, markers: spec.markers },
  };
}
