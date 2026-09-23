// 小型稠密线性最小二乘：带等式约束行（大权重），高斯消元解正规方程。
export function solveLeastSquares(
  rowsA: number[][],
  rowsB: number[],
  constraints: { row: number[]; value: number }[] = [],
  constraintWeight = 1e7
): number[] {
  const n = rowsA[0]?.length ?? 0;
  if (n === 0) return [];
  const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const atb = new Array<number>(n).fill(0);

  const addRow = (a: number[], b: number, w: number) => {
    for (let i = 0; i < n; i++) {
      if (a[i] === 0) continue;
      atb[i] += w * a[i] * b;
      for (let j = 0; j < n; j++) ata[i][j] += w * a[i] * a[j];
    }
  };

  for (let k = 0; k < rowsA.length; k++) addRow(rowsA[k] as number[], rowsB[k] as number, 1);
  for (const c of constraints) addRow(c.row, c.value, constraintWeight);

  // 高斯-约旦消元
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(ata[r][col] as number) > Math.abs(ata[pivot][col] as number)) pivot = r;
    }
    if (Math.abs(ata[pivot][col] as number) < 1e-12) continue;
    [ata[col], ata[pivot]] = [ata[pivot], ata[col]];
    [atb[col], atb[pivot]] = [atb[pivot] as number, atb[col] as number];
    const piv = ata[col][col] as number;
    for (let j = 0; j < n; j++) ata[col][j] = (ata[col][j] as number) / piv;
    atb[col] = (atb[col] as number) / piv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = ata[r][col] as number;
      if (factor === 0) continue;
      for (let j = 0; j < n; j++) ata[r][j] = (ata[r][j] as number) - factor * (ata[col][j] as number);
      atb[r] = (atb[r] as number) - factor * (atb[col] as number);
    }
  }
  return atb;
}

export function rmse(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
}
