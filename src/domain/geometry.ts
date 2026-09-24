import type { ID } from './types';

/**
 * 倾转几何与配准候选求解。
 *
 * 图像坐标基准 px@originTopLeft：x 向右、y 向下。
 * 轴参数化：y=0 处截距 a(px) + 方向 phi(deg)。
 *   u = (x-a)cos phi + y sin phi   沿倾转运动方向
 *   v = -(x-a)sin phi + y cos phi  垂直轴线（对同一 marker 恒定）
 * 刚体模型：u(t)=u0 + z sin t，v(t)=v0，外加每帧共同平移。
 */

export interface Obs {
  markerId: ID;
  frameSeq: number;
  x: number;
  y: number;
}

export interface AxisParams {
  orientationDeg: number;
  interceptXPx: number;
}

export interface SolveResult {
  axis: AxisParams;
  kind: 'rigid' | 'local-warp';
  residualsByFrame: Record<number, number>;
  rms: number;
  maxResidual: number;
  shifts: Record<number, [number, number]>;
  perFrameAffine?: Record<number, number[]>;
  degreesOfFreedom: number;
  pairCount: number;
}

const D2R = Math.PI / 180;

export function toUV(x: number, y: number, phiDeg: number, a: number): [number, number] {
  const p = phiDeg * D2R, c = Math.cos(p), s = Math.sin(p);
  return [(x - a) * c + y * s, -(x - a) * s + y * c];
}
export function toXY(u: number, v: number, phiDeg: number, a: number): [number, number] {
  const p = phiDeg * D2R, c = Math.cos(p), s = Math.sin(p);
  return [a + u * c - v * s, u * s + v * c];
}

interface FrameData {
  seq: number;
  sinT: number;
  obs: Map<ID, { x: number; y: number }>;
}

function build(pairs: Obs[], anglesDeg: Record<number, number>): { frames: FrameData[]; markers: ID[] } {
  const byFrame = new Map<number, FrameData>();
  for (const p of pairs) {
    let fr = byFrame.get(p.frameSeq);
    if (!fr) {
      fr = { seq: p.frameSeq, sinT: Math.sin((anglesDeg[p.frameSeq] ?? 0) * D2R), obs: new Map() };
      byFrame.set(p.frameSeq, fr);
    }
    fr.obs.set(p.markerId, { x: p.x, y: p.y });
  }
  return { frames: [...byFrame.values()].sort((a, b) => a.seq - b.seq),
           markers: [...new Set(pairs.map((p) => p.markerId))].sort() };
}

function ls2(x: number[], y: number[]): [number, number] {
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const n = y.length;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const det = n * sxx - sx * sx || 1e-12;
  const b = (n * sxy - sx * sy) / det;
  return [(sy - b * sx) / n, b];
}

/** 用当前轴与（可选）每帧仿射，对每个 marker 拟合轨迹模型并返回模型点 */
function fitTracks(
  frames: FrameData[], markers: ID[], phi: number, a: number,
  affine?: Record<number, number[]>
) {
  const model = new Map<string, { x: number; y: number }>();
  const params = new Map<ID, { u0: number; z: number; v0: number }>();
  for (const m of markers) {
    const us: number[] = [], vs: number[] = [], st: number[] = [];
    for (const fr of frames) {
      const o = fr.obs.get(m);
      if (!o) continue;
      const p = affineWarp(o.x, o.y, affine?.[fr.seq]);
      const [u, v] = toUV(p.x, p.y, phi, a);
      us.push(u); vs.push(v); st.push(fr.sinT);
    }
    if (us.length < 2) continue;
    const [u0, z] = us.length >= 3 ? ls2(st, us) : [mean(us), 0];
    const v0 = mean(vs);
    params.set(m, { u0, z, v0 });
    for (const fr of frames) {
      if (!fr.obs.has(m)) continue;
      const [px, py] = toXY(u0 + z * fr.sinT, v0, phi, a);
      model.set(`${m}@${fr.seq}`, { x: px, y: py });
    }
  }
  return { model, params };
}

function affineWarp(x: number, y: number, af?: number[]): { x: number; y: number } {
  if (!af) return { x, y };
  return { x: af[0] * x + af[1] * y + af[2], y: af[3] * x + af[4] * y + af[5] };
}

function residuals(
  frames: FrameData[], phi: number, a: number, model: Map<string, { x: number; y: number }>,
  affine?: Record<number, number[]>
) {
  const byFrame: Record<number, { sum: number; n: number }> = {};
  let sumSq = 0, count = 0, mx = 0;
  for (const fr of frames) byFrame[fr.seq] = { sum: 0, n: 0 };
  for (const fr of frames) {
    for (const m of fr.obs.keys()) {
      const o = fr.obs.get(m)!;
      const t = model.get(`${m}@${fr.seq}`);
      if (!t) continue;
      const w = affineWarp(o.x, o.y, affine?.[fr.seq]);
      const d = Math.hypot(t.x - w.x, t.y - w.y);
      byFrame[fr.seq].sum += d * d;
      byFrame[fr.seq].n++;
      sumSq += d * d; count++; mx = Math.max(mx, d);
    }
  }
  const residualsByFrame: Record<number, number> = {};
  for (const fr of frames) {
    const e = byFrame[fr.seq];
    residualsByFrame[fr.seq] = e.n ? Math.sqrt(e.sum / e.n) : 0;
  }
  return { residualsByFrame, rms: Math.sqrt(sumSq / Math.max(1, count)), maxResidual: mx, count };
}

/** 每帧把观测点吸到模型点的 2x3 仿射（需每帧 >=3 个 marker） */
function fitAffines(frames: FrameData[], model: Map<string, { x: number; y: number }>): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const fr of frames) {
    const ATA = Array.from({ length: 6 }, () => Array(6).fill(0));
    const rx = Array(6).fill(0), ry = Array(6).fill(0);
    let n = 0;
    for (const m of fr.obs.keys()) {
      const o = fr.obs.get(m)!;
      const t = model.get(`${m}@${fr.seq}`);
      if (!t) continue;
      const rx6 = [o.x, o.y, 1, 0, 0, 0], ry6 = [0, 0, 0, o.x, o.y, 1];
      for (let i = 0; i < 6; i++) {
        rx[i] += rx6[i] * t.x; ry[i] += ry6[i] * t.y;
        for (let j = 0; j < 6; j++) ATA[i][j] += rx6[i] * rx6[j] + ry6[i] * ry6[j];
      }
      n++;
    }
    out[fr.seq] = n >= 3 ? gauss6(ATA, combineRhs(rx, ry)) : [1, 0, 0, 0, 1, 0];
  }
  return out;
}

function combineRhs(rx: number[], ry: number[]): number[] {
  // 同时求解两右侧：拼成 12 维返回，由 gauss6 处理
  return [...rx, ...ry];
}

function gauss6(ATA: number[][], rhs: number[]): number[] {
  // rhs = [rhsX(6), rhsY(6)]
  const n = 6;
  const M = ATA.map((row) => [...row]);
  const X = Array.from({ length: n }, () => [0, 0]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    [rhs[col], rhs[piv]] = [rhs[piv], rhs[col]];
    [rhs[col + 6], rhs[piv + 6]] = [rhs[piv + 6], rhs[col + 6]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / (M[col][col] || 1e-12);
      for (let k = col; k < n; k++) M[r][k] -= f * M[col][k];
      rhs[r] -= f * rhs[col];
      rhs[r + 6] -= f * rhs[col + 6];
    }
  }
  for (let i = 0; i < n; i++) X[i] = [rhs[i] / (M[i][i] || 1e-12), rhs[i + 6] / (M[i][i] || 1e-12)];
  // 返回 [a,b,c, d,e,f] 使 x'=ax+by+c, y'=dx+ey+f
  return [X[0][0], X[1][0], X[2][0], X[0][1], X[1][1], X[2][1]];
}

function mean(x: number[]): number {
  return x.reduce((s, v) => s + v, 0) / x.length;
}

export function solve(
  pairs: Obs[],
  anglesDeg: Record<number, number>,
  widthPx: number,
  opts: { warp: boolean; axisGuess?: AxisParams | null }
): SolveResult {
  const { frames, markers } = build(pairs, anglesDeg);

  const evaluate = (phiDeg: number, a: number): SolveResult => {
    let affine: Record<number, number[]> | undefined = opts.warp ? {} : undefined;
    let model = fitTracks(frames, markers, phiDeg, a, affine).model;
    let res = residuals(frames, phiDeg, a, model, affine);
    for (let iter = 0; iter < 12; iter++) {
      if (opts.warp) {
        affine = fitAffines(frames, model);
        model = fitTracks(frames, markers, phiDeg, a, affine).model;
      } else {
        // 刚体：每帧共同平移 = 模型点 - 观测点 的平均；通过单点仿射 (c,f) 迭代实现
        const shiftsOnly: Record<number, number[]> = {};
        for (const fr of frames) {
          let dx = 0, dy = 0, n = 0;
          for (const m of fr.obs.keys()) {
            const o = fr.obs.get(m)!;
            const t = model.get(`${m}@${fr.seq}`);
            if (!t) continue;
            dx += t.x - o.x; dy += t.y - o.y; n++;
          }
          shiftsOnly[fr.seq] = [1, 0, n ? dx / n : 0, 0, 1, n ? dy / n : 0];
        }
        affine = shiftsOnly;
        model = fitTracks(frames, markers, phiDeg, a, affine).model;
      }
      const next = residuals(frames, phiDeg, a, model, affine);
      if (Math.abs(next.rms - res.rms) < 1e-9) { res = next; break; }
      res = next;
    }
    const shifts: Record<number, [number, number]> = {};
    for (const fr of frames) shifts[fr.seq] = [affine?.[fr.seq]?.[2] ?? 0, affine?.[fr.seq]?.[5] ?? 0];
    return {
      axis: { orientationDeg: phiDeg, interceptXPx: a },
      kind: opts.warp ? 'local-warp' : 'rigid',
      residualsByFrame: res.residualsByFrame, rms: res.rms, maxResidual: res.maxResidual,
      shifts, perFrameAffine: opts.warp ? affine : undefined,
      degreesOfFreedom: (opts.warp ? 6 : 2) * frames.length + 2,
      pairCount: res.count
    };
  };

  if (opts.axisGuess) return evaluate(opts.axisGuess.orientationDeg, opts.axisGuess.interceptXPx);

  let best: SolveResult | null = null;
  for (let round = 0; round < 3; round++) {
    const phiStep = round === 0 ? 5 : round === 1 ? 1 : 0.25;
    const aStep = round === 0 ? widthPx * 0.1 : round === 1 ? widthPx * 0.02 : widthPx * 0.005;
    const phiC = best ? best.axis.orientationDeg : 0;
    const aC = best ? best.axis.interceptXPx : widthPx * 0.5;
    const phiRange = round === 0 ? 35 : phiStep * 2;
    const aRange = round === 0 ? widthPx * 0.45 : aStep * 2;
    for (let phi = phiC - phiRange; phi <= phiC + phiRange + 1e-9; phi += phiStep) {
      for (let a = aC - aRange; a <= aC + aRange + 1e-9; a += aStep) {
        const r = evaluate(phi, a);
        if (!best || r.rms < best.rms) best = r;
      }
    }
  }
  return best!;
}

/** 给定轴（不重新搜索）评估；只对 shiftFrameSeqs 施加每帧平移，其余帧不平移 */
export function rigidResidual(
  pairs: Obs[],
  anglesDeg: Record<number, number>,
  axis: AxisParams,
  shiftFrameSeqs: number[]
): { residualsByFrame: Record<number, number>; rms: number; maxResidual: number; pairCount: number; shifts: Record<number,[number,number]> } {
  const { frames, markers } = build(pairs, anglesDeg);
  const allow = new Set(shiftFrameSeqs);
  const affine: Record<number, number[]> = {};
  let model = fitTracks(frames, markers, axis.orientationDeg, axis.interceptXPx, undefined).model;
  for (let iter = 0; iter < 8; iter++) {
    for (const fr of frames) {
      if (!allow.has(fr.seq)) { affine[fr.seq] = [1, 0, 0, 0, 1, 0]; continue; }
      let dx = 0, dy = 0, n = 0;
      for (const m of fr.obs.keys()) {
        const o = fr.obs.get(m)!;
        const t = model.get(`${m}@${fr.seq}`);
        if (!t) continue;
        dx += t.x - o.x; dy += t.y - o.y; n++;
      }
      affine[fr.seq] = [1, 0, n ? dx / n : 0, 0, 1, n ? dy / n : 0];
    }
    const nm = fitTracks(frames, markers, axis.orientationDeg, axis.interceptXPx, affine).model;
    const same = [...nm.entries()].every(([k, v]) => {
      const p = model.get(k); return p && Math.hypot(p.x - v.x, p.y - v.y) < 1e-8;
    });
    model = nm;
    if (same) break;
  }
  const r = residuals(frames, axis.orientationDeg, axis.interceptXPx, model, affine);
  const shifts: Record<number, [number, number]> = {};
  for (const fr of frames) shifts[fr.seq] = [affine[fr.seq][2], affine[fr.seq][5]];
  return { ...r, shifts };
}
