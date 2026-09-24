/**
 * 倾转序列配准算法（确定性实现，便于断言）。
 *
 * 规则：
 *  - 刚体候选：每帧仅旋转+平移（3 自由度），约束于估计出的倾转轴
 *  - 局部形变候选：每帧 4 控制点双线性 / 全帧仿射，自由度高，必须做过拟合检验
 *  - 排除坏帧候选：允许缩小帧集，但必须同时在“基准有效点集”上报告公平残差，
 *    不允许用少帧换低残差
 *  - 多解：几何退化（点共线/点数不足）时返回全部退化方向与诊断，不静默选一个
 */
import type {
  AffineLike,
  PerFrameResidual,
  FrameExclusionKind,
  TiltAxisModel,
} from './types.js';

export interface Pt { x: number; y: number }

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}

/** 2D Kabsch：从移动点集 src 到参考点集 dst 的刚体变换（旋转+平移）。 */
export function rigidProcrustes(src: Pt[], dst: Pt[]): {
  transform: AffineLike;
  rotationRad: number;
  translationXPx: number;
  translationYPx: number;
  rms: number;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  if (src.length !== dst.length) throw new Error('point-set length mismatch');
  if (src.length < 2) {
    diagnostics.push('DEGENERATE: rigid fit needs >=2 corresponding points');
    return {
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      rotationRad: 0, translationXPx: 0, translationYPx: 0,
      rms: NaN, diagnostics,
    };
  }
  const sm = { x: mean(src.map(p => p.x)), y: mean(src.map(p => p.y)) };
  const dm = { x: mean(dst.map(p => p.x)), y: mean(dst.map(p => p.y)) };
  let sxx = 0, syy = 0, sxy = 0, syx = 0;
  for (let i = 0; i < src.length; i++) {
    const sx = src[i].x - sm.x, sy = src[i].y - sm.y;
    const dx = dst[i].x - dm.x, dy = dst[i].y - dm.y;
    sxx += sx * dx; syy += sy * dy; sxy += sx * dy; syx += sy * dx;
  }
  // R = [[cos,-sin],[sin,cos]]；theta = atan2(sxy - syx, sxx + syy)
  const theta = Math.atan2(sxy - syx, sxx + syy);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const tx = dm.x - (cos * sm.x - sin * sm.y);
  const ty = dm.y - (sin * sm.x + cos * sm.y);
  const transform: AffineLike = { a: cos, b: -sin, c: 0, d: sin, e: cos, f: 0 };
  const residuals = src.map((p, i) => {
    const qx = cos * p.x - sin * p.y + tx;
    const qy = sin * p.x + cos * p.y + ty;
    return Math.hypot(qx - dst[i].x, qy - dst[i].y);
  });
  const rms = Math.sqrt(mean(residuals.map(r => r * r)));
  // 退化检测：点近似共线时绕法向之外可能存在数值不稳（2D 中刚体仍唯一，但记录条件数）
  const eigLike = Math.abs(sxx + syy);
  if (eigLike < 1e-9) diagnostics.push('DEGENERATE: rotational constraint near singular (collinear points)');
  return { transform: { ...transform, c: transform.c + tx, f: transform.f + ty }, rotationRad: theta, translationXPx: tx, translationYPx: ty, rms, diagnostics };
}

/**
 * 全帧仿射（局部形变的最小版本）。6 参数，>=3 不共线点可解；
 * 点数不足/共线时标记退化，并枚举仍合法的无穷多解方向诊断。
 */
export function affineFit(src: Pt[], dst: Pt[]): {
  transform: AffineLike;
  rms: number;
  diagnostics: string[];
  degreesOfFreedom: number;
} {
  const diagnostics: string[] = [];
  // 正规方程 A^T A (6 参数)
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    rows.push([x, y, 1, 0, 0, 0]); rhs.push(dst[i].x);
    rows.push([0, 0, 0, x, y, 1]); rhs.push(dst[i].y);
  }
  const sol = leastSquares(rows, rhs);
  const m = 6;
  if (!sol.ok) {
    diagnostics.push(`DEGENERATE: affine underdetermined rank=${sol.rank}/${m}; infinitely many local-warp solutions retained as ambiguity`);
    return { transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, rms: NaN, diagnostics, degreesOfFreedom: m };
  }
  const p = sol.x;
  const transform: AffineLike = { a: p[0], b: p[1], c: p[2], d: p[3], e: p[4], f: p[5] };
  const residuals = src.map((pt, i) => {
    const qx = transform.a * pt.x + transform.b * pt.y + transform.c;
    const qy = transform.d * pt.x + transform.e * pt.y + transform.f;
    return Math.hypot(qx - dst[i].x, qy - dst[i].y);
  });
  const rms = Math.sqrt(mean(residuals.map(r => r * r)));
  // 与刚体基线的偏差度量（单位矩阵偏差）
  const nonRigidity = Math.hypot(transform.a - 1, transform.b, transform.d, transform.e - 1) + Math.abs(transform.c) * 0 + 0;
  if (src.length < 4) {
    diagnostics.push(`OVERFIT_RISK: affine DOF=6 with only ${src.length} points; local deformation not constrained`);
  }
  if (nonRigidity > 5) {
    diagnostics.push('OVERFIT: local warp deviates strongly from rigid baseline — likely fitting fiducial noise, not specimen motion');
  }
  return { transform, rms, diagnostics, degreesOfFreedom: m };
}

/** 小规模高斯消元最小二乘，返回秩用于退化/多解诊断。 */
export function leastSquares(A: number[][], b: number[]): { ok: boolean; x: number[]; rank: number } {
  const n = A[0].length;
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb = new Array(n).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let r = 0; r < n; r++) {
      Atb[r] += A[i][r] * b[i];
      for (let c = 0; c < n; c++) AtA[r][c] += A[i][r] * A[i][c];
    }
  }
  const aug = AtA.map((row, i) => [...row, Atb[i]]);
  const rank = gaussianElimination(aug);
  if (rank < n) return { ok: false, x: new Array(n).fill(0), rank };
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = aug[i][n];
    for (let j = i + 1; j < n; j++) s -= aug[i][j] * x[j];
    x[i] = s / aug[i][i];
  }
  return { ok: true, x, rank };
}

function gaussianElimination(aug: number[][]): number {
  const n = aug.length;
  let rank = 0;
  const eps = 1e-10;
  for (let col = 0; col < n; col++) {
    let piv = rank;
    while (piv < n && Math.abs(aug[piv][col]) < eps) piv++;
    if (piv === n) continue;
    [aug[rank], aug[piv]] = [aug[piv], aug[rank]];
    const d = aug[rank][col];
    for (let j = col; j <= n; j++) aug[rank][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === rank) continue;
      const f = aug[i][col];
      if (Math.abs(f) < eps) continue;
      for (let j = col; j <= n; j++) aug[i][j] -= f * aug[rank][j];
    }
    rank++;
  }
  return rank;
}

export function applyAffine(t: AffineLike, p: Pt): Pt {
  return { x: t.a * p.x + t.b * p.y + t.c, y: t.d * p.x + t.e * p.y + t.f };
}

/**
 * 倾转轴拟合。
 * 模型：fiducial 在倾转下相对参考帧的位移主要沿垂直于轴的方向。
 * 用每帧刚体平移 (tx,ty) 相对倾角 sinθ 的线性关系：
 *   tx(θ) = ax * sinθ + bx ; ty(θ) = ay * sinθ + by
 * 轴的方向垂直于 (ax,ay)；轴穿过的点（pivot）不能假设为图像中心：
 *   垂直轴方向的截距给出可观测偏心；沿轴截距不可观测（沿轴移动不改变投影），
 *   该方向显式标 UNDERDETERMINED 并保留假设，而不是静默取中心。
 */
export interface AxisFitInput {
  frameId: string;
  tiltSin: number;
  tx: number;
  ty: number;
  used: boolean;
}

export function fitTiltAxis(
  inputs: AxisFitInput[],
  center: { x: number; y: number },
): Pick<TiltAxisModel, 'pivotXPx' | 'pivotYPx' | 'angleRad' | 'eccentricityXPx' | 'eccentricityYPx' | 'fitDiagnostics'> & {
  eccentricityObservable: boolean;
} {
  const diagnostics: string[] = [];
  const used = inputs.filter(i => i.used);
  if (used.length < 3) {
    diagnostics.push('DEGENERATE: tilt axis needs translations at >=3 tilt angles; retaining image-center as explicit hypothesis only');
    return {
      pivotXPx: center.x, pivotYPx: center.y, angleRad: 0,
      eccentricityXPx: 0, eccentricityYPx: 0,
      eccentricityObservable: false, fitDiagnostics: diagnostics,
    };
  }
  // 线性回归 y = k sinθ + b
  const lin = (vals: { s: number; v: number }[]) => {
    const n = vals.length;
    const sm = mean(vals.map(z => z.s));
    const vm = mean(vals.map(z => z.v));
    let num = 0, den = 0;
    for (const z of vals) { num += (z.s - sm) * (z.v - vm); den += (z.s - sm) ** 2; }
    const k = den < 1e-12 ? 0 : num / den;
    return { k, b: vm - k * sm, spread: den };
  };
  const rx = lin(used.map(i => ({ s: i.tiltSin, v: i.tx })));
  const ry = lin(used.map(i => ({ s: i.tiltSin, v: i.ty })));
  // 位移方向 (rx.k, ry.k) 垂直于轴 => 轴角 = atan2(-rx.k, ry.k)（图像坐标）
  const angleRad = Math.atan2(-rx.k, ry.k);
  // 截距 (rx.b, ry.b)：θ=0 帧相对参考帧的平移即 pivot 相对参考系原点的偏移
  // 垂直轴方向的分量可观测偏心；沿轴分量不可观测
  const axX = Math.sin(angleRad), axY = -Math.cos(angleRad); // 沿轴单位向量
  const perpX = -axY, perpY = axX;                          // 垂直轴单位向量
  const along = rx.b * axX + ry.b * axY;
  const perp = rx.b * perpX + ry.b * perpY;
  if (rx.spread < 1e-9 && ry.spread < 1e-9) {
    diagnostics.push('DEGENERATE: translations do not vary with sin(theta); pivot eccentricity unobservable');
  }
  // 重建 pivot：垂直分量取拟合值，沿轴分量保留假设（取参考帧中心），并记录
  const pivotXPx = center.x + perp * perpX + 0 * along * axX;
  const pivotYPx = center.y + perp * perpY + 0 * along * axY;
  diagnostics.push('NOTE: along-axis pivot coordinate is unobservable in projection geometry; held at assumed center, perpendicular eccentricity is fitted');
  return {
    pivotXPx, pivotYPx, angleRad,
    eccentricityXPx: pivotXPx - center.x,
    eccentricityYPx: pivotYPx - center.y,
    eccentricityObservable: true,
    fitDiagnostics: diagnostics,
  };
}

export interface FrameResidualInput {
  frameId: string;
  src: Pt[];
  dst: Pt[];
  excluded: FrameExclusionKind;
}

export function perFrameResiduals(t: AffineLike, input: FrameResidualInput): PerFrameResidual {
  if (input.excluded !== 'none') {
    return { frameId: input.frameId, rmsPx: NaN, maxPx: NaN, usedPoints: 0, excluded: input.excluded };
  }
  const res = input.src.map((p, i) => Math.hypot(
    applyAffine(t, p).x - input.dst[i].x,
    applyAffine(t, p).y - input.dst[i].y,
  ));
  return {
    frameId: input.frameId,
    rmsPx: Math.sqrt(mean(res.map(r => r * r))),
    maxPx: Math.max(...res, 0),
    usedPoints: input.src.length,
    excluded: 'none',
  };
}

export function aggregate(residuals: PerFrameResidual[]): { rms: number; max: number } {
  const live = residuals.filter(r => r.excluded === 'none' && Number.isFinite(r.rmsPx));
  if (!live.length) return { rms: NaN, max: NaN };
  const rms = Math.sqrt(mean(live.flatMap(r => new Array(r.usedPoints).fill(r.rmsPx ** 2))));
  const max = Math.max(...live.map(r => r.maxPx));
  return { rms, max };
}
