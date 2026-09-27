import type {
  FrameProvenance,
  Quantity,
  RawFrame,
  TrackSegment,
  Uid,
} from '../core/domain.js';
import type { ScenarioCode } from '../core/events.js';
import { UNITS } from '../core/domain.js';
import { projectObservation, type GlobalAxis, type Marker3D } from '../alg/geometry.js';

export const CASE_NAME = 'tilt-series-panel-room';
export const CASE_TITLE = '倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支';
export const FRAME_W = 128;
export const FRAME_H = 128;
export const FRAME_COUNT = 15; // -70..+70, step 10

export interface ScenarioPack {
  code: ScenarioCode;
  title: string;
  kind: 'minimal' | 'combined';
  combinedWith: ScenarioCode[];
  frames: RawFrame[];
  provenance: FrameProvenance[];
  segments: TrackSegment[];
  /** 共享原始片段的 digest 列表（与基线相同字节，只存一份不可变内容） */
  sharedDigests: string[];
  notes: string;
}

export interface GeneratedCase {
  name: string;
  title: string;
  width: number;
  height: number;
  frameCount: number;
  seriesId: Uid;
  /** 基线：原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口与手工排除原因全部版本化 */
  baselineFrames: RawFrame[];
  baselineProvenance: FrameProvenance[];
  baselineSegments: TrackSegment[];
  scenarios: ScenarioPack[];
}

const SCENARIO_TITLES: Record<ScenarioCode, string> = {
  'axis-eccentricity': '轴线偏心',
  'track-identity-swap': '轨迹身份交换',
  'missing-high-tilt': '缺失高倾角帧',
  'bad-frame-exclusion': '坏帧排除',
  'local-warp-overfit': '局部形变过拟合',
  'multi-solution': '多解并存',
  'concurrent-freeze': '多解与并发冻结',
};

export const SCENARIO_ORDER: ScenarioCode[] = [
  'axis-eccentricity',
  'track-identity-swap',
  'missing-high-tilt',
  'bad-frame-exclusion',
  'local-warp-overfit',
  'multi-solution',
  'concurrent-freeze',
];

const ANGLES = [-70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70];

/** 真值世界：轴明显偏离图像中心 */
const TRUE_AXIS: GlobalAxis = { theta: -8 * (Math.PI / 180), cx: FRAME_W / 2 + 11, cy: FRAME_H / 2 - 7 };
const TRUE_MARKERS: Marker3D[] = [
  { x: -34, y: -22, z: -18 },
  { x: -12, y: 18, z: 6 },
  { x: 12, y: -26, z: 12 },
  { x: 32, y: 14, z: -8 },
  { x: -28, y: 2, z: 22 },
  { x: 22, y: 28, z: -2 },
  { x: 2, y: -8, z: -26 },
  { x: 40, y: -10, z: 16 },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function renderFrame(frameIndex: number, tiltDeg: number, perturb: { bad: boolean }, rng: () => number): Uint8Array {
  const bytes = new Uint8Array(FRAME_W * FRAME_H).fill(26);
  const tiltRad = (tiltDeg * Math.PI) / 180;
  const put = (x: number, y: number, value: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= FRAME_W || yi >= FRAME_H) return;
    bytes[yi * FRAME_W + xi] = Math.max(bytes[yi * FRAME_W + xi], value);
  };
  // 背景纹理条带（随倾角变化，便于叠影观察）
  for (let y = 0; y < FRAME_H; y += 7) {
    for (let x = 0; x < FRAME_W; x++) {
      const v = 30 + 10 * Math.sin((x + tiltDeg) / 9) + 6 * Math.cos((y + tiltDeg * 0.5) / 6);
      put(x, y + (Math.round(tiltDeg) % 5), Math.max(0, Math.min(255, v)));
    }
  }
  TRUE_MARKERS.forEach((marker, mi) => {
    const tilt = { tiltRad, vars: { along: 0, off: 0, rot: 0, warpQAlong: 0, warpQOff: 0 }, warp: false };
    const p = projectObservation(TRUE_AXIS, tilt, marker);
    const jitter = perturb.bad ? 5.5 : 0.45;
    const px = p.x + (rng() - 0.5) * jitter;
    const py = p.y + (rng() - 0.5) * jitter;
    const radius = perturb.bad && mi === 3 ? 3.4 : 2.1;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const rr = Math.hypot(dx, dy);
        if (rr <= radius) put(px + dx, py + dy, perturb.bad ? 210 : 235 - rr * 12);
      }
    }
  });
  if (perturb.bad) {
    for (let i = 0; i < 900; i++) put(Math.floor(rng() * FRAME_W), Math.floor(rng() * FRAME_H), 60 + rng() * 150);
  }
  return bytes;
}

function qty(raw: string, value: number | null, unit: Quantity['unit'], diagnostic?: string): Quantity {
  return { raw, value, unit, diagnostic };
}

function frameDigestPlaceholder(index: number): string {
  return `sha256:frame-${String(index).padStart(2, '0')}`;
}

function buildProvenance(badFrameIndex: number | null, omitHighTilt: boolean, doseGarbled = false): FrameProvenance[] {
  return ANGLES.map((tilt, i) => {
    const missing = omitHighTilt && Math.abs(tilt) >= 70;
    const bad = badFrameIndex === i;
    const exclusion: FrameProvenance['exclusion'] = missing
      ? { kind: 'missing-high-tilt', reason: 'camera failed at +-70 deg acquisition' }
      : bad
        ? { kind: 'bad-frame', manual: true, reason: 'motion blur + beam drift, hand marked for exclusion' }
        : { kind: 'not-excluded' };
    const dose =
      doseGarbled && i === 5
        ? qty('2.1 ??', null, UNITS.unconverted('??'), 'DOSE_UNIT_UNKNOWN: 原始单位无法换算，保留原位用于审阅')
        : qty(`${(2.0 + (i % 3) * 0.15).toFixed(2)} e-/A^2`, 2.0 + (i % 3) * 0.15, UNITS.electronDosePerArea);
    return {
      frameIndex: i,
      tiltAngle: qty(`${tilt} deg`, tilt, UNITS.degree),
      pixelScale: qty('0.55 nm/px', 0.55, UNITS.nanometer),
      dose,
      exclusion,
    };
  });
}

function buildSegments(rng: () => number, options: {
  gaps?: number[];
  swap?: [number, number, number];
}): TrackSegment[] {
  return TRUE_MARKERS.map((_, mi) => {
    const gapFrames = options.gaps?.includes(mi) ? [6, 7, 8] : [];
    const observations = ANGLES.map((tilt, fi) => {
      const tiltRad = (tilt * Math.PI) / 180;
      const p = projectObservation(
        TRUE_AXIS,
        { tiltRad, vars: { along: 0, off: 0, rot: 0, warpQAlong: 0, warpQOff: 0 }, warp: false },
        TRUE_MARKERS[mi],
      );
      const x = p.x + (rng() - 0.5) * 0.5;
      const y = p.y + (rng() - 0.5) * 0.5;
      return {
        frameIndex: fi,
        raw: { x: x.toFixed(3), y: y.toFixed(3), coordinateBasis: 'raw-pixel:top-left' as const },
        normalized: { x, y },
      };
    }).filter((o) => !gapFrames.includes(o.frameIndex));
    const last = observations[observations.length - 1];
    void last;
    return {
      trackId: `seg-${mi + 1}`,
      fromFrameIndex: observations[0].frameIndex,
      toFrameIndex: observations[observations.length - 1].frameIndex,
      observations,
      joinToNext: { kind: 'identity' } as TrackSegment['joinToNext'],
    };
  }).map((seg) => {
    // 轨迹缺口显式断开
    if (options.gaps?.includes(Number(seg.trackId.split('-')[1]) - 1)) {
      seg.joinToNext = { kind: 'gap' };
    }
    return seg;
  }).map((seg, idx, all) => {
    // 身份交换：段 2 与段 5 在第 8 帧之后交换物理标记
    if (options.swap && idx === options.swap[0] - 1) {
      seg.joinToNext = { kind: 'swapped', otherTrackId: all[options.swap[1] - 1].trackId };
      const cutAt = 8;
      seg.observations = seg.observations.filter((o) => o.frameIndex <= cutAt);
      seg.toFrameIndex = cutAt;
    }
    if (options.swap && idx === options.swap[1] - 1) {
      const cutAt = 8;
      const moving = all[options.swap[0] - 1];
      const tail = moving.observations
        .filter((o) => o.frameIndex > cutAt)
        .map((o) => ({ ...o }));
      seg.observations = seg.observations.filter((o) => o.frameIndex <= cutAt);
      seg.observations.push(...tail);
      seg.toFrameIndex = Math.max(...seg.observations.map((o) => o.frameIndex));
      seg.joinToNext = { kind: 'identity' };
    }
    return seg;
  });
}

function buildFrames(rng: () => number, badFrameIndex: number | null, amendLocalFrame?: number): { frames: RawFrame[]; bytes: Uint8Array[] } {
  const bytes: Uint8Array[] = [];
  const frames: RawFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const localAmend = amendLocalFrame === i;
    const b = renderFrame(i, ANGLES[i], { bad: badFrameIndex === i }, rng);
    if (localAmend) {
      for (let k = 0; k < b.length; k += 17) b[k] = Math.min(255, b[k] + 12);
    }
    bytes.push(b);
    frames.push({
      frameIndex: i,
      width: FRAME_W,
      height: FRAME_H,
      blobDigest: frameDigestPlaceholder(i),
      byteLength: b.length,
    });
  }
  return { frames, bytes };
}

export function generatedFrameBytes(): Uint8Array[] {
  const rng = mulberry32(20260927);
  return ANGLES.map((tilt, i) => renderFrame(i, tilt, { bad: i === 10 }, rng));
}

export function generateCase(): GeneratedCase {
  const rng = mulberry32(20260927);
  const base = buildFrames(rng, 10);
  const seriesId: Uid = 'series-tilt-room-0001';
  const baselineSegments = buildSegments(mulberry32(4242), { gaps: [6] });

  const scenario = (code: ScenarioCode, kind: ScenarioPack['kind'], combinedWith: ScenarioCode[], notes: string,
    mutate: (pack: { provenance: FrameProvenance[]; segments: TrackSegment[]; frames: RawFrame[] }) => void): ScenarioPack => {
    const provenance = buildProvenance(
      code === 'bad-frame-exclusion' || code === 'concurrent-freeze' ? 10 : null,
      code === 'missing-high-tilt' || code === 'concurrent-freeze',
      code === 'axis-eccentricity' || code === 'concurrent-freeze',
    );
    const segments = buildSegments(mulberry32(4242), {
      gaps: [6],
      swap: code === 'track-identity-swap' || code === 'concurrent-freeze' ? [2, 5, 8] : undefined,
    });
    // 帧字节默认与基线完全共享；源数据修订只替换一个直接来源
    const frames = base.frames.map((f) => ({ ...f }));
    mutate({ provenance, segments, frames });
    return {
      code,
      title: SCENARIO_TITLES[code],
      kind,
      combinedWith,
      frames,
      provenance,
      segments,
      sharedDigests: base.frames.map((_, i) => frameDigestPlaceholder(i)),
      notes,
    };
  };

  const scenarios: ScenarioPack[] = [
    scenario('axis-eccentricity', 'minimal', [], '轴经过点偏离图像中心 (11,-7) px；候选必须拟合偏心，不允许默认置中。', () => undefined),
    scenario('track-identity-swap', 'minimal', [], 'seg-2 与 seg-5 在第 8 帧后物理身份交换；seg-7 存在跟踪缺口。', () => undefined),
    scenario('missing-high-tilt', 'minimal', [], '±70° 两帧采集失败；候选可用帧更少，残差必须在公共点集上比较。', () => undefined),
    scenario('bad-frame-exclusion', 'minimal', [], '第 10 帧漂移模糊，人工标记坏帧；排除方案与刚体方案在同一有效点集上比较。', () => undefined),
    scenario('local-warp-overfit', 'minimal', [], '8 个标记点上启用二次局部形变，改进不足却吃掉自由度 => 过拟合诊断。', () => undefined),
    scenario('multi-solution', 'minimal', [], '窄倾转角范围 + 近共线标记，z 深度符号不能唯一决定；保留全部合法候选。', (pack) => {
      // 把倾角裁剪到 ±20° 且保留共线子集标记（解释层改动，不删原始帧）
      for (const prov of pack.provenance) {
        if (Math.abs(prov.tiltAngle.value ?? 0) > 20) {
          prov.exclusion = { kind: 'missing-high-tilt', reason: 'multi-solution probe: narrow tilt cone' };
        }
      }
    }),
    scenario('concurrent-freeze', 'combined', ['track-identity-swap', 'missing-high-tilt', 'bad-frame-exclusion'],
      '组合输入：身份交换 + 缺失高倾角 + 坏帧；并在复核界面模拟两个会话并发保存，后提交者看到冲突后冻结。', () => undefined),
  ];

  return {
    name: CASE_NAME,
    title: CASE_TITLE,
    width: FRAME_W,
    height: FRAME_H,
    frameCount: FRAME_COUNT,
    seriesId,
    baselineFrames: base.frames,
    baselineProvenance: buildProvenance(null, false, false),
    baselineSegments,
    scenarios,
  };
}

export const tiltAnglesDeg = ANGLES;
