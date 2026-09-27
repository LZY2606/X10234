/**
 * 倾转投影几何与配准拟合。
 *
 * 以估计轴为参考系（u 沿轴，v 垂直轴，轴偏心 offset 显式存在）：
 *   刚体：       u_i = Pu + t^u_i
 *                v_i = c_i Pv - s_i Pz + t^v_i
 *   局部形变：   u_i = (1+s^u_i) Pu + t^u_i
 *                v_i = (1+s^v_i)(c_i Pv - s_i Pz) + t^v_i
 *
 * 刚体每帧 2 个参数；局部形变每帧 4 个参数（自由度诊断据此区分）。
 * 固定轴时对帧参数与 3D 点做交替线性最小二乘。
 */

export interface Point2 {
  u: number;
  v: number;
}

export interface Observation3DInput {
  bead: number;
  frame: number;
  x: number;
  y: number;
  w: number;
  /** 该帧倾角（弧度） */
  theta: number;
}

export interface AxisSpec {
  /** 轴方向角（度），图像 X 轴起算 */
  axisAngleDeg: number;
  /** 轴法向截距（像素）——倾转轴相对图像中心的偏心，禁止默认 0 */
  offset: number;
}

export interface ResidualItem {
  bead: number;
  frame: number;
  r2: number;
}

export interface FitResult {
  axis: AxisSpec;
  points3d: Record<number, [number, number, number]>;
  /** frame -> [tu, tv] */
  translations: Record<number, [number, number]>;
  /** frame -> [su, sv]（刚体为 0,0） */
  localScale: Record<number, [number, number]>;
  residualSq: ResidualItem[];
  rms: number;
  degreesOfFreedom: number;
  used: number;
  excludedFrames: number[];
}

export function rotateToAxis(p: Point2, axis: AxisSpec): Point2 {
  const a = (-axis.axisAngleDeg * Math.PI) / 180;
  const u = Math.cos(a) * p.u - Math.sin(a) * p.v;
  const v0 = Math.sin(a) * p.u + Math.cos(a) * p.v;
  return { u, v: v0 - axis.offset };
}

export interface FitOptions {
  axis: AxisSpec;
  observations: Observation3DInput[];
  variant: 'rigid' | 'localDeform' | 'badFrameExcluded';
  excludeFrames?: number[];
  /** 局部形变正则化（0 = 完全自由，用于暴露过拟合） */
  localLambda?: number;
  iterations?: number;
}

export function fitRegistration(opts: FitOptions): FitResult {
  const exclude = new Set(opts.excludeFrames ?? []);
  const prepared = opts.observations
    .filter((o) => o.w > 0 && !exclude.has(o.frame))
    .map((o) => {
      const rp = rotateToAxis({ u: o.x, v: o.y }, opts.axis);
      return { bead: o.bead, frame: o.frame, u: rp.u, v: rp.v, w: o.w, theta: o.theta };
    });

  const beads = [...new Set(prepared.map((d) => d.bead))].sort((a, b) => a - b);
  const frames = [...new Set(prepared.map((d) => d.frame))].sort((a, b) => a - b);

  const p3: Record<number, [number, number, number]> = Object.fromEntries(
    beads.map((b) => [b, [0, 0, 0] as [number, number, number]])
  );
  const trans: Record<number, [number, number]> = Object.fromEntries(
    frames.map((f) => [f, [0, 0] as [number, number]])
  );
  const scale: Record<number, [number, number]> = Object.fromEntries(
    frames.map((f) => [f, [0, 0] as [number, number]])
  );
  const local = opts.variant === 'localDeform';
  const iters = opts.iterations ?? 8;

  for (let it = 0; it < iters; it++) {
    // --- 固定 3D 点，逐帧解 [tu(,su)] 与 [tv(,sv)]，u/v 独立 ---
    for (const f of frames) {
      const rows = prepared.filter((d) => d.frame === f);
      // u 通道
      {
        const Au: number[][] = [];
        const yu: number[] = [];
        for (const r of rows) {
          const [Pu] = p3[r.bead];
          Au.push(local ? [r.w, r.w * Pu] : [r.w]);
          yu.push(r.w * (r.u - Pu));
        }
        const sol = lstq(Au, yu, opts.localLambda ?? 0);
        trans[f][0] = sol[0] ?? 0;
        if (local) scale[f][0] = sol[1] ?? 0;
      }
      // v 通道
      {
        const Av: number[][] = [];
        const yv: number[] = [];
        for (const r of rows) {
          const [, Pv, Pz] = p3[r.bead];
          const proj = Math.cos(r.theta) * Pv - Math.sin(r.theta) * Pz;
          Av.push(local ? [r.w, r.w * proj] : [r.w]);
          yv.push(r.w * (r.v - proj));
        }
        const sol = lstq(Av, yv, opts.localLambda ?? 0);
        trans[f][1] = sol[0] ?? 0;
        if (local) scale[f][1] = sol[1] ?? 0;
      }
    }
    // --- 固定帧参数，逐 bead 解 [Pu, Pv, Pz] ---
    for (const b of beads) {
      const rows = prepared.filter((d) => d.bead === b);
      const A: number[][] = [];
      const y: number[] = [];
      for (const r of rows) {
        const [su, sv] = scale[r.frame];
        const [tu, tv] = trans[r.frame];
        const c = Math.cos(r.theta);
        const s = Math.sin(r.theta);
        A.push([r.w * (1 + su), 0, 0]);
        y.push(r.w * (r.u - tu));
        A.push([0, r.w * (1 + sv) * c, r.w * (1 + sv) * -s]);
        y.push(r.w * (r.v - tv));
      }
      const sol = lstq(A, y, 1e-9);
      p3[b] = [sol[0] ?? 0, sol[1] ?? 0, sol[2] ?? 0];
    }
  }

  const residualSq: ResidualItem[] = [];
  let acc = 0;
  let n = 0;
  for (const r of prepared) {
    const [Pu, Pv, Pz] = p3[r.bead];
    const [su, sv] = scale[r.frame];
    const [tu, tv] = trans[r.frame];
    const predU = (1 + su) * Pu + tu;
    const predV = (1 + sv) * (Math.cos(r.theta) * Pv - Math.sin(r.theta) * Pz) + tv;
    const du = r.u - predU;
    const dv = r.v - predV;
    const r2 = du * du + dv * dv;
    residualSq.push({ bead: r.bead, frame: r.frame, r2 });
    acc += r2;
    n++;
  }

  return {
    axis: opts.axis,
    points3d: p3,
    translations: trans,
    localScale: scale,
    residualSq,
    rms: n ? Math.sqrt(acc / n) : Number.POSITIVE_INFINITY,
    degreesOfFreedom: frames.length * (local ? 4 : 2) + beads.length * 3,
    used: n,
    excludedFrames: [...exclude].sort((a, b) => a - b)
  };
}

/** 给定拟合结果，计算某观测子集上的 RMS（公平比较共用） */
export function rmsOnSubset(fit: FitResult, include: { bead: number; frame: number }[]): number {
  const key = new Set(include.map((x) => `${x.bead}:${x.frame}`));
  const items = fit.residualSq.filter((r) => key.has(`${r.bead}:${r.frame}`));
  if (!items.length) return Number.POSITIVE_INFINITY;
  return Math.sqrt(items.reduce((a, r) => a + r.r2, 0) / items.length);
}

/** 每帧 RMS */
export function perFrameRms(fit: FitResult): Map<number, number> {
  const acc = new Map<number, { s: number; n: number }>();
  for (const r of fit.residualSq) {
    const e = acc.get(r.frame) ?? { s: 0, n: 0 };
    e.s += r.r2;
    e.n++;
    acc.set(r.frame, e);
  }
  const out = new Map<number, number>();
  for (const [f, e] of acc) out.set(f, e.n ? Math.sqrt(e.s / e.n) : Number.POSITIVE_INFINITY);
  return out;
}

/** 轴角 + 偏心网格搜索，返回所有在容差内的解（多解检测） */
export function searchAxis(
  observations: Observation3DInput[],
  options: {
    angleRange?: [number, number];
    angleStep?: number;
    offsetRange?: [number, number];
    offsetStep?: number;
    variant?: 'rigid' | 'localDeform';
    toleranceRatio?: number;
  } = {}
): { axis: AxisSpec; rms: number; alternatives: { axis: AxisSpec; rms: number }[] } {
  const [a0, a1] = options.angleRange ?? [-90, 90];
  const astep = options.angleStep ?? 2;
  const [o0, o1] = options.offsetRange ?? [-60, 60];
  const ostep = options.offsetStep ?? 4;
  const scored: { axis: AxisSpec; rms: number }[] = [];
  for (let ang = a0; ang <= a1 + 1e-9; ang += astep) {
    for (let off = o0; off <= o1 + 1e-9; off += ostep) {
      const fit = fitRegistration({
        axis: { axisAngleDeg: ang, offset: off },
        observations,
        variant: options.variant ?? 'rigid',
        iterations: 4
      });
      scored.push({ axis: { axisAngleDeg: ang, offset: off }, rms: fit.rms });
    }
  }
  scored.sort((p, q) => p.rms - q.rms);
  const best = scored[0];
  const tol = (options.toleranceRatio ?? 1.08) * best.rms;
  const alternatives = scored
    .slice(1)
    .filter((s) => s.rms <= tol)
    .filter((s) => Math.abs(s.axis.axisAngleDeg - best.axis.axisAngleDeg) > astep || Math.abs(s.axis.offset - best.axis.offset) > ostep)
    .slice(0, 8)
    .map((s) => ({ axis: s.axis, rms: s.rms }));
  return { axis: best.axis, rms: best.rms, alternatives };
}

/** 高斯消元解线性最小二乘（正规方程，小规模数据足够） */
export function lstq(A: number[][], y: number[], lambda = 0): number[] {
  const n = A[0]?.length ?? 0;
  if (!n || A.length === 0) return [];
  const AtA = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const Aty = new Array<number>(n).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let a = 0; a < n; a++) {
      Aty[a] += A[i][a] * y[i];
      for (let b = 0; b < n; b++) AtA[a][b] += A[i][a] * A[i][b];
    }
  }
  for (let a = 0; a < n; a++) AtA[a][a] += lambda;
  return solveLinear(AtA, Aty);
}

function solveLinear(M: number[][], v: number[]): number[] {
  const n = v.length;
  const A = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return Array.from({ length: n }, (_, i) =>
    Math.abs(A[i][i]) < 1e-12 ? 0 : A[i][n] / A[i][i]
  );
}
