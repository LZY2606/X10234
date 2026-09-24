import { deg2rad } from './math';
import { encodePGM } from './pgm';
import type { CaseGeometry, CaseSpec, FrameSpec, TrackSpec } from './case-types';
import type { DomainQuantity, PointXY } from '../shared/model';

// 确定性伪随机，保证案例包离线可重放。
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BASE_GEOMETRY: CaseGeometry = {
  axisAngleDeg: -13.5,
  axisOffsetPx: 7.25, // 明确偏心：轴不在图像中心
  imageCenter: { x: 23.5, y: 23.5 },
  noisePx: 0.22,
  badShiftPx: 4.6,
};

export function qty(value: number | number[] | null, unit: string, repr: string, extra?: Partial<DomainQuantity>): DomainQuantity {
  return { value, unit, repr, ...extra };
}

export function frameIds(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}/f${String(i).padStart(2, '0')}`);
}

export function makeTiltRange(step = 10, max = 60): number[] {
  const out: number[] = [];
  for (let t = -max; t <= max; t += step) out.push(t);
  return out;
}

// 真实投影：给定帧倾角、轨迹 (u0,z)、轴线偏心 d、帧漂移，返回图像坐标。
export function projectFiducial(args: {
  tiltDeg: number;
  u0: number;
  z: number;
  axisAngleDeg: number;
  axisOffsetPx: number;
  center: PointXY;
  driftU: number;
  driftN: number;
}): PointXY {
  const u = args.u0 + args.driftU;
  const n = args.z * Math.sin(deg2rad(args.tiltDeg)) + args.axisOffsetPx + args.driftN;
  const th = deg2rad(args.axisAngleDeg);
  return {
    x: args.center.x + Math.cos(th) * u - Math.sin(th) * n,
    y: args.center.y + Math.sin(th) * u + Math.cos(th) * n,
  };
}

interface BuildOpts {
  caseId: string;
  title: string;
  tilts: number[];
  seed: number;
  trackCount?: number;
  missing?: (t: number) => boolean;
  badIndex?: number;
  swapTracks?: [string, string, string]; // A,B,afterFrameId
  gaps?: { track: number; fromIdx: number; toIdx: number; reason: string }[];
  excludeIdx?: number;
  excludeReason?: string;
  unconvertibleDoseAt?: number;
  geometry?: Partial<CaseGeometry>;
}

export function buildCase(opts: BuildOpts): CaseSpec {
  const geom: CaseGeometry = { ...BASE_GEOMETRY, ...(opts.geometry ?? {}) };
  const rand = mulberry32(opts.seed);
  const ids = frameIds(opts.caseId, opts.tilts.length);
  const trackCount = opts.trackCount ?? 5;
  const trackIds = Array.from({ length: trackCount }, (_, k) => `${opts.caseId}/tr${k}`);
  const tracks: TrackSpec[] = trackIds.map((trackId, k) => {
    const ang = (k / trackCount) * Math.PI * 2 + 0.35;
    return {
      trackId,
      u0: -11 + k * (22 / Math.max(1, trackCount - 1)),
      z: 6 * Math.cos(ang) + (k % 2 ? 3.2 : -2.4),
      gaps: [],
    };
  });
  (opts.gaps ?? []).forEach((g) => {
    tracks[g.track]?.gaps.push({
      from: ids[g.fromIdx],
      to: ids[g.toIdx],
      reason: g.reason,
    });
  });
  if (opts.swapTracks) {
    const [a, b, after] = opts.swapTracks;
    const tr = tracks.find((t) => t.trackId === a);
    if (tr) {
      tr.swapAfterFrame = after;
      tr.swapTargetId = b;
    }
  }

  const frames: FrameSpec[] = opts.tilts.map((tilt, i) => {
    const f: FrameSpec = {
      frameId: ids[i],
      index: i,
      tiltDeg: tilt,
      pixelSize: 2.14,
      dose: 1.8 + Math.cos(deg2rad(tilt)) * 0.5,
      width: 48,
      height: 48,
      presentTracks: [...trackIds],
    };
    if (opts.missing?.(tilt)) f.missing = true;
    if (opts.badIndex === i) f.bad = true;
    if (opts.excludeIdx === i) {
      f.excluded = true;
      f.excludeReason = opts.excludeReason ?? 'manual review: unusable frame';
    }
    // 跟踪缺口在对应帧移除轨迹可见性
    tracks.forEach((tr) => {
      for (const gap of tr.gaps) {
        const a = ids.indexOf(gap.from);
        const b = ids.indexOf(gap.to);
        if (i >= a && i <= b) f.presentTracks = f.presentTracks.filter((x) => x !== tr.trackId);
      }
    });
    if (f.missing) f.presentTracks = [];
    void rand;
    return f;
  });

  const pixelQuantity: DomainQuantity = qty(2.14, 'angstrom/pixel', '2.14 A/px (microscope header)', {
    coordBasis: 'image_origin_top_left',
    normalized: 0.214,
  });

  return { caseId: opts.caseId, title: opts.title, frames, tracks, geometry: geom, pixelQuantity };
}

// 生成一帧 48x48 PGM：背景 + fiducial 标记点 + 文字倾角不做，简单投影斑点。
export function renderFramePGM(spec: CaseSpec, frame: FrameSpec): Buffer {
  const { width: w, height: h } = frame;
  const px = new Uint8Array(w * h).fill(18);
  const rand = mulberry32(spec.caseId.length * 7919 + frame.index * 131 + 17);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = 14 + Math.floor(rand() * 10);
  const put = (cx: number, cy: number, v: number, radius = 1) => {
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.round(cx) + dx;
        const y = Math.round(cy) + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        px[y * w + x] = Math.min(255, px[y * w + x] + v - (Math.abs(dx) + Math.abs(dy)) * 28);
      }
  };
  const g = spec.geometry;
  for (const tr of spec.tracks) {
    if (!frame.presentTracks.includes(tr.trackId)) continue;
    let actualTrack = tr;
    if (tr.swapAfterFrame && frame.frameId > tr.swapAfterFrame) {
      const other = spec.tracks.find((t) => t.trackId === tr.swapTargetId) ?? spec.tracks.find((t) => t !== tr);
      if (other) actualTrack = other;
    }
    const driftU = Math.sin(frame.index * 1.7) * 0.35;
    const driftN = Math.cos(frame.index * 1.1) * 0.3 + (frame.bad ? g.badShiftPx : 0) + (frame.rippleN ?? 0);
    const p = projectFiducial({
      tiltDeg: frame.tiltDeg,
      u0: actualTrack.u0,
      z: actualTrack.z,
      axisAngleDeg: g.axisAngleDeg,
      axisOffsetPx: g.axisOffsetPx,
      center: g.imageCenter,
      driftU,
      driftN,
    });
    const noise = () => (rand() - 0.5) * g.noisePx;
    put(p.x + noise(), p.y + noise(), 190, 1);
  }
  // 轴线标记线（淡），帮助帧叠影审阅
  const th = deg2rad(g.axisAngleDeg);
  for (let t = -40; t <= 40; t++) {
    const u = t;
    const n = g.axisOffsetPx;
    const x = Math.round(g.imageCenter.x + Math.cos(th) * u - Math.sin(th) * n);
    const y = Math.round(g.imageCenter.y + Math.sin(th) * u + Math.cos(th) * n);
    if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = 70;
  }
  return encodePGM(w, h, px);
}
