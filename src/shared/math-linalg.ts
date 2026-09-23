/** 小型线性代数：高斯消元解线性方程组、正规方程最小二乘。 */

export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error(`SINGULAR_MATRIX at column ${col}`);
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** 最小二乘 min ||Ax - b||，返回参数与残差平方和。 */
export function leastSquares(rows: number[][], rhs: number[]): { params: number[]; ssr: number } {
  const p = rows[0].length;
  const AtA = Array.from({ length: p }, () => new Array(p).fill(0));
  const Atb = new Array(p).fill(0);
  for (let i = 0; i < rows.length; i++) {
    for (let a = 0; a < p; a++) {
      Atb[a] += rows[i][a] * rhs[i];
      for (let c = 0; c < p; c++) AtA[a][c] += rows[i][a] * rows[i][c];
    }
  }
  const params = solveLinear(AtA, Atb);
  let ssr = 0;
  for (let i = 0; i < rows.length; i++) {
    let pred = 0;
    for (let a = 0; a < p; a++) pred += rows[i][a] * params[a];
    ssr += (rhs[i] - pred) ** 2;
  }
  return { params, ssr };
}

export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
