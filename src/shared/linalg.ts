/** 最小二乘求解（高斯消元），足够支撑本案例包中的小规模线性拟合。 */

export interface LstsqResult {
  x: number[];
  rms: number;
  residuals: number[];
}

export function solveLinear(aRows: number[][], b: number[]): number[] {
  const n = aRows[0].length;
  const m: number[][] = aRows.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < m.length; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) continue;
    [m[pivot], m[col]] = [m[col], m[pivot]];
    for (let r = 0; r < m.length; r++) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) x[i] = Math.abs(m[i][i]) < 1e-12 ? 0 : m[i][n] / m[i][i];
  return x;
}

export function lstsq(aRows: number[][], b: number[]): LstsqResult {
  if (aRows.length === 0) return { x: [], rms: 0, residuals: [] };
  const x = solveLinear(clampRows(aRows, b).aRows, clampRows(aRows, b).b);
  const residuals = aRows.map((row, i) => {
    let pred = 0;
    for (let j = 0; j < x.length; j++) pred += row[j] * x[j];
    return b[i] - pred;
  });
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  return { x, rms, residuals };
}

/** 去掉完全零行（缺帧/缺观测时设计矩阵可能为空） */
function clampRows(a: number[][], b: number[]): { aRows: number[][]; b: number[] } {
  const aRows: number[][] = [];
  const bOut: number[] = [];
  a.forEach((row, i) => {
    if (row.some((v) => v !== 0)) {
      aRows.push(row);
      bOut.push(b[i]);
    }
  });
  return { aRows, b: bOut };
}

/** 对点集做过原点直线方向（单位向量）的总体最小二乘拟合。 */
export function fitLineDirection(points: { x: number; y: number }[]): { dx: number; dy: number } {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const cx = sx / points.length;
  const cy = sy / points.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // 主特征向量：对称 2x2
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  let dx: number;
  let dy: number;
  if (Math.abs(sxy) > 1e-12) {
    dx = l1 - syy;
    dy = sxy;
  } else {
    dx = sxx >= syy ? 1 : 0;
    dy = sxx >= syy ? 0 : 1;
  }
  const norm = Math.hypot(dx, dy) || 1;
  return { dx: dx / norm, dy: dy / norm };
}
