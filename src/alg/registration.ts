import type { MarkerObservation, PerFrameResidual, TiltAxisParams, TrackSegment } from '../core/domain.js';
import { describeAxis, type FrameTransformVars, type GlobalAxis, type Marker3D, projectObservation } from './geometry.js';

export interface AlignmentFrame {
  frameIndex: number;
  tiltRad: number;
  available: boolean;
}

export interface FitOptions {
  width: number;
  height: number;
  frames: AlignmentFrame[];
  segments: TrackSegment[];
  useWarp: boolean;
  identityMap?: Record<string, number>;
  excludedFrames?: Set<number>;
  seedZ?: number[];
  axisGuess?: { thetaDeg: number; cx: number; cy: number };
  maxIterations?: number;
}

export interface FittedFrameModel {
  frameIndex: number;
  vars: FrameTransformVars;
  rmsPx: number;
}

export interface FitSolution {
  thetaRad: number;
  axis: TiltAxisParams;
  perFrame: FittedFrameModel[];
  markers: Marker3D[];
  identityMap: Record<string, number>;
  perObsResidual: Array<{ frameIndex: number; trackId: string; dx: number; dy: number; r: number; used: boolean }>;
  overallRmsPx: number;
  usedObservationCount: number;
  degreesOfFreedom: number;
}

const RAD = Math.PI / 180;

function obsPoint(obs: MarkerObservation): { x: number; y: number } | null {
  return obs.normalized;
}

export function fitAlignment(opts: FitOptions): FitSolution {
  const { width, height, frames, segments, useWarp } = opts;
  const excluded = opts.excludedFrames ?? new Set<number>();
  const trackIds = segments.map((seg) => seg.trackId);
  const identityMap = opts.identityMap ?? Object.fromEntries(trackIds.map((id, i) => [id, i]));
  const markerCount = trackIds.length;
  const activeFrames = frames.filter((f) => f.available && !excluded.has(f.frameIndex));

  interface Obs {
    frameIndex: number;
    marker: number;
    x: number;
    y: number;
    trackId: string;
  }
  const observations: Obs[] = [];
  for (const seg of segments) {
    for (const o of seg.observations) {
      const point = obsPoint(o);
      if (!point) continue;
      const frame = frames.find((f) => f.frameIndex === o.frameIndex);
      if (!frame?.available || excluded.has(o.frameIndex)) continue;
      observations.push({ frameIndex: o.frameIndex, marker: identityMap[seg.trackId] ?? 0, x: point.x, y: point.y, trackId: seg.trackId });
    }
  }

  const theta0 = (opts.axisGuess?.thetaDeg ?? 0) * RAD;
  const cx0 = opts.axisGuess?.cx ?? width / 2;
  const cy0 = opts.axisGuess?.cy ?? height / 2;
  const seedZ = opts.seedZ ?? trackIds.map((_, i) => (i - (markerCount - 1) / 2) * 6);

  const params: number[] = [theta0, cx0, cy0];
  const frameBase = params.length;
  const frameStride = useWarp ? 5 : 3;
  for (const f of activeFrames) {
    void f;
    params.push(0, 0, 0, ...(useWarp ? [0, 0] : []));
  }
  const markerBase = params.length;
  for (let i = 0; i < markerCount; i++) {
    params.push((i % 4) * 14 - width * 0.18, (Math.floor(i / 4) - 1) * 12, seedZ[i] ?? 0);
  }

  const frameIndexInParams = new Map<number, number>();
  activeFrames.forEach((f, k) => frameIndexInParams.set(f.frameIndex, frameBase + k * frameStride));

  function unpack(p: number[]) {
    const axis: GlobalAxis = { theta: p[0], cx: p[1], cy: p[2] };
    const frameVars = new Map<number, FrameTransformVars>();
    activeFrames.forEach((f, k) => {
      const b = frameBase + k * frameStride;
      frameVars.set(f.frameIndex, {
        along: p[b],
        off: p[b + 1],
        rot: p[b + 2],
        warpQAlong: useWarp ? p[b + 3] : 0,
        warpQOff: useWarp ? p[b + 4] : 0,
      });
    });
    const markers: Marker3D[] = [];
    for (let i = 0; i < markerCount; i++) {
      const b = markerBase + i * 3;
      markers.push({ x: p[b], y: p[b + 1], z: p[b + 2] });
    }
    return { axis, frameVars, markers };
  }

  function residuals(p: number[], huberK = Infinity): { r: number[]; weights: number[] } {
    const { axis, frameVars, markers } = unpack(p);
    const raw: number[] = [];
    const weights: number[] = [];
    for (const o of observations) {
      const vars = frameVars.get(o.frameIndex);
      if (!vars) continue;
      const tilt = activeFrames.find((f) => f.frameIndex === o.frameIndex)!;
      const pred = projectObservation(axis, { tiltRad: tilt.tiltRad, vars, warp: useWarp }, markers[o.marker]);
      const dx = pred.x - o.x;
      const dy = pred.y - o.y;
      let w = 1;
      if (Number.isFinite(huberK)) {
        const rr = Math.hypot(dx, dy);
        if (rr > huberK) w = huberK / rr;
      }
      raw.push(dx, dy);
      weights.push(w, w);
    }
    for (const f of activeFrames) {
      const b = frameIndexInParams.get(f.frameIndex)!;
      raw.push(p[b] * 0.02, p[b + 1] * 0.02, p[b + 2] * 1.0);
      weights.push(1, 1, 1);
      if (useWarp) {
        raw.push(p[b + 3] * 500, p[b + 4] * 500);
        weights.push(1, 1);
      }
    }
    return { r: raw, weights };
  }

  function cost(p: number[], huberK = Infinity): number {
    const { r, weights } = residuals(p, huberK);
    let sum = 0;
    for (let i = 0; i < r.length; i++) sum += weights[i] * r[i] * r[i];
    return sum;
  }

  // ---- LM 主循环（数值雅可比 + 稳健 Huber 权） ----
  let lambda = 1e-3;
  let current = params.slice();
  const maxIter = opts.maxIterations ?? 24;
  let huberK = Infinity;
  for (let iter = 0; iter < maxIter; iter++) {
    const { r, weights } = residuals(current, huberK);
    const n = r.length;
    const m = current.length;
    // 数值雅可比
    const eps = 1e-5;
    const J: Float64Array[] = new Array(n);
    for (let row = 0; row < n; row++) J[row] = new Float64Array(m);
    for (let col = 0; col < m; col++) {
      const step = Math.max(eps, Math.abs(current[col]) * eps);
      const trial = current.slice();
      trial[col] += step;
      const rr = residuals(trial, huberK).r;
      for (let row = 0; row < n; row++) J[row][col] = ((rr[row] - r[row]) / step) * Math.sqrt(weights[row]);
    }
    // 正规方程 JtJ, Jtr
    const JtJ = Array.from({ length: m }, () => new Float64Array(m));
    const Jtr = new Float64Array(m);
    for (let row = 0; row < n; row++) {
      const wr = Math.sqrt(weights[row]) * r[row];
      for (let col = 0; col < m; col++) {
        Jtr[col] -= J[row][col] * wr;
        for (let k = 0; k <= col; k++) {
          JtJ[col][k] += J[row][col] * J[row][k];
        }
      }
    }
    let accepted = false;
    let tries = 0;
    while (!accepted && tries < 8) {
      const A = JtJ.map((row, i) => {
        const copy = Float64Array.from(row);
        for (let k = i + 1; k < m; k++) copy[k] = JtJ[k][i];
        copy[i] += lambda * Math.max(JtJ[i][i], 1e-8);
        return copy;
      });
      const delta = solveLinear(A, Float64Array.from(Jtr));
      if (!delta) break;
      const trial = current.map((v, i) => v + delta[i]);
      if (cost(trial, huberK) < cost(current, huberK)) {
        current = trial;
        lambda = Math.max(lambda * 0.3, 1e-9);
        accepted = true;
      } else {
        lambda *= 4;
        tries++;
      }
    }
    if (!accepted) break;
    if (iter === 6) huberK = 4; // 稳健化，压低坏帧影响
  }

  const { axis, frameVars, markers } = unpack(current);
  const perObs = residuals(current, Infinity).r;
  const perObsResidual: FitSolution['perObsResidual'] = [];
  let row = 0;
  for (const o of observations) {
    const used = !excluded.has(o.frameIndex);
    const dx = perObs[row];
    const dy = perObs[row + 1];
    perObsResidual.push({ frameIndex: o.frameIndex, trackId: o.trackId, dx, dy, r: Math.hypot(dx, dy), used });
    row += 2;
  }

  const perFrame: FittedFrameModel[] = activeFrames.map((f) => {
    const rs = perObsResidual.filter((p) => p.frameIndex === f.frameIndex);
    const mean = rs.length ? Math.sqrt(rs.reduce((sum, p) => sum + p.r * p.r, 0) / rs.length) : 0;
    return { frameIndex: f.frameIndex, vars: frameVars.get(f.frameIndex)!, rmsPx: mean };
  });

  const usedR = perObsResidual.filter((p) => p.used);
  const overallRmsPx = usedR.length
    ? Math.sqrt(usedR.reduce((sum, p) => sum + p.r * p.r, 0) / usedR.length)
    : 0;
  const dataCount = usedR.length * 2;
  const degreesOfFreedom = Math.max(0, dataCount - current.length);

  return {
    thetaRad: current[0],
    axis: describeAxis(axis, width, height),
    perFrame,
    markers,
    identityMap,
    perObsResidual,
    overallRmsPx,
    usedObservationCount: usedR.length,
    degreesOfFreedom,
  };
}

/** Cholesky 解对称正定方程；奇异时返回 null（多解退化会触发） */
function solveLinear(Ain: Float64Array[], bin: Float64Array): number[] | null {
  const n = bin.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  const A = Ain.map((r) => Float64Array.from(r));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 1e-12) return null;
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = bin[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
    y[i] = sum / L[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return Array.from(x);
}

export function perFrameResiduals(solution: FitSolution, allFrames: AlignmentFrame[], excludedFrames: Set<number>): PerFrameResidual[] {
  return allFrames.map((f) => {
    if (!f.available) {
      return { frameIndex: f.frameIndex, rmsPx: Number.NaN, used: false, excludedReason: 'missing-high-tilt' };
    }
    if (excludedFrames.has(f.frameIndex)) {
      const rs = solution.perObsResidual.filter((p) => p.frameIndex === f.frameIndex);
      const rms = rs.length ? Math.sqrt(rs.reduce((s, p) => s + p.r * p.r, 0) / rs.length) : Number.NaN;
      return { frameIndex: f.frameIndex, rmsPx: rms, used: false, excludedReason: 'bad-frame' };
    }
    const fitted = solution.perFrame.find((p) => p.frameIndex === f.frameIndex);
    return { frameIndex: f.frameIndex, rmsPx: fitted?.rmsPx ?? 0, used: true };
  });
}
