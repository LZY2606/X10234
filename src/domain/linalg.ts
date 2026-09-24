/** 小型稠密线性求解器（正规方程 + 部分主元消元 + 秩检测），无需外部数学库。 */

export interface LUSolveResult {
  solution: number[];
  rank: number;
  singularValuesApprox: number[];
}

export function solveLinear(A: number[][], b: number[], pivotTolerance = 1e-10): LUSolveResult {
  const n = A[0]?.length ?? 0;
  const m = A.length;
  if (m === 0 || n === 0 || b.length !== m) {
    return { solution: Array.from({ length: n }, () => NaN), rank: 0, singularValuesApprox: [] };
  }
  // 正规方程 AtA x = Atb
  const AtA = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const Atb = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) {
    const row = A[i];
    for (let p = 0; p < n; p++) {
      Atb[p] += row[p] * b[i];
      for (let q = 0; q < n; q++) AtA[p][q] += row[p] * row[q];
    }
  }
  const scale = Math.sqrt(Math.max(...Atb.map((v) => v * v), 1));
  const tol = pivotTolerance * Math.max(1, scale);
  const M = AtA.map((row, i) => [...row, Atb[i]]);
  const pivotCols: number[] = [];
  const rank = 0;
  for (let col = 0; col < n; col++) {
    let best = -1;
    let bestVal = tol;
    for (let row = pivotCols.length; row < n; row++) {
      const v = Math.abs(M[row][col]);
      if (v > bestVal) {
        bestVal = v;
        best = row;
      }
    }
    if (best === -1) continue;
    const r = pivotCols.length;
    if (best !== r) {
      const tmp = M[r];
      M[r] = M[best];
      M[best] = tmp;
    }
    pivotCols.push(col);
    for (let row = 0; row < n; row++) {
      if (row === r) continue;
      const factor = M[row][col] / M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[row][c] -= factor * M[r][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < pivotCols.length; i++) x[pivotCols[i]] = M[i][n] / M[i][pivotCols[i]];
  const diagApprox = Array.from({ length: n }, (_, i) => Math.sqrt(Math.max(0, AtA[i][i])));
  return { solution: x, rank: pivotCols.length, singularValuesApprox: diagApprox };
}

export function sse(predicted: number[], actual: number[]): number {
  let sum = 0;
  for (let i = 0; i < predicted.length; i++) {
    const d = predicted[i] - actual[i];
    sum += d * d;
  }
  return sum;
}
