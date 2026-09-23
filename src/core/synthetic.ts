/**
 * 确定性合成倾转序列生成器。
 * 生成完整输入材料：原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、
 * 手工排除原因；并支持边界情形开关：轴线偏心、轨迹身份交换、缺失高倾角帧、
 * 坏帧、跟踪缺口。物理模型与配准引擎共享同一套投影数学。
 */
import type {
  DoseContent,
  ManualExclusionsContent,
  MarkerCoordinatesContent,
  PixelScaleContent,
  RawFramesContent,
  TiltAnglesContent,
  TrackingGapsContent
} from "../types/domain.ts";

export interface SyntheticSpec {
  frameCount: number;        // 帧数
  maxTiltDeg: number;        // 最大倾角
  widthPx: number;
  heightPx: number;
  pixelScaleNmPerPx: number;
  doseElectronsPerA2: number;
  beadCount: number;
  axisOffsetPx: number;      // 真实轴心偏移（轴线偏心）
  axisTiltDeg: number;       // 真实轴面内倾角
  seed: number;
  missingHighTiltFrames?: number[];             // 缺失高倾角帧
  badFrames?: { frameIndex: number; jitterPx: number }[]; // 坏帧（充电跳变）
  trackingGaps?: { trackId: string; frameIndexes: number[]; reason: "occlusion" | "low-contrast" | "edge-of-frame" }[];
  identitySwap?: { frameIndex: number; trackA: string; trackB: string }; // 轨迹身份交换
}

export interface GroundTruth {
  beadXYZ: { trackId: string; x: number; y: number; z: number }[];
  perFrameShift: { frameIndex: number; dx: number; dy: number }[];
  tiltAnglesDeg: number[];
}

export interface SyntheticCase {
  rawFrames: RawFramesContent;
  tiltAngles: TiltAnglesContent;
  pixelScale: PixelScaleContent;
  dose: DoseContent;
  markerCoordinates: MarkerCoordinatesContent;
  trackingGaps: TrackingGapsContent;
  manualExclusions: ManualExclusionsContent;
  groundTruth: GroundTruth;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 与配准引擎共享的投影模型：绕偏心倾斜轴旋转 + 正交投影 + 每帧平移。 */
export function projectPoint(
  x: number, y: number, z: number,
  tiltDeg: number,
  axisOffsetPx: number, axisTiltDeg: number,
  centerX: number, centerY: number
): { u: number; v: number } {
  const theta = (tiltDeg * Math.PI) / 180;
  const phi = (axisTiltDeg * Math.PI) / 180;
  const kx = Math.cos(phi), ky = Math.sin(phi); // 轴方向（面内）
  const ax = centerX + axisOffsetPx, ay = centerY;
  const px = x - ax, py = y - ay, pz = z;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const dot = kx * px + ky * py;
  // Rodrigues 旋转（k 在 z=0 平面内）
  const rx = px * cos + (-ky * pz) * sin + kx * dot * (1 - cos);
  const ry = py * cos + (kx * pz) * sin + ky * dot * (1 - cos);
  return { u: rx + ax, v: ry + ay };
}

export function generateSyntheticCase(spec: SyntheticSpec): SyntheticCase {
  const rand = mulberry32(spec.seed);
  const cx = spec.widthPx / 2, cy = spec.heightPx / 2;

  // 真实磁珠三维位置（px 单位，分布于视场中央 70%）
  const beads: GroundTruth["beadXYZ"] = [];
  for (let i = 0; i < spec.beadCount; i++) {
    beads.push({
      trackId: `fid-${String(i + 1).padStart(2, "0")}`,
      x: cx + (rand() - 0.5) * spec.widthPx * 0.7,
      y: cy + (rand() - 0.5) * spec.heightPx * 0.7,
      z: (rand() - 0.5) * spec.heightPx * 0.4
    });
  }

  const tiltAnglesDeg: number[] = [];
  const perFrameShift: GroundTruth["perFrameShift"] = [];
  const missing = new Set(spec.missingHighTiltFrames ?? []);
  const bad = new Map((spec.badFrames ?? []).map((b) => [b.frameIndex, b.jitterPx]));

  const frameIndexes: number[] = [];
  for (let f = 0; f < spec.frameCount; f++) {
    if (missing.has(f)) continue; // 缺失高倾角帧：帧根本不存在
    frameIndexes.push(f);
  }

  const frames: RawFramesContent["frames"] = [];
  const angles: TiltAnglesContent["angles"] = [];
  const observations = new Map<string, { frameIndex: number; xPx: number; yPx: number }[]>();
  for (const b of beads) observations.set(b.trackId, []);

  for (const f of frameIndexes) {
    const t = spec.frameCount === 1 ? 0 : f / (spec.frameCount - 1);
    const tilt = -spec.maxTiltDeg + 2 * spec.maxTiltDeg * t;
    tiltAnglesDeg[f] = tilt;
    const drift = 0.6 * Math.sin(f * 0.9) + (rand() - 0.5) * 0.2;
    const jitter = bad.get(f) ?? 0;
    const dx = drift + jitter * (rand() > 0.5 ? 1 : -1);
    const dy = 0.4 * Math.cos(f * 0.7) + jitter * (rand() > 0.5 ? 1 : -1);
    perFrameShift.push({ frameIndex: f, dx, dy });

    // 原始帧像素：背景 + 颗粒噪声 + 磁珠高斯斑
    const grid = new Uint8Array(spec.widthPx * spec.heightPx).fill(118);
    for (let i = 0; i < grid.length; i += 7) grid[i] = 118 + Math.floor(rand() * 14);
    const spots: { u: number; v: number }[] = [];
    for (const b of beads) {
      const p = projectPoint(b.x, b.y, b.z, tilt, spec.axisOffsetPx, spec.axisTiltDeg, cx, cy);
      const u = p.u + dx, v = p.v + dy;
      spots.push({ u, v });
      stampSpot(grid, spec.widthPx, spec.heightPx, u, v);
    }
    frames.push({
      frameIndex: f,
      tiltAngle: { raw: `${tilt.toFixed(2)} deg`, value: tilt, unit: "deg", diagnostics: [] },
      widthPx: spec.widthPx,
      heightPx: spec.heightPx,
      pixelGrid: { encoding: "gray8-row-major", dataBase64: Buffer.from(grid).toString("base64") },
      sourceLabel: `tilt_${String(f).padStart(3, "0")}.mrc`
    });
    angles.push({ frameIndex: f, tiltAngle: { raw: `${tilt.toFixed(2)} deg`, value: tilt, unit: "deg", diagnostics: [] } });

    // 标记点坐标（观测 = 真实投影 + 噪声）
    for (let bi = 0; bi < beads.length; bi++) {
      const s = spots[bi];
      observations.get(beads[bi].trackId)!.push({
        frameIndex: f,
        xPx: s.u + (rand() - 0.5) * 0.5,
        yPx: s.v + (rand() - 0.5) * 0.5
      });
    }
  }

  // 跟踪缺口：从观测中移除并记录
  const gaps: TrackingGapsContent["gaps"] = [];
  for (const g of spec.trackingGaps ?? []) {
    const obs = observations.get(g.trackId);
    if (!obs) continue;
    for (const fi of g.frameIndexes) {
      const idx = obs.findIndex((o) => o.frameIndex === fi);
      if (idx >= 0) {
        obs.splice(idx, 1);
        gaps.push({ trackId: g.trackId, frameIndex: fi, reason: g.reason });
      }
    }
  }

  // 轨迹身份交换：交换后两轨迹的观测标签对调（轨迹可断裂且可能身份交换）
  const swap = spec.identitySwap;
  if (swap) {
    const a = observations.get(swap.trackA)!;
    const b = observations.get(swap.trackB)!;
    const aAfter = a.filter((o) => o.frameIndex >= swap.frameIndex);
    const bAfter = b.filter((o) => o.frameIndex >= swap.frameIndex);
    const aBefore = a.filter((o) => o.frameIndex < swap.frameIndex);
    const bBefore = b.filter((o) => o.frameIndex < swap.frameIndex);
    observations.set(swap.trackA, [...aBefore, ...bAfter]);
    observations.set(swap.trackB, [...bBefore, ...aAfter]);
  }

  const tracks: MarkerCoordinatesContent["tracks"] = [...observations.entries()].map(([trackId, obs]) => ({
    trackId,
    observations: obs
      .sort((p, q) => p.frameIndex - q.frameIndex)
      .map((o) => ({ frameIndex: o.frameIndex, xPx: round2(o.xPx), yPx: round2(o.yPx), raw: `${round2(o.xPx)},${round2(o.yPx)}` }))
  }));

  const exclusions: ManualExclusionsContent["exclusions"] = (spec.badFrames ?? []).map((b) => ({
    frameIndex: b.frameIndex,
    reason: "charging-jump",
    decidedBy: "em-operator"
  }));

  return {
    rawFrames: { frames },
    tiltAngles: { angles },
    pixelScale: {
      pixelScale: {
        raw: `${spec.pixelScaleNmPerPx} nm/px`,
        value: spec.pixelScaleNmPerPx,
        unit: "nm/px",
        diagnostics: []
      }
    },
    dose: {
      dose: {
        raw: `${spec.doseElectronsPerA2} e-/Å²`,
        value: spec.doseElectronsPerA2,
        unit: "e-/Å²",
        diagnostics: []
      }
    },
    markerCoordinates: { tracks },
    trackingGaps: { gaps },
    manualExclusions: { exclusions },
    groundTruth: { beadXYZ: beads, perFrameShift, tiltAnglesDeg }
  };
}

function stampSpot(grid: Uint8Array, w: number, h: number, u: number, v: number) {
  const r = 2;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = Math.round(u) + dx, y = Math.round(v) + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const d2 = dx * dx + dy * dy;
      const val = 30 + Math.floor(60 * Math.exp(-d2 / 2));
      const i = y * w + x;
      grid[i] = Math.max(0, Math.min(255, Math.min(grid[i], val)));
    }
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
