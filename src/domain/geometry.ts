/** 小型线性代数（高斯消元 / 正规方程），零依赖 */

export function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  if (n === 0 || A[0]!.length !== n) throw new Error('矩阵非方阵，无法求解');
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) {
      throw new Error(`奇异矩阵（列 ${col}），模型在当前有效点集上欠定`);
    }
    [M[pivot], M[col]] = [M[col]!, M[pivot]!];
    const pv = M[col]![col]!;
    for (let c = col; c <= n; c++) M[col]![c] = M[col]![c]! / pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r]![col]!;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - factor * M[col]![c]!;
    }
  }
  return M.map((row) => row[n]!);
}

/** 最小二乘 min ||Ax-b||，返回解与残差；rank 不足时抛错 */
export function leastSquares(A: number[][], b: number[]): { x: number[]; residuals: number[] } {
  const n = A[0]?.length ?? 0;
  if (n === 0 || A.length < n) throw new Error('观测数少于参数数，欠定');
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb = new Array(n).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let p = 0; p < n; p++) {
      Atb[p]! += A[i]![p]! * b[i]!;
      for (let q = 0; q < n; q++) AtA[p]![q]! += A[i]![p]! * A[i]![q]!;
    }
  }
  // 轻度阻尼保证数值稳定（不改变非奇异问题的解到可观测精度）
  for (let p = 0; p < n; p++) AtA[p]![p]! += 1e-10;
  const x = solveLinear(AtA, Atb);
  const residuals = A.map((row, i) => b[i]! - row.reduce((s, a, p) => s + a * x[p]!, 0));
  return { x, residuals };
}

export function rms(values: number[]): number {
  if (values.length === 0) return NaN;
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}
