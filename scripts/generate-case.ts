import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, symlink, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FrameInput, MarkerObservation, RawInputBundle, TrackGap, ManualExclusion } from '../src/shared/types';
import type { ScenarioCode } from '../src/shared/scenario';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = path.join(ROOT, 'case-pack', 'tilt-puzzle-pack-01');

const W = 160;
const H = 120;

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TruthPoint {
  markerId: string;
  X: number;
  Y: number;
  Z: number;
}

interface GenOpts {
  seed: number;
  nFrames: number;
  tiltMax: number;
  betaDeg: number;
  x0Px: number;
  points: TruthPoint[];
  missingFrames?: number[];
  badFrames?: Record<number, { jx: number; jy: number }>;
  swapAfterFrame?: number;
  swapPair?: [string, string];
  exclusions?: ManualExclusion[];
}

export interface Generated {
  bundle: RawInputBundle;
  blobs: Map<string, Uint8Array>;
  scenario: ScenarioCode | 'combined' | 'baseline';
  mode: 'minimal' | 'combined';
}

export { W, H, PACK, mulberry, ROOT };
export type { GenOpts, TruthPoint };

function renderFrame(
  seed: number,
  frameId: string,
  tiltDeg: number,
  betaDeg: number,
  x0: number,
  pts: { x: number; y: number }[],
  jitter: { jx: number; jy: number },
  bad: boolean
): Uint8Array {
  const rnd = mulberry(seed);
  const buf = new Uint8Array(W * H);
  for (let i = 0; i < buf.length; i++) {
    const stripe = Math.sin((i % W) / 12) * 6;
    buf[i] = Math.max(0, Math.min(255, 28 + rnd() * 14 + stripe)) | 0;
  }
  const plot = (px: number, py: number, amp: number, radius: number) => {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.round(px + dx);
        const y = Math.round(py + dy);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const d = Math.hypot(dx, dy);
        if (d > radius) continue;
        const idx = y * W + x;
        buf[idx] = Math.min(255, buf[idx] + amp * Math.cos((d / radius) * Math.PI / 2));
      }
    }
  };
  const theta = (tiltDeg * Math.PI) / 180;
  const beta = (betaDeg * Math.PI) / 180;
  const alpha = beta - theta;
  for (const p of pts) {
    const x = x0 + Math.cos(alpha) * p.x + Math.sin(alpha) * p.y + jitter.jx;
    const y = H / 2 - Math.sin(alpha) * p.x + Math.cos(alpha) * p.y + jitter.jy;
    plot(x, y, 150, 3);
  }
  if (bad) {
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(rnd() * W);
      const y = Math.floor(rnd() * H);
      buf[y * W + x] = Math.min(255, buf[y * W + x] + 120);
    }
  }
  return buf;
}

function sha(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function generate(opts: GenOpts, scenario: Generated['scenario'], mode: Generated['mode'], seriesId: string): Generated {
  const rnd = mulberry(opts.seed);
  const blobs = new Map<string, Uint8Array>();
  const frames: FrameInput[] = [];
  const tracks: Record<string, MarkerObservation[]> = {};
  const gaps: TrackGap[] = [];
  const missing = new Set(opts.missingFrames ?? []);
  const physicalAt = (p: TruthPoint, tiltDeg: number) => {
    const theta = (tiltDeg * Math.PI) / 180;
    const beta = (opts.betaDeg * Math.PI) / 180;
    const alpha = beta - theta;
    return {
      x: opts.x0Px + Math.cos(alpha) * p.X + Math.sin(alpha) * p.Z,
      y: H / 2 - Math.sin(alpha) * p.X + Math.cos(alpha) * p.Z
    };
  };

  const half = (opts.nFrames - 1) / 2;
  for (let i = 0; i < opts.nFrames; i++) {
    const tilt = (opts.tiltMax * (i - half)) / half;
    const frameId = `f-${String(i).padStart(2, '0')}`;
    const acquired = !missing.has(i);
    const isBad = !!opts.badFrames?.[i];
    const noiseJitter = { jx: (rnd() - 0.5) * 0.9, jy: (rnd() - 0.5) * 0.9 };
    const jitter = isBad ? opts.badFrames![i] : noiseJitter;
    let blobSha: string | null = null;
    if (acquired) {
      const projected = opts.points.map((p) => physicalAt(p, tilt));
      const buf = renderFrame(opts.seed * 1000 + i, frameId, tilt, opts.betaDeg, opts.x0Px, projected, jitter, isBad);
      blobSha = sha(buf);
      blobs.set(blobSha, buf);
    }
    const doseRaw = i === Math.round(half) + 1 && scenario !== 'multi-solution' && scenario !== 'concurrent-freeze'
      ? 'N/A（剂量计离线，保留原值不转换）'
      : Number((2.1 + Math.abs(i - half) * 0.07).toFixed(3));
    frames.push({
      frameId,
      index: i,
      planned: true,
      acquired,
      tiltAngleDeg: Number(tilt.toFixed(3)),
      dose: (doseRaw as number),
      blobSha,
      width: W,
      height: H
    });

    if (!acquired) continue;
    const swapped = opts.swapAfterFrame !== undefined && i > opts.swapAfterFrame && opts.swapPair;
    for (const p of opts.points) {
      let key = p.markerId;
      let segment = 'seg-0';
      if (swapped) {
        const [a, b] = opts.swapPair!;
        if (p.markerId === a) key = `${a}s`;
        if (p.markerId === b) key = `${b}s`;
        segment = 'seg-1';
      }
      const q = physicalAt(p, tilt);
      const noise = () => (rnd() - 0.5) * 1.1;
      const obs: MarkerObservation = {
        markerId: key,
        segmentId: segment,
        frame: frameId,
        coordinateSystem: 'detector-pixels',
        x: Number((q.x + noise()).toFixed(3)),
        y: Number((q.y + noise()).toFixed(3)),
        quality: isBad ? 0.25 : 0.92
      };
      (tracks[key] ??= []).push(obs);
    }
  }

  if (opts.swapAfterFrame !== undefined && opts.swapPair) {
    const [a, b] = opts.swapPair;
    const cut = `f-${String(opts.swapAfterFrame).padStart(2, '0')}`;
    gaps.push({
      markerId: a,
      missingFrameIds: [cut],
      reason: 'tracking-lost',
      note: `轨迹在 ${cut} 断裂，seg-1 与 ${b}s 发生身份交换，需要 identityMap 复核`
    });
    gaps.push({
      markerId: b,
      missingFrameIds: [cut],
      reason: 'tracking-lost',
      note: `轨迹在 ${cut} 断裂，seg-1 与 ${a}s 发生身份交换，需要 identityMap 复核`
    });
  }
  for (const idx of missing) {
    gaps.push({
      markerId: '*',
      missingFrameIds: [`f-${String(idx).padStart(2, '0')}`],
      reason: 'not-acquired',
      note: '高倾角帧未采集（计划内缺口），不是坏帧，不得用排除换低残差'
    });
  }

  const bundle: RawInputBundle = {
    seriesId,
    name: `${scenario}/${mode}`,
    frames,
    tracks,
    gaps,
    exclusions: opts.exclusions ?? [],
    axisHintDeg: 0,
    axisHintOffsetPx: null,
    truth: {
      axisAngleDeg: opts.betaDeg,
      axisOffsetPx: { x: opts.x0Px, width: W },
      width: W,
      height: H
    },
    notes: 'tilt-puzzle-pack-01 synthetic tilt-series；像素尺度 0.84 nm/pixel；探测器像素坐标原点左上 x→ y↓。'
  };
  return { bundle, blobs, scenario, mode };
}

function pts(...coords: [string, number, number, number][]): TruthPoint[] {
  return coords.map(([markerId, X, Y, Z]) => ({ markerId, X, Y, Z }));
}

const COMMON_PTS = pts(['m1', -34, -20, -18], ['m2', 26, 14, 8], ['m3', -8, 22, 24], ['m4', 32, -24, -10], ['m5', 2, -4, 30]);

function configs(): Record<string, GenOpts> {
  return {
    'axis-eccentric': {
      seed: 101,
      nFrames: 13,
      tiltMax: 62,
      betaDeg: -8,
      x0Px: 52,
      points: COMMON_PTS
    },
    'track-identity-swap': {
      seed: 202,
      nFrames: 13,
      tiltMax: 60,
      betaDeg: 6,
      x0Px: 104,
      points: COMMON_PTS,
      swapAfterFrame: 6,
      swapPair: ['m1', 'm2']
    },
    'missing-high-tilt': {
      seed: 303,
      nFrames: 13,
      tiltMax: 64,
      betaDeg: 10,
      x0Px: 92,
      points: COMMON_PTS,
      missingFrames: [0, 12]
    },
    'bad-frame-exclusion': {
      seed: 404,
      nFrames: 13,
      tiltMax: 60,
      betaDeg: 4,
      x0Px: 84,
      points: COMMON_PTS,
      badFrames: { 5: { jx: 11, jy: -9 } },
      exclusions: [{ frameId: 'f-05', reason: '束漂+平台抖动，fiducial quality=0.25，人工确认排除', operator: 'em-team' }]
    },
    'local-warp-overfit': {
      seed: 505,
      nFrames: 13,
      tiltMax: 58,
      betaDeg: -3,
      x0Px: 78,
      points: COMMON_PTS
    },
    'multi-solution': {
      seed: 606,
      nFrames: 9,
      tiltMax: 40,
      betaDeg: 12,
      x0Px: 80,
      points: pts(['m1', -20, 0, 0], ['m2', 20, 0, 0], ['m3', 0, 0, 0])
    },
    'concurrent-freeze': {
      seed: 707,
      nFrames: 9,
      tiltMax: 44,
      betaDeg: 5,
      x0Px: 88,
      points: pts(['m1', -22, -14, -8], ['m2', 18, 12, 10], ['m3', 4, -18, 16])
    }
  };
}

const COMBINED: GenOpts = {
  seed: 101,
  nFrames: 13,
  tiltMax: 64,
  betaDeg: -8,
  x0Px: 52,
  points: COMMON_PTS,
  missingFrames: [12],
  badFrames: { 5: { jx: 11, jy: -9 } },
  swapAfterFrame: 7,
  swapPair: ['m1', 'm2'],
  exclusions: [{ frameId: 'f-05', reason: '组合输入：束漂坏帧，人工排除', operator: 'em-team' }]
};

export { generate, configs, COMBINED };

async function linkBlob(globalDir: string, localDir: string, shaHex: string) {
  const target = path.join(globalDir, `${shaHex}.bin`);
  const link = path.join(localDir, `${shaHex}.bin`);
  if (!existsSync(link)) {
    try {
      await symlink(path.relative(localDir, target), link);
    } catch {
      const b = await readFile(target);
      await writeFile(link, b);
    }
  }
}

async function emit(gen: Generated, globalBlobs: Map<string, Uint8Array>) {
  const dir = path.join(PACK, gen.mode === 'minimal' ? 'minimal' : 'combined', gen.scenario === 'combined' ? 'combined' : gen.scenario);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'frames'), { recursive: true });
  const globalDir = path.join(PACK, 'frames');
  await mkdir(globalDir, { recursive: true });

  for (const [shaHex, bytes] of gen.blobs) {
    const target = path.join(globalDir, `${shaHex}.bin`);
    if (!existsSync(target)) await writeFile(target, bytes);
    globalBlobs.set(shaHex, bytes);
    await linkBlob(globalDir, path.join(dir, 'frames'), shaHex);
  }

  const unconvertible: string[] = [];
  const doseValues = gen.bundle.frames.map((f) => f.dose);
  for (const f of gen.bundle.frames) {
    if (typeof f.dose === 'string') unconvertible.push(f.frameId);
  }

  const inputJson = {
    schema: 'tilt-stitch-room/raw-input/1',
    coordinateReference: 'detector-pixels',
    origin: 'upper-left',
    pixelScale: { raw: '0.84 nm/px', rawUnit: 'nm/px', value: 0.84, unit: 'nm/pixel', basis: 'microscope-calibration-2026-09-19' },
    tiltAngles: { unit: 'degrees', rawUnit: '°', values: gen.bundle.frames.map((f) => ({ frameId: f.frameId, raw: f.tiltAngleDeg })) },
    dose: {
      unit: 'e-/A^2',
      rawUnit: 'e-/Å^2',
      values: gen.bundle.frames.map((f) => ({
        frameId: f.frameId,
        raw: f.dose,
        convertible: typeof f.dose === 'number',
        diagnostics: typeof f.dose === 'number' ? [] : ['UNCONVERTIBLE_DOSE: 剂量计离线，原值留在原位置，不用于绘图归一化']
      }))
    },
    frames: gen.bundle.frames,
    tracks: gen.bundle.tracks,
    gaps: gen.bundle.gaps,
    manualExclusions: gen.bundle.exclusions,
    groundTruth: gen.bundle.truth,
    axisHint: { angleDeg: 0, note: '导入时不得把轴线默认固定在图像中心；hint 仅供对照，不是结论' },
    provenance: { scenario: gen.scenario, mode: gen.mode },
    unconvertibleFrames: unconvertible,
    notes: gen.bundle.notes
  };
  await writeFile(path.join(dir, 'input.json'), JSON.stringify(inputJson, null, 2));
  return { dir, unconvertible };
}

async function main() {
  await rm(PACK, { recursive: true, force: true });
  await mkdir(PACK, { recursive: true });
  const globalBlobs = new Map<string, Uint8Array>();
  const manifest: Record<string, unknown> = { schema: 'tilt-puzzle-pack-01/manifest/1', scenarios: [] };

  const cfgs = configs();
  for (const code of Object.keys(cfgs) as (keyof typeof cfgs)[]) {
    const minimal = generate(cfgs[code], code as ScenarioCode, 'minimal', `series-${code}-min`);
    const em = await emit(minimal, globalBlobs);
    (manifest.scenarios as unknown[]).push({ code, mode: 'minimal', dir: path.relative(PACK, em.dir), frames: minimal.bundle.frames.length });
  }
  const combined = generate(COMBINED, 'combined', 'combined', 'series-combined');
  const ec = await emit(combined, globalBlobs);
  manifest.combined = { mode: 'combined', dir: path.relative(PACK, ec.dir), frames: combined.bundle.frames.length };
  manifest.uniqueBlobs = globalBlobs.size;
  manifest.narrative = [
    '初始导入：核对原始帧/倾角/像素尺度/剂量/标记点/跟踪缺口/手工排除原因',
    '参数修订：轴线 hint 从 0° 改为按自由轴搜索',
    '局部源数据改动：仅修正一帧 fiducial 坐标，失效范围限定为依赖该观测的候选',
    '冲突人工决定：两个会话分别接受不同候选，后提交产生版本冲突'
  ];
  await writeFile(path.join(PACK, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('case pack emitted:', globalBlobs.size, 'unique frame blobs');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
