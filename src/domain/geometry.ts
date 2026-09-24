import type { AffineTransform, PixelPoint } from '../shared/types.js';

export const identity = (): AffineTransform => ({ a: 1, b: 0, tx: 0, c: 0, d: 1, ty: 0 });

export function applyAffine(t: AffineTransform, p: PixelPoint): PixelPoint {
  return {
    x: t.a * p.x + t.b * p.y + t.tx,
    y: t.c * p.x + t.d * p.y + t.ty,
    basis: 'image_pixel'
  };
}

interface Pt { x: number; y: number }

// 高斯消元解线性方程组 A x = b
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

// 最小二乘仿射（6 自由度）：将 src 映射到 dst
export function fitAffine(pairs: { src: Pt; dst: Pt }[]): AffineTransform {
  // 法方程 X^T X beta = X^T y，分别对 x、y
  const dims = 6;
  const XtX = Array.from({ length: dims }, () => new Array(dims).fill(0));
  const Xtx = new Array(dims).fill(0);
  const Xty = new Array(dims).fill(0);
  for (const { src, dst } of pairs) {
    const v = [src.x, src.y, 1, 0, 0, 0];
    const w = [0, 0, 0, src.x, src.y, 1];
    for (let i = 0; i < dims; i++) {
      Xtx[i] += v[i] * dst.x;
      Xty[i] += w[i] * dst.y;
      for (let j = 0; j < dims; j++) {
        XtX[i][j] += v[i] * v[j] + w[i] * w[j];
      }
    }
  }
  const bx = solve(XtX, Xtx);
  const by = solve(XtX, Xty);
  return { a: bx[0], b: bx[1], tx: bx[2], c: by[3], d: by[4], ty: by[5] };
}

// 最小二乘相似（刚体 + 均匀尺度，4 自由度）
export function fitSimilarity(pairs: { src: Pt; dst: Pt }[]): AffineTransform {
  // q = s R p + t，先用质心中心化求 s,R
  let cx = 0, cy = 0, dx = 0, dy = 0;
  for (const { src, dst } of pairs) { cx += src.x; cy += src.y; dx += dst.x; dy += dst.y; }
  const n = pairs.length || 1;
  cx /= n; cy /= n; dx /= n; dy /= n;
  let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0, varp = 0;
  for (const { src, dst } of pairs) {
    const px = src.x - cx, py = src.y - cy, qx = dst.x - dx, qy = dst.y - dy;
    Sxx += px * qx; Sxy += px * qy; Syx += py * qx; Syy += py * qy;
    varp += px * px + py * py;
  }
  const a = (Sxx + Syy) / (varp || 1e-12);
  const bcoef = (Sxy - Syx) / (varp || 1e-12);
  // 相似矩阵：[a -b; b a]
  return { a, b: -bcoef, tx: dx - (a * cx - bcoef * cy), c: bcoef, d: a, ty: dy - (bcoef * cx + a * cy) };
}

export function dist(p: Pt, q: Pt): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

export function rms(values: number[]): number {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}
