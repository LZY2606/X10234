// 离线案例“倾转帧拼合室”的确定性材料生成。
// 同一物理序列只生成一次：帧字节内容寻址，最小/组合输入共享同一份不可变片段。
import { sha256Hex } from "./units.js";

export const BASIS_W = 96;
export const BASIS_H = 96;
export const BASIS_ID = "basis-96x96";

export interface SynthTruthTrack {
  physicalId: string;
  u: number;
  v: number;
  z: number;
}

export interface SynthObservation {
  segmentId: string;
  frameId: string;
  x: number;
  y: number;
  uncertaintyPx: number;
  rawText: string;
}

export interface SynthGap {
  gapId: string;
  segmentId: string;
  missingFrameId: string;
  reason: "occluded" | "outside-field" | "tracker-lost" | "manual";
  rawText: string;
}

export interface SynthSegment {
  segmentId: string;
  observedFrameIds: string[];
}

export interface SynthFrame {
  frameId: string;
  order: number;
  angleDeg: number;
  angleRaw: string;
  dose: number;
  doseRaw: string;
  quality: "ok" | "motion-blur" | "over-exposed";
}

export interface SeriesMaterial {
  basisId: string;
  widthPx: number;
  heightPx: number;
  pixelScaleRaw: string;
  frames: SynthFrame[];
  truth: {
    axisDirDeg: number;
    originX: number;
    originY: number;
    tracks: SynthTruthTrack[];
  };
  segments: SynthSegment[];
  observations: SynthObservation[];
  gaps: SynthGap[];
  fragmentPixels: Record<string, Uint16Array>;
}

const DEG = Math.PI / 180;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 生成 13 帧 -72..72 步长 12° 的序列；轴真值 φ=8°、轴心相对画幅中心偏心 (14,-9)；
 * T4/T5 在中段交叉，跟踪器在 f05/f06 之间断段，朴素链接会交换身份；
 * f09(+36°) 为运动模糊坏帧；T2 高倾角出视野、T3 在 f11 跟丢。
 */
export function generateBaselineMaterial(): SeriesMaterial {
  const angles = [-72, -60, -48, -36, -24, -12, 0, 12, 24, 36, 48, 60, 72];
  const frames: SynthFrame[] = angles.map((a, order) => {
    const dose = +(2.0 / Math.max(Math.cos(a * DEG), 0.34)).toFixed(2);
    return {
      frameId: `f${String(order).padStart(2, "0")}`,
      order,
      angleDeg: a,
      angleRaw: `${a} deg`,
      dose,
      doseRaw: `${dose.toFixed(2)} e-/A^2`,
      quality: order === 9 ? "motion-blur" : "ok"
    };
  });

  const tracks: SynthTruthTrack[] = [
    { physicalId: "T0", u: -30, v: 4, z: 6 },
    { physicalId: "T1", u: 28, v: -18, z: -8 },
    { physicalId: "T2", u: 8, v: 26, z: 30 },
    { physicalId: "T3", u: -10, v: -26, z: -24 },
    { physicalId: "T4", u: 5, v: -10, z: 30 },
    { physicalId: "T5", u: 6, v: -4, z: -4 }
  ];

  const phi = 8 * DEG;
  const centerX = BASIS_W / 2;
  const centerY = BASIS_H / 2;
  const originX = centerX + 14;
  const originY = centerY - 9;
  const ax = Math.cos(phi);
  const ay = Math.sin(phi);
  const bx = -Math.sin(phi);
  const by = Math.cos(phi);

  const visible = (tIdx: number, order: number) => {
    if (tIdx === 2 && (order === 0 || order === 1)) return false;
    if (tIdx === 3 && order === 11) return false;
    return true;
  };

  const segmentRuns: Record<string, Array<[number, number]>> = {
    "seg-0": [[0, 12]],
    "seg-1": [[0, 12]],
    "seg-2": [[2, 12]],
    "seg-3": [[0, 10]],
    "seg-4a": [[0, 5]],
    "seg-4b": [[6, 12]],
    "seg-5a": [[0, 5]],
    "seg-5b": [[6, 12]]
  };
  const physicalOf = (segId: string) =>
    segId.startsWith("seg-4") ? 4 : segId.startsWith("seg-5") ? 5 : Number(segId.slice(4));

  const segments: SynthSegment[] = Object.entries(segmentRuns).map(([segmentId, runs]) => ({
    segmentId,
    observedFrameIds: runs.flatMap(([lo, hi]) =>
      Array.from({ length: hi - lo + 1 }, (_, k) => frames[lo + k].frameId)
    )
  }));

  const rand = mulberry32(20260924);
  const observations: SynthObservation[] = [];
  const positionsByFrame: Record<string, Array<{ x: number; y: number; blur: boolean }>> = {};

  for (const frame of frames) {
    const j = frame.order;
    const th = frame.angleDeg * DEG;
    // 平滑样品漂移 + f09 坏帧的单帧跳变
    const jumpX = j === 9 ? 6.0 : 0;
    const jumpY = j === 9 ? -4.0 : 0;
    const dx = 0.4 * j - 2.4 + jumpX;
    const dy = 0.6 * Math.sin(j * 0.9) + jumpY;
    positionsByFrame[frame.frameId] = [];

    for (const [segId, runs] of Object.entries(segmentRuns)) {
      const inRun = runs.some(([lo, hi]) => j >= lo && j <= hi);
      const tIdx = physicalOf(segId);
      if (!inRun || !visible(tIdx, j)) continue;
      const t = tracks[tIdx];
      const xax = t.u + dx;
      const yb = t.v * Math.cos(th) - t.z * Math.sin(th) + dy;
      const px = originX + xax * ax + yb * bx + gaussian(rand) * 0.22;
      const py = originY + xax * ay + yb * by + gaussian(rand) * 0.22;
      observations.push({
        segmentId: segId,
        frameId: frame.frameId,
        x: +px.toFixed(2),
        y: +py.toFixed(2),
        uncertaintyPx: j === 9 ? 0.9 : 0.35,
        rawText: `(${px.toFixed(2)}, ${py.toFixed(2)}) px @${BASIS_ID}`
      });
      positionsByFrame[frame.frameId].push({ x: px, y: py, blur: j === 9 });
    }
  }

  const gaps: SynthGap[] = [
    { gapId: "gap-seg2-f00", segmentId: "seg-2", missingFrameId: "f00", reason: "outside-field", rawText: "f00 高倾角出视野，无观测" },
    { gapId: "gap-seg2-f01", segmentId: "seg-2", missingFrameId: "f01", reason: "outside-field", rawText: "f01 高倾角出视野，无观测" },
    { gapId: "gap-seg3-f11", segmentId: "seg-3", missingFrameId: "f11", reason: "tracker-lost", rawText: "f11 跟踪器跟丢" },
    { gapId: "gap-seg4a-f06", segmentId: "seg-4a", missingFrameId: "f06", reason: "tracker-lost", rawText: "断段：f06 起丢失" },
    { gapId: "gap-seg4b-f05", segmentId: "seg-4b", missingFrameId: "f05", reason: "tracker-lost", rawText: "断段：f05 之前无记录" },
    { gapId: "gap-seg5a-f06", segmentId: "seg-5a", missingFrameId: "f06", reason: "occluded", rawText: "fiducial 被遮挡，段终止" },
    { gapId: "gap-seg5b-f05", segmentId: "seg-5b", missingFrameId: "f05", reason: "occluded", rawText: "fiducial 被遮挡，段自此开始" }
  ];

  const fragmentPixels: Record<string, Uint16Array> = {};
  for (const frame of frames) {
    fragmentPixels[frame.frameId] = renderFrame(positionsByFrame[frame.frameId], frame.quality, frame.order);
  }

  return {
    basisId: BASIS_ID,
    widthPx: BASIS_W,
    heightPx: BASIS_H,
    pixelScaleRaw: "1.12 nm/px",
    frames,
    truth: { axisDirDeg: 8, originX, originY, tracks },
    segments,
    observations,
    gaps,
    fragmentPixels
  };
}

function renderFrame(
  spots: Array<{ x: number; y: number; blur: boolean }>,
  quality: string,
  seedSalt: number
): Uint16Array {
  const rand = mulberry32(91000 + seedSalt * 31);
  const buf = new Uint16Array(BASIS_W * BASIS_H);
  for (let k = 0; k < buf.length; k++) buf[k] = Math.max(400, Math.round(760 + gaussian(rand) * 110));
  for (const spot of spots) {
    const stretch = spot.blur ? 3.2 : 1;
    const ang = spot.blur ? 0.5 : 0;
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const rx = dx * Math.cos(ang) + dy * Math.sin(ang);
        const ry = -dx * Math.sin(ang) + dy * Math.cos(ang);
        const d2 = rx * rx + (ry / stretch) * (ry / stretch);
        if (d2 > 16) continue;
        const x = Math.round(spot.x + dx);
        const y = Math.round(spot.y + dy);
        if (x < 0 || y < 0 || x >= BASIS_W || y >= BASIS_H) continue;
        const add = Math.round(8200 * Math.exp(-d2 / (spot.blur ? 5 : 2.6)));
        buf[y * BASIS_W + x] = Math.min(60000, buf[y * BASIS_W + x] + add);
      }
    }
  }
  return buf;
}

export function fragmentHash(frameId: string, pixels: Uint16Array): string {
  return `sha256:${sha256Hex(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))}`;
}
