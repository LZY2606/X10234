/** 小型线性代数：高斯消元解正规方程、2x2 SVD（Jacobi）、加权最小二乘。 */

export function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('singular-matrix');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export interface Rigid2D {
  tx: number;
  ty: number;
  rotDeg: number;
}

/**
 * 由参考点对 (ref -> obs) 拟合刚体（小角近似 sin≈a, cos≈1；倾转序列帧间角很小）。
 * 解 a,tx,ty： obs ≈ R(a) ref + t。
 */
export function fitRigid(
  pairs: { rx: number; ry: number; x: number; y: number; w?: number }[],
): Rigid2D & { rms: number; condition: number } {
  let sxx = 0,
    sxy = 0,
    sx = 0,
    sy = 0,
    sw = 0;
  let ru1 = 0,
    ru2 = 0,
    bu1 = 0,
    bu2 = 0;
  // 正规方程 3x3，未知 [a, tx, ty]
  // u1 = x - ry ; u2 = y + rx
  let A11 = 0,
    A12 = 0,
    A13 = 0,
    A22 = 0,
    A23 = 0,
    A33 = 0,
    B1 = 0,
    B2 = 0,
    B3 = 0;
  for (const p0 of pairs) {
    const w = p0.w ?? 1;
    const { rx, ry, x, y } = p0;
    const c1 = -ry; // da 对 u=x-ry 的系数
    const c2 = rx; // da 对 v=y+rx 的系数
    A11 += w * (c1 * c1 + c2 * c2);
    A12 += w * c1;
    A13 += w * c2;
    A22 += w;
    A33 += w;
    B1 += w * (c1 * (x - rx) + c2 * (y - ry));
    B2 += w * (x - rx);
    B3 += w * (y - ry);
    sw += w;
    sxx += w * rx * rx;
    sxy += w * rx * ry;
    sy += w * ry * ry;
    sx += w * rx;
  }
  void sxx; void sxy; void sx; void sy; void sw; void ru1; void ru2; void bu1; void bu2;
  const A = [
    [A11, A12, A13],
    [A12, A22, 0],
    [A13, 0, A33],
  ];
  let sol: number[];
  try {
    sol = solveLinear(A, [B1, B2, B3]);
  } catch {
    return { tx: 0, ty: 0, rotDeg: 0, rms: NaN, condition: Infinity };
  }
  const [a, tx, ty] = sol;
  let ss = 0;
  let n = 0;
  for (const p0 of pairs) {
    const w = p0.w ?? 1;
    const px = p0.rx - a * p0.ry + tx;
    const py = p0.ry + a * p0.rx + ty;
    ss += w * ((px - p0.x) ** 2 + (py - p0.y) ** 2);
    n += w;
  }
  const cond = conditionNumber3(A);
  return { tx, ty, rotDeg: (a * 180) / Math.PI, rms: Math.sqrt(ss / Math.max(1, n)), condition: cond };
}

function conditionNumber3(A: number[][]): number {
  // 用 Gershgorin 近似上下界的比值，足够判定病态（点共线/点过少）。
  const norms = A.map((row) => row.reduce((s, v) => s + Math.abs(v), 0));
  const diags = A.map((row, i) => Math.abs(row[i]));
  const max = Math.max(...norms);
  const minDiag = Math.min(...diags);
  return max / Math.max(1e-9, minDiag);
}

/** 2x2 对称阵特征值（Jacobi）。 */
export function eig2(A: number[][]): [number, number] {
  const a = A[0][0],
    b = A[0][1],
    d = A[1][1];
  const tr = a + d;
  const disc = Math.sqrt(((a - d) / 2) ** 2 + b * b);
  return [tr / 2 + disc, tr / 2 - disc];
}
