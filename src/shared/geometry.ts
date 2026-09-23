import type { CandidateReport, MarkerObservation, Quantity, RuleCode } from './types';

export interface TiltFrameGeom {
  frameId: string;
  tiltAngleDeg: number;
  acquired: boolean;
}

export interface SolveOptions {
  frames: TiltFrameGeom[];
  tracks: Record<string, MarkerObservation[]>;
  width: number;
  height: number;
  identityMap?: Record<string, string>;
  excludedFrames?: string[];
  forceCenterAxis?: boolean;
  localWarp?: boolean;
  holdoutFraction?: number;
  betaStart?: number;
}

export interface SolveResult {
  axisAngleDeg: number;
  axisOffsetXPx: number;
  axisOffsetYPx: number;
  perFrame: { frameId: string; tx: number; ty: number; rot: number; warp: number[] }[];
  trackPoints: Record<string, { x: number; y: number }>;
  frameResiduals: CandidateReport['frameResiduals'];
  trainRmsPx: number;
  heldoutRmsPx: number;
  observationsUsed: number;
  framesUsed: number;
  rows: { frameId: string; markerId: string; axis: 'x' | 'y'; r: number; holdout: boolean }[];
}

interface Obs {
  markerId: string;
  frameId: string;
  x: number;
  y: number;
  holdout: boolean;
}

function solveNormal(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) continue;
    [A[piv], A[col]] = [A[col], A[piv]];
    [b[piv], b[col]] = [b[col], b[piv]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => (Math.abs(A[i][i]) < 1e-12 ? 0 : v / A[i][i]));
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function solveRegistration(opts: SolveOptions): SolveResult {
  const { width, height } = opts;
  const excluded = new Set(opts.excludedFrames ?? []);
  const frames = opts.frames.filter((f) => f.acquired && !excluded.has(f.frameId));
  const thetaByFrame = new Map(frames.map((f) => [f.frameId, (f.tiltAngleDeg * Math.PI) / 180]));

  const observations: Obs[] = [];
  for (const markerId of Object.keys(opts.tracks).sort()) {
    const mapped = opts.identityMap?.[markerId] ?? markerId;
    for (const o of opts.tracks[markerId]) {
      if (!thetaByFrame.has(o.frameId)) continue;
      observations.push({
        markerId: mapped,
        frameId: o.frameId,
        x: o.x,
        y: o.y,
        holdout: ((hashStr(markerId + '|' + o.frameId) % 100) / 100) < (opts.holdoutFraction ?? 0)
      });
    }
  }
  const usedTracks = [...new Set(observations.map((o) => o.markerId))].sort();

  const warpDof = opts.localWarp ? 2 : 0;
  const perFrameDof = 3 + warpDof;
  const tBase = usedTracks.length * 2;
  const fIndex = new Map(frames.map((f, i) => [f.frameId, i]));
  const mIndex = new Map(usedTracks.map((m, i) => [m, i]));
  const globalBeta = tBase + frames.length * perFrameDof;
  const globalX0 = globalBeta + 1;
  const nUnknown = globalX0 + 1;

  let beta = (opts.betaStart ?? 0) * Math.PI / 180;
  let x0 = width / 2;
  const y0 = height / 2;
  const params = new Array(nUnknown).fill(0);

  for (let iter = 0; iter < 10; iter++) {
    const A = Array.from({ length: nUnknown }, () => new Array(nUnknown).fill(0));
    const b = new Array(nUnknown).fill(0);

    for (const o of observations) {
      if (o.holdout) continue;
      const theta = thetaByFrame.get(o.frameId)!;
      const fi = fIndex.get(o.frameId)!;
      const mi = mIndex.get(o.markerId)!;
      const fx = tBase + fi * perFrameDof;
      const fy = fx + 1;
      const fr = fx + 2;
      const pw0 = fx + 3;
      const pw1 = fx + 4;
      const xd = o.x - x0;
      const yd = o.y - y0;
      const alpha = beta - theta;
      const c = Math.cos(alpha);
      const s = Math.sin(alpha);
      const X = params[2 * mi];
      const Y = params[2 * mi + 1];
      const w0 = opts.localWarp ? params[pw0] : 0;
      const w1 = opts.localWarp ? params[pw1] : 0;
      const d = w0 * (xd / width) + w1 * (xd / width) ** 2;
      const ddx = w0 / width + (2 * w1 * xd) / width ** 2;

      const predx = x0 + c * X + s * Y + params[fx] + d - params[fr] * yd;
      const predy = y0 - s * X + c * Y + params[fy] + params[fr] * xd;
      const rx = o.x - predx;
      const ry = o.y - predy;

      const gx: Record<number, number> = {
        [2 * mi]: -c,
        [2 * mi + 1]: -s,
        [fx]: -1,
        [fr]: yd,
        [globalBeta]: -(s * X - c * Y),
        [globalX0]: -1 + ddx
      };
      const gy: Record<number, number> = {
        [2 * mi]: s,
        [2 * mi + 1]: -c,
        [fy]: -1,
        [fr]: -xd,
        [globalBeta]: -(-c * X - s * Y),
        [globalX0]: -params[fr]
      };
      if (opts.localWarp) {
        gx[pw0] = -(xd / width);
        gx[pw1] = -(xd / width) ** 2;
      }
      for (const [iiStr, gi] of Object.entries(gx)) {
        const ii = Number(iiStr);
        b[ii] += gi * rx;
        for (const [jjStr, gj] of Object.entries(gx)) A[ii][Number(jjStr)] += gi * gj;
      }
      for (const [iiStr, gi] of Object.entries(gy)) {
        const ii = Number(iiStr);
        b[ii] += gi * ry;
        for (const [jjStr, gj] of Object.entries(gy)) A[ii][Number(jjStr)] += gi * gj;
      }
    }

    if (opts.forceCenterAxis) {
      A[globalX0][globalX0] += 1e9;
      b[globalX0] += (width / 2 - x0) * 1e9;
    }
    const delta = solveNormal(A, b);
    for (let i = 0; i < nUnknown; i++) params[i] += delta[i];
    beta += delta[globalBeta];
    x0 += delta[globalX0];
    if (Math.abs(delta[globalBeta]) < 1e-10 && Math.abs(delta[globalX0]) < 1e-8) break;
  }

  const trackPoints: Record<string, { x: number; y: number }> = {};
  for (const [m, i] of mIndex) trackPoints[m] = { x: params[2 * i], y: params[2 * i + 1] };
  const perFrame = frames.map((f, i) => ({
    frameId: f.frameId,
    tx: params[tBase + i * perFrameDof],
    ty: params[tBase + i * perFrameDof + 1],
    rot: params[tBase + i * perFrameDof + 2],
    warp: opts.localWarp ? [params[tBase + i * perFrameDof + 3], params[tBase + i * perFrameDof + 4]] : []
  }));

  const rows: SolveResult['rows'] = [];
  const byFrame = new Map<string, { sum: number; n: number }>();
  let trainSum = 0, trainN = 0, holdSum = 0, holdN = 0;
  for (const o of observations) {
    const theta = thetaByFrame.get(o.frameId)!;
    const pf = perFrame[fIndex.get(o.frameId)!];
    const tp = trackPoints[o.markerId];
    const xd = o.x - x0;
    const yd = o.y - y0;
    const alpha = beta - theta;
    const c = Math.cos(alpha);
    const s = Math.sin(alpha);
    const d = opts.localWarp ? pf.warp[0] * xd / width + pf.warp[1] * (xd / width) ** 2 : 0;
    const rx = o.x - (x0 + c * tp.x + s * tp.y + pf.tx + d - pf.rot * yd);
    const ry = o.y - (y0 - s * tp.x + c * tp.y + pf.ty + pf.rot * xd);
    for (const axis of ['x', 'y'] as const) {
      const r = axis === 'x' ? rx : ry;
      rows.push({ frameId: o.frameId, markerId: o.markerId, axis, r, holdout: o.holdout });
      const cur = byFrame.get(o.frameId) ?? { sum: 0, n: 0 };
      cur.sum += r ** 2 / 2;
      cur.n += 0.5;
      byFrame.set(o.frameId, cur);
    }
    const r2 = (rx ** 2 + ry ** 2) / 2;
    if (o.holdout) { holdSum += r2; holdN++; } else { trainSum += r2; trainN++; }
  }

  return {
    axisAngleDeg: (beta * 180) / Math.PI,
    axisOffsetXPx: x0,
    axisOffsetYPx: y0,
    perFrame,
    trackPoints,
    frameResiduals: frames.map((f) => {
      const s = byFrame.get(f.frameId) ?? { sum: 0, n: 0 };
      return { frameId: f.frameId, rmsPx: s.n ? Math.sqrt(s.sum / s.n) : 0, observations: Math.round(s.n) };
    }),
    trainRmsPx: trainN ? Math.sqrt(trainSum / trainN) : NaN,
    heldoutRmsPx: holdN ? Math.sqrt(holdSum / holdN) : NaN,
    observationsUsed: observations.length,
    framesUsed: frames.length,
    rows
  };
}

export function makeQuantity(
  value: number | string | null,
  unit: Quantity['unit'],
  raw: string | number,
  rawUnit: string,
  basis: string,
  convertible: boolean,
  diagnostics: string[] = []
): Quantity {
  return { value, unit, raw, rawUnit, basis, convertible, diagnostics };
}

export function diag(code: RuleCode | string, severity: 'info' | 'warn' | 'fail', message: string, refs?: string[]) {
  return { code, severity, message, refs };
}
