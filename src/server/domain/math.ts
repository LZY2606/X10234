// 最小二乘与投影几何（fiducial-based tilt alignment 的线性子问题）

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 解线性最小二乘 A x = b（正规方程 + 高斯-约当消元，矩阵很小） */
export function leastSquares(A: number[][], b: number[]): { x: number[]; residual: number[] } {
  const m = A.length;
  const n = A[0]?.length ?? 0;
  const AtA: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb: number[] = new Array(n).fill(0);
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < n; k++) {
      Atb[k] += A[i][k] * b[i];
      for (let j = 0; j < n; j++) AtA[k][j] += A[i][k] * A[i][j];
    }
  }
  const M = AtA.map((row, k) => [...row, Atb[k]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-10) M[piv][col] = 1e-10;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[r][col] * 0 + f * M[col][j];
    }
  }
  const x = M.map((row) => row[n]);
  const residual: number[] = new Array(m);
  for (let i = 0; i < m; i++) {
    let pred = 0;
    for (let k = 0; k < n; k++) pred += A[i][k] * x[k];
    residual[i] = b[i] - pred;
  }
  return { x, residual };
}

export function rms(v: number[]): number {
  if (v.length === 0) return 0;
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
}

export const DEG = Math.PI / 180;

/** 3D fiducial 点投影像素坐标（倾角 theta，轴线面内角 phi，轴线位置 x0,y0，帧平移 tx,ty） */
export function project(
  X: number, Y: number, Z: number,
  thetaDeg: number, phiDeg: number,
  x0: number, y0: number, tx: number, ty: number,
): { u: number; v: number } {
  const t = thetaDeg * DEG;
  const p = phiDeg * DEG;
  const a = X * Math.cos(t) + Z * Math.sin(t);
  const u = Math.cos(p) * a - Math.sin(p) * Y + x0 + tx;
  const v = Math.sin(p) * a + Math.cos(p) * Y + y0 + ty;
  return { u, v };
}

export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c * 2654435761) >>> 7), 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
