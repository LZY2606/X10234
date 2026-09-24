// 小型确定性线性代数（无第三方依赖），服务于刚体/局部形变拟合与诊断。

export interface Vec2 { x: number; y: number; }

export function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

// 一般线性最小二乘 A x = b（正规方程，尺度小且条件可控）。
export function lstsq(A: number[][], b: number[]): { x: number[]; resid: number } {
  const n = A.length;
  const p = A[0]?.length ?? 0;
  if (n < p) throw new Error('underdetermined');
  const AtA = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Atb = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Atb[a] += A[i][a] * b[i];
      for (let c = 0; c < p; c++) AtA[a][c] += A[i][a] * A[i][c];
    }
  }
  const x = solveSymmetric(AtA, Atb);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let a = 0; a < p; a++) pred += A[i][a] * x[a];
    ss += (pred - b[i]) ** 2;
  }
  return { x, resid: Math.sqrt(ss / Math.max(1, n)) };
}

// 高斯消元（带选主元）求解对称正定/一般小矩阵。
function solveSymmetric(M: number[][], v: number[]): number[] {
  const n = M.length;
  const A = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) throw new Error('singular');
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[n] / row[i][i]);
}

export function rmse(vals: number[]): number {
  if (!vals.length) return 0;
  return Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length);
}

export function mean(vals: number[]): number {
  return vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
}

// 沿给定轴角把图像坐标转为 (u=沿轴, n=法向) 分量。
export function toAxisBasis(p: Vec2, axisAngleDeg: number, center: Vec2) {
  const th = deg2rad(axisAngleDeg);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  const u = Math.cos(th) * dx + Math.sin(th) * dy;
  const n = -Math.sin(th) * dx + Math.cos(th) * dy;
  return { u, n };
}

export function angleDiff(a: number, b: number): number {
  let d = (a - b) % 180;
  if (d < -90) d += 180;
  if (d > 90) d -= 180;
  return d;
}
