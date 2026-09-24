import { createHash } from "node:crypto";
import type { ManualExclusion, MarkerObservation, MarkerTrack, RawFrame, TrackingGap, TrackSegment } from "../../src/domain/types.ts";
import { parseDose, parsePixelScale, parseTiltAngle } from "../../src/domain/quantities.ts";

/**
 * 倾转帧拼合室离线案例包 —— 专门针对 tilt-series 轴线 / fiducial 轨迹 / 配准分支，
 * 不使用通用表格。所有输入按真实断层几何投影生成，带单位与坐标基准。
 */

export const IMAGE_W = 256;
export const IMAGE_H = 256;

/** 合成“真”倾转轴：故意偏心，检验轴线不能默认固定在图像中心。 */
export const TRUE_AXIS = { angleDeg: -12, centerX: 118, centerY: 142 };

export type ScenarioKind =
  | "axis-offset"
  | "track-identity-swap"
  | "missing-high-tilt"
  | "bad-frame"
  | "local-warp-overfit"
  | "multi-solution"
  | "concurrent-freeze";

export interface ScenarioVariant {
  kind: ScenarioKind;
  combined: boolean;
  tiltAnglesDeg: number[];
  axis: { angleDeg: number; centerX: number; centerY: number };
  markerCoords: { id: string; X: number; Y: number; Z: number }[];
  swapPair: [string, string] | null;
  swapAfterFrameIndex: number | null;
  gaps: { track: string; fromAngle: number; toAngle: number; reason: TrackingGap["reasonCode"] }[];
  exclusions: ManualExclusion[];
  badFrameAngles: number[];
  note: string;
}

const FULL_TILTS = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60];
const HIGH_TILT_TRUNCATED = [-40, -30, -20, -10, 0, 10, 20, 30, 40];

const MARKERS = [
  { id: "mk-A", X: -70, Y: -40, Z: -18 },
  { id: "mk-B", X: 20, Y: 55, Z: 12 },
  { id: "mk-C", X: 60, Y: -10, Z: 30 },
  { id: "mk-D", X: -20, Y: 30, Z: -35 }
];

export function axisBasisXY(angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { ex: Math.cos(a), ey: Math.sin(a), nx: -Math.sin(a), ny: Math.cos(a) };
}

/** 真投影：x = c + e*X + n*(Y cosθ + Z sinθ)（断层几何）。 */
export function projectMarker(
  marker: { X: number; Y: number; Z: number },
  tiltDeg: number,
  axis: { angleDeg: number; centerX: number; centerY: number },
  noise = 0.4
): { x: number; y: number } {
  const { ex, ey, nx, ny } = axisBasisXY(axis.angleDeg);
  const theta = (tiltDeg * Math.PI) / 180;
  const a = marker.X;
  const b = marker.Y * Math.cos(theta) + marker.Z * Math.sin(theta);
  const x = axis.centerX + ex * a + nx * b;
  const y = axis.centerY + ey * a + ny * b;
  // 确定性抖动（不使用随机数，保证案例包重放稳定）。
  const jx = noise * Math.sin(tiltDeg * 1.7 + marker.X);
  const jy = noise * Math.cos(tiltDeg * 1.3 + marker.Z);
  return { x: x + jx, y: y + jy };
}

export function defineVariants(): Record<ScenarioKind, { minimal: ScenarioVariant; combined: ScenarioVariant }> {
  const base = (kind: ScenarioKind, combined: boolean, note: string): ScenarioVariant => ({
    kind,
    combined,
    tiltAnglesDeg: FULL_TILTS,
    axis: TRUE_AXIS,
    markerCoords: MARKERS,
    swapPair: null,
    swapAfterFrameIndex: null,
    gaps: [],
    exclusions: [],
    badFrameAngles: [],
    note
  });

  const minimal: Record<ScenarioKind, ScenarioVariant> = {
    "axis-offset": base("axis-offset", false, "最小输入：轴线中心明显偏离图像中心"),
    "track-identity-swap": (() => {
      const v = base("track-identity-swap", false, "最小输入：两条 fiducial 轨迹在 -10° 断裂后交换身份");
      v.swapPair = ["mk-A", "mk-B"];
      v.swapAfterFrameIndex = FULL_TILTS.indexOf(-10);
      v.gaps = [{ track: "trk-A", fromAngle: -20, toAngle: -10, reason: "occluded" }];
      return v;
    })(),
    "missing-high-tilt": (() => {
      const v = base("missing-high-tilt", false, "最小输入：截掉 ±50°/±60° 高倾角帧");
      v.tiltAnglesDeg = HIGH_TILT_TRUNCATED;
      v.gaps = [{ track: "trk-C", fromAngle: 40, toAngle: 50, reason: "high-tilt-missing" }];
      return v;
    })(),
    "bad-frame": (() => {
      const v = base("bad-frame", false, "最小输入：+20° 帧运动模糊，坐标整体偏移");
      v.badFrameAngles = [20];
      v.exclusions = [{ exclusionId: "excl-min-bad", frameId: "frm-bad-frame-min-005", reasonCode: "motion-blur", note: "审阅者标注：+20° 拖影" }];
      return v;
    })(),
    "local-warp-overfit": (() => {
      const v = base("local-warp-overfit", false, "最小输入：少量控制点下局部形变吸收噪声，诱发过拟合");
      return v;
    })(),
    "multi-solution": (() => {
      const v = base("multi-solution", false, "最小输入：缺高倾角使轴线多解并存");
      v.tiltAnglesDeg = HIGH_TILT_TRUNCATED;
      return v;
    })(),
    "concurrent-freeze": (() => {
      const v = base("concurrent-freeze", false, "最小输入：完整序列，用于两个窗口并发保存与冻结");
      return v;
    })()
  };

  const comb = (kind: ScenarioKind, note: string, tweak: (v: ScenarioVariant) => void): ScenarioVariant => {
    const v = base(kind, true, note);
    v.tiltAnglesDeg = [...FULL_TILTS];
    v.swapPair = ["mk-A", "mk-B"];
    v.swapAfterFrameIndex = FULL_TILTS.indexOf(-10);
    v.gaps = [
      { track: "trk-A", fromAngle: -20, toAngle: -10, reason: "occluded" },
      { track: "trk-C", fromAngle: 50, toAngle: 60, reason: "high-tilt-missing" }
    ];
    v.badFrameAngles = [20];
    tweak(v);
    return v;
  };

  const combined: Record<ScenarioKind, ScenarioVariant> = {
    "axis-offset": comb("axis-offset", "组合输入：偏心轴 + 身份交换 + 坏帧", () => {}),
    "track-identity-swap": comb("track-identity-swap", "组合输入：身份交换叠加坏帧与缺口", () => {}),
    "missing-high-tilt": comb("missing-high-tilt", "组合输入：组合中再截掉高倾角", (v) => {
      v.tiltAnglesDeg = HIGH_TILT_TRUNCATED;
    }),
    "bad-frame": comb("bad-frame", "组合输入：坏帧叠加偏心轴与交换", (v) => {
      v.exclusions = [{ exclusionId: "excl-comb-bad", frameId: "frm-bad-frame-comb-005", reasonCode: "motion-blur", note: "组合案例 +20° 拖影" }];
    }),
    "local-warp-overfit": comb("local-warp-overfit", "组合输入：多缺口下局部形变更易过拟合", () => {}),
    "multi-solution": comb("multi-solution", "组合输入：组合高倾角缺失产生多解", (v) => {
      v.tiltAnglesDeg = HIGH_TILT_TRUNCATED;
    }),
    "concurrent-freeze": comb("concurrent-freeze", "组合输入：完整边界组合下并发冻结", () => {})
  };

  return {
    "axis-offset": { minimal: minimal["axis-offset"], combined: combined["axis-offset"] },
    "track-identity-swap": { minimal: minimal["track-identity-swap"], combined: combined["track-identity-swap"] },
    "missing-high-tilt": { minimal: minimal["missing-high-tilt"], combined: combined["missing-high-tilt"] },
    "bad-frame": { minimal: minimal["bad-frame"], combined: combined["bad-frame"] },
    "local-warp-overfit": { minimal: minimal["local-warp-overfit"], combined: combined["local-warp-overfit"] },
    "multi-solution": { minimal: minimal["multi-solution"], combined: combined["multi-solution"] },
    "concurrent-freeze": { minimal: minimal["concurrent-freeze"], combined: combined["concurrent-freeze"] }
  };
}

export interface FrameBlob {
  sha256: string;
  fileName: string;
  contentType: "image/x-portable-graymap";
  bytes: Uint8Array;
  width: number;
  height: number;
  bad: boolean;
  tiltAngleDeg: number;
}

function deterministicNoise(ix: number, iy: number, salt: number): number {
  let h = (ix * 374761393 + iy * 668265263 + salt * 1274126177) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) & 0xff) / 255;
}

/** 生成 16 位 PGM 帧像素：背景梯度 + fiducial 投影光斑。内容只取决于倾角与坏帧标志，天然跨案例去重。 */
export function renderFrameBlob(tiltAngleDeg: number, bad: boolean): FrameBlob {
  const width = IMAGE_W;
  const height = IMAGE_H;
  const pixels = new Uint16Array(width * height);
  const salt = Math.round(tiltAngleDeg * 10) + 1000;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grad = 26000 + 20 * Math.sin((x / width) * Math.PI) + 12 * Math.cos((y / height) * Math.PI * 2 + (tiltAngleDeg / 60));
      const n = (deterministicNoise(x, y, salt) - 0.5) * 500;
      pixels[y * width + x] = Math.max(0, Math.min(65535, grad + n));
    }
  }
  const dotRadius = 3;
  for (const marker of MARKERS) {
    const p = projectMarker(marker, tiltAngleDeg, TRUE_AXIS, 0);
    const shiftX = bad ? 14 : 0;
    const shiftY = bad ? -9 : 0;
    for (let dy = -dotRadius; dy <= dotRadius; dy++) {
      for (let dx = -dotRadius; dx <= dotRadius; dx++) {
        const x = Math.round(p.x) + dx + shiftX;
        const y = Math.round(p.y) + dy + shiftY;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const falloff = Math.max(0, 1 - Math.hypot(dx, dy) / (dotRadius + 0.5));
        const idx = y * width + x;
        pixels[idx] = Math.min(65535, pixels[idx]! + 30000 * falloff * (bad ? 0.45 : 1));
      }
    }
  }
  // P5 PGM, maxval 65535（big-endian）。
  const header = Buffer.from(`P5\n${width} ${height}\n65535\n`, "ascii");
  const body = Buffer.alloc(width * height * 2);
  for (let i = 0; i < pixels.length; i++) body.writeUInt16BE(pixels[i]!, i * 2);
  const bytes = new Uint8Array(Buffer.concat([header, body]));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    sha256,
    fileName: `frame-${tiltAngleDeg >= 0 ? "p" : "m"}${Math.abs(tiltAngleDeg)}${bad ? "-bad" : ""}.pgm`,
    contentType: "image/x-portable-graymap",
    bytes,
    width,
    height,
    bad,
    tiltAngleDeg
  };
}

export interface BuiltRevision {
  label: string;
  frameIds: string[];
  frames: RawFrame[];
  tracks: MarkerTrack[];
  exclusions: ManualExclusion[];
  blobs: FrameBlob[];
}

export function buildRevision(kind: ScenarioKind, variant: ScenarioVariant, tag: "min" | "comb", label: string): BuiltRevision {
  const blobs: FrameBlob[] = [];
  const frames: RawFrame[] = [];
  const frameIds: string[] = [];
  const frameIdAtAngle = new Map<number, string>();
  variant.tiltAnglesDeg.forEach((tilt, i) => {
    const bad = variant.badFrameAngles.includes(tilt);
    const blob = renderFrameBlob(tilt, bad);
    blobs.push(blob);
    const frameId = `frm-${kind}-${tag}-${String(i).padStart(3, "0")}`;
    frameIdAtAngle.set(tilt, frameId);
    const angleText = tilt >= 0 ? `+${tilt} deg` : `${tilt} deg`;
    const doseValue = 2.0 + 0.02 * Math.abs(tilt);
    const scaleText = i % 3 === 0 ? "2.34 A" : "0.234 nm";
    frames.push({
      frameId,
      contentSha256: blob.sha256,
      contentType: blob.contentType,
      byteLength: blob.bytes.length,
      width: blob.width,
      height: blob.height,
      acquisitionIndex: i,
      externalLabel: `tilt_${tilt >= 0 ? "p" : "m"}${Math.abs(tilt)}.mrc`,
      acquiredAt: `2026-09-18T${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00+09:00`,
      tiltAngle: parseTiltAngle(angleText),
      pixelScale: parsePixelScale(scaleText),
      dose: parseDose(`${doseValue.toFixed(2)} e/A2`)
    });
    frameIds.push(frameId);
  });

  const tracks: MarkerTrack[] = variant.markerCoords.map((marker) => {
    const letter = marker.id.slice(-1);
    const trackId = `trk-${letter}`;
    const observations: MarkerObservation[] = [];
    const gaps: TrackingGap[] = [];
    let segStartFrame = frameIds[0]!;
    const segments: TrackSegment[] = [];
    const isSwap = variant.swapPair !== null && variant.swapPair.includes(marker.id);
    const counterpartId = isSwap ? variant.swapPair!.find((m) => m !== marker.id)! : null;
    const counterpart = variant.markerCoords.find((m) => m.id === counterpartId)!;

    variant.tiltAnglesDeg.forEach((tilt, i) => {
      const frameId = frameIds[i]!;
      const declaredGap = variant.gaps.find((g) => g.track === trackId && g.toAngle === tilt);
      if (declaredGap) {
        gaps.push({
          gapId: `gap-${kind}-${tag}-${trackId}-${String(i).padStart(2, "0")}`,
          trackId,
          fromFrameId: frameIdAtAngle.get(declaredGap.fromAngle) ?? null,
          toFrameId: frameId,
          reasonCode: declaredGap.reason,
          note: `${trackId} 在 ${declaredGap.fromAngle}°→${tilt}° 之间${
            declaredGap.reason === "occluded" ? "被遮挡" : declaredGap.reason === "high-tilt-missing" ? "高倾角帧缺失" : "跟踪丢失"
          }`
        });
        segments.push({
          segmentId: `seg-${kind}-${tag}-${trackId}-${String(segments.length).padStart(2, "0")}`,
          fromFrameId: segStartFrame,
          toFrameId: frameIdAtAngle.get(declaredGap.fromAngle)!,
          identity: marker.id,
          breakBefore: segments.length > 0
        });
        segStartFrame = frameId;
        return;
      }
      const swappedNow = isSwap && variant.swapAfterFrameIndex !== null && i > variant.swapAfterFrameIndex;
      const which = swappedNow ? counterpart : marker;
      const p = projectMarker(which, tilt, variant.axis, 0.6);
      observations.push({
        markerId: marker.id,
        trackId,
        frameId,
        x: p.x,
        y: p.y,
        coordinateBasis: "pixel-origin-top-left",
        confidence: swappedNow ? 0.42 : 0.93,
        present: true
      });
    });
    segments.push({
      segmentId: `seg-${kind}-${tag}-${trackId}-${String(segments.length).padStart(2, "0")}`,
      fromFrameId: segStartFrame,
      toFrameId: frameIds[frameIds.length - 1]!,
      identity: marker.id,
      breakBefore: segments.length > 0
    });
    return {
      trackId,
      observations,
      gaps,
      segments,
      identitySwapWith: isSwap ? `trk-${counterpartId!.slice(-1)}` : null
    };
  });

  const exclusions: ManualExclusion[] = variant.exclusions.map((e) => {
    const tilt = variant.badFrameAngles[0];
    const frameId = tilt !== undefined ? frameIdAtAngle.get(tilt) : e.frameId;
    return { ...e, exclusionId: `excl-${kind}-${tag}`, frameId: frameId ?? e.frameId };
  });

  return { label, frameIds, frames, tracks, exclusions, blobs };
}
