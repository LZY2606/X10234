/** 最小二乘求解 A x = b（正规方程 + 高斯消元），规模很小无需外部库。 */

export function transpose(a: number[][]): number[][] {
  const rows = a.length;
  const cols = a[0]?.length ?? 0;
  const out: number[][] = Array.from({ length: cols }, () =>
    new Array(rows).fill(0)
  );
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) out[j][i] = a[i][j];
  }
  return out;
}

export function matMul(a: number[][], b: number[][]): number[][] {
  const rows = a.length;
  const inner = b.length;
  const cols = b[0]?.length ?? 0;
  const out: number[][] = Array.from({ length: rows }, () =>
    new Array(cols).fill(0)
  );
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < inner; k++) {
      const aik = a[i][k];
      for (let j = 0; j < cols; j++) out[i][j] += aik * b[k][j];
    }
  }
  return out;
}

export function matVec(a: number[][], x: number[]): number[] {
  return a.map((row) => row.reduce((sum, value, i) => sum + value * x[i], 0));
}

export function solveSymmetric(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  // Cholesky 更稳定；若矩阵非正定则回退高斯消元（出现于病态多解）。
  const lower = cholesky(a);
  if (lower) {
    const y = forwardSubstitution(lower, b);
    return backSubstitution(
      transpose(lower),
      y
    );
  }
  return gaussianElimination(m);
}

function cholesky(a: number[][]): number[][] | null {
  const n = a.length;
  const l: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j];
      for (let k = 0; k < j; k++) sum -= l[i][k] * l[j][k];
      if (i === j) {
        if (sum <= 1e-12) return null;
        l[i][j] = Math.sqrt(sum);
      } else {
        l[i][j] = sum / l[j][j];
      }
    }
  }
  return l;
}

function forwardSubstitution(l: number[][], b: number[]): number[] {
  const n = b.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let j = 0; j < i; j++) sum -= l[i][j] * y[j];
    y[i] = sum / l[i][i];
  }
  return y;
}

function backSubstitution(u: number[][], b: number[]): number[] {
  const n = b.length;
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let j = i + 1; j < n; j++) sum -= u[i][j] * x[j];
    x[i] = sum / u[i][i];
  }
  return x;
}

function gaussianElimination(m: number[][]): number[] {
  const n = m.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const pivotValue = m[col][col];
    if (Math.abs(pivotValue) < 1e-12) {
      throw new Error('SINGULAR_MATRIX');
    }
    for (let row = col + 1; row < n; row++) {
      const factor = m[row][col] / pivotValue;
      for (let k = col; k <= n; k++) m[row][k] -= factor * m[col][k];
    }
  }
  return backSubstitution(
    m.map((row) => row.slice(0, n)),
    m.map((row) => row[n])
  );
}

export function leastSquares(a: number[][], b: number[]): number[] {
  const at = transpose(a);
  const ata = matMul(at, a);
  // 加轻微岭项保证数值稳定；不掩盖真实多解（多解由零空间分析处理）。
  for (let i = 0; i < ata.length; i++) ata[i][i] += 1e-9;
  const atb = matVec(at, b);
  return solveSymmetric(ata, atb);
}

export function rms(values: number[]): number {
  if (!values.length) return 0;
  const meanSquare =
    values.reduce((sum, value) => sum + value * value, 0) / values.length;
  return Math.sqrt(meanSquare);
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
