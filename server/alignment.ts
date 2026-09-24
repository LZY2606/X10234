// 配准推导层：刚体 / 局部形变 / 排除坏帧 候选，统一在相同有效点集上比较。
export interface FrameInfo {
  frameId: string;
  tiltRad: number;
}
export interface Observation {
  frameId: string;
  x: number;
  y: number;
}
export interface Trajectory {
  id: string;
  observations: Observation[];
}
export interface FitInput {
  frames: FrameInfo[];
  trajectories: Trajectory[];
  axisOffsetPx: number;
  model: 'rigid' | 'local-deformation';
  excludeFrames?: Set<string>;
}
export interface FitResult {
  model: string;
  axisOffsetPx: number;
  usedFrames: string[];
  points: number;
  params: number;
  perFrame: Record<string, { rms: number; count: number }>;
  overallRms: number;
  residuals: Record<string, Record<string, { dx: number; dy: number }>>;
}

interface MarkerState {
  v: number; // 沿倾转方向位置（px，相对倾转轴）
  u: number; // 沿轴线方向位置
}

export function fitAlignment(input: FitInput): FitResult {
  const frames = input.frames.filter((f) => !input.excludeFrames?.has(f.frameId));
  const frameMap = new Map(frames.map((f) => [f.frameId, f]));
  const trajs = input.trajectories
    .map((t) => ({ id: t.id, obs: t.observations.filter((o) => frameMap.has(o.frameId)) }))
    .filter((t) => t.obs.length >= 2);

  const markers = new Map<string, MarkerState>();
  const zeroFrame = frames.reduce((a, b) => (Math.abs(a.tiltRad) <= Math.abs(b.tiltRad) ? a : b));
  for (const t of trajs) {
    const o = t.obs.find((k) => k.frameId === zeroFrame.frameId) ?? t.obs[0];
    const f = frameMap.get(o.frameId)!;
    markers.set(t.id, { v: (o.x - input.axisOffsetPx) / Math.cos(f.tiltRad), u: o.y - input.axisOffsetPx * 0 });
  }

  const shifts = new Map<string, { tx: number; ty: number; s: number }>();
  for (const f of frames) shifts.set(f.frameId, { tx: 0, ty: 0, s: 1 });

  for (let iter = 0; iter < 12; iter++) {
    // 逐帧平移（局部形变额外求解逐帧尺度）
    for (const f of frames) {
      const obs = trajs.flatMap((t) => t.obs.filter((o) => o.frameId === f.frameId).map((o) => ({ t: t.id, o })));
      if (obs.length === 0) continue;
      const c = Math.cos(f.tiltRad);
      if (input.model === 'local-deformation' && obs.length >= 2) {
        let sa = 0, saa = 0, sax = 0, sx = 0, say = 0, sy = 0;
        const n = obs.length;
        for (const { t, o } of obs) {
          const m = markers.get(t)!;
          const a = m.v * c;
          sa += a; saa += a * a; sax += a * o.x; sx += o.x; say += o.y; sy += m.u;
        }
        const det = saa * n - sa * sa;
        const s = Math.abs(det) > 1e-9 ? (sax * n - sa * sx) / det : 1;
        const tx = Math.abs(det) > 1e-9 ? (saa * sx - sa * sax) / det : sx / n - sa / n;
        shifts.set(f.frameId, { tx, ty: say / n - sy / n, s });
      } else {
        let dx = 0, dy = 0;
        for (const { t, o } of obs) {
          const m = markers.get(t)!;
          dx += o.x - (input.axisOffsetPx + m.v * c);
          dy += o.y - m.u;
        }
        shifts.set(f.frameId, { tx: dx / obs.length, ty: dy / obs.length, s: 1 });
      }
    }
    // 逐标记位置
    for (const t of trajs) {
      let numV = 0, denV = 0, numU = 0, n = 0;
      for (const o of t.obs) {
        const f = frameMap.get(o.frameId)!;
        const sh = shifts.get(o.frameId)!;
        const c = Math.cos(f.tiltRad) * sh.s;
        numV += (o.x - input.axisOffsetPx - sh.tx) * c;
        denV += c * c;
        numU += o.y - sh.ty;
        n++;
      }
      markers.set(t.id, { v: denV > 1e-9 ? numV / denV : 0, u: numU / n });
    }
  }

  const residuals: FitResult['residuals'] = {};
  const perFrame: FitResult['perFrame'] = {};
  let sumSq = 0, count = 0;
  for (const f of frames) {
    let fSq = 0, fN = 0;
    residuals[f.frameId] = {};
    for (const t of trajs) {
      for (const o of t.obs.filter((k) => k.frameId === f.frameId)) {
        const m = markers.get(t.id)!;
        const sh = shifts.get(f.frameId)!;
        const dx = o.x - (input.axisOffsetPx + sh.s * m.v * Math.cos(f.tiltRad) + sh.tx);
        const dy = o.y - (sh.s * m.u + sh.ty);
        residuals[f.frameId][t.id] = { dx, dy };
        fSq += dx * dx + dy * dy;
        fN++;
      }
    }
    if (fN > 0) perFrame[f.frameId] = { rms: Math.sqrt(fSq / (2 * fN)), count: fN };
    sumSq += fSq;
    count += fN;
  }
  const params =
    input.model === 'local-deformation' ? 2 * trajs.length + 3 * frames.length : 2 * trajs.length + 2 * frames.length;
  return {
    model: input.model,
    axisOffsetPx: input.axisOffsetPx,
    usedFrames: frames.map((f) => f.frameId),
    points: count,
    params,
    perFrame,
    overallRms: count > 0 ? Math.sqrt(sumSq / (2 * count)) : 0,
    residuals,
  };
}

export function pointKey(frameId: string, trajId: string): string {
  return `${frameId}|${trajId}`;
}

// 相同有效点集：所有候选共同使用的 (帧, 轨迹) 观测交集
export function commonEffectiveSet(results: FitResult[]): Set<string> {
  let common: Set<string> | null = null;
  for (const r of results) {
    const keys = new Set<string>();
    for (const [frameId, perTraj] of Object.entries(r.residuals)) {
      for (const trajId of Object.keys(perTraj)) keys.add(pointKey(frameId, trajId));
    }
    common = common === null ? keys : new Set([...common].filter((k) => keys.has(k)));
  }
  return common ?? new Set();
}

export function rmsOnSet(result: FitResult, set: Set<string>): number {
  let sumSq = 0, n = 0;
  for (const [frameId, perTraj] of Object.entries(result.residuals)) {
    for (const [trajId, r] of Object.entries(perTraj)) {
      if (set.has(pointKey(frameId, trajId))) {
        sumSq += r.dx * r.dx + r.dy * r.dy;
        n++;
      }
    }
  }
  return n > 0 ? Math.sqrt(sumSq / (2 * n)) : 0;
}

export interface AxisScanResult {
  centerPx: number;
  bestOffsetPx: number;
  centerRms: number;
  bestRms: number;
  minima: number[]; // 与全局最优相当（<2%）的局部极小，间隔 >1.5px 即视为多解
}

export function scanAxisOffset(
  frames: FrameInfo[],
  trajectories: Trajectory[],
  centerPx: number,
  rangePx = 6,
  step = 0.25,
): AxisScanResult {
  const samples: { x: number; rms: number }[] = [];
  for (let dx = -rangePx; dx <= rangePx + 1e-9; dx += step) {
    const cx = centerPx + dx;
    const r = fitAlignment({ frames, trajectories, axisOffsetPx: cx, model: 'rigid' });
    samples.push({ x: cx, rms: r.overallRms });
  }
  const centerRms = fitAlignment({ frames, trajectories, axisOffsetPx: centerPx, model: 'rigid' }).overallRms;
  let best = samples[0];
  for (const s of samples) if (s.rms < best.rms) best = s;
  const minima: number[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const s = samples[i];
    if (s.rms <= samples[i - 1].rms && s.rms <= samples[i + 1].rms && s.rms <= best.rms * 1.02) {
      if (minima.every((m) => Math.abs(m - s.x) > 1.5)) minima.push(s.x);
    }
  }
  if (minima.length === 0) minima.push(best.x);
  return { centerPx, bestOffsetPx: best.x, centerRms, bestRms: best.rms, minima };
}

export interface SwapDetection {
  trajA: string;
  trajB: string;
  swapFrame: string;
  rmsBefore: number;
  rmsAfter: number;
}

// fiducial 轨迹可断裂且可能身份交换：在交叉帧后交换两段轨迹后缀，检验残差是否改善
export function detectIdentitySwap(
  frames: FrameInfo[],
  trajectories: Trajectory[],
  axisOffsetPx: number,
): SwapDetection | null {
  let best: SwapDetection | null = null;
  for (let i = 0; i < trajectories.length; i++) {
    for (let j = i + 1; j < trajectories.length; j++) {
      const a = trajectories[i], b = trajectories[j];
      const commonFrames = a.observations
        .map((o) => o.frameId)
        .filter((f) => b.observations.some((o) => o.frameId === f));
      for (const frameId of commonFrames) {
        const oa = a.observations.find((o) => o.frameId === frameId)!;
        const ob = b.observations.find((o) => o.frameId === frameId)!;
        const dist = Math.hypot(oa.x - ob.x, oa.y - ob.y);
        if (dist > 1.0) continue; // 仅在接近交叉处考虑交换
        const swapped: Trajectory[] = trajectories.map((t) => {
          if (t.id !== a.id && t.id !== b.id) return t;
          const other = t.id === a.id ? b : a;
          const idx = t.observations.findIndex((o) => o.frameId === frameId);
          const head = t.observations.slice(0, idx);
          const tail = other.observations.filter((o) => t.observations.findIndex((k) => k.frameId === o.frameId) >= idx);
          const tailFrames = new Set(t.observations.slice(idx).map((o) => o.frameId));
          return { id: t.id, observations: [...head, ...tail.filter((o) => tailFrames.has(o.frameId))] };
        });
        const before = fitAlignment({ frames, trajectories, axisOffsetPx, model: 'rigid' }).overallRms;
        const after = fitAlignment({ frames, trajectories: swapped, axisOffsetPx, model: 'rigid' }).overallRms;
        if (after < before * 0.9 && (!best || after < best.rmsAfter)) {
          best = { trajA: a.id, trajB: b.id, swapFrame: frameId, rmsBefore: before, rmsAfter: after };
        }
      }
    }
  }
  return best;
}
