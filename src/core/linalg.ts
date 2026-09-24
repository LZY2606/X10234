export interface Point {
  x: number;
  y: number;
}

/** 最小二乘 A p = b：法方程 + Gauss-Jordan（纯 JS，无外部依赖）。 */
export function leastSquares(a: number[][], b: number[]): number[] | null {
  const rows = a.length;
  const cols = a[0]?.length ?? 0;
  if (rows < cols || cols === 0) return null;
  const ata: number[][] = Array.from({ length: cols }, () => new Array(cols).fill(0));
  const atb: number[] = new Array(cols).fill(0);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const aij = a[i]![j]!;
      atb[j] += aij * b[i]!;
      for (let k = 0; k < cols; k++) ata[j]![k] += aij * a[i]![k]!;
    }
  }
  return solveLinear(ata, atb);
}

export function solveLinear(m: number[][], v: number[]): number[] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, v[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const div = a[col]![col]!;
    for (let k = col; k <= n; k++) a[col]![k] = a[col]![k]! / div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      for (let k = col; k <= n; k++) a[r]![k] -= factor * a[col]![k]!;
    }
  }
  return a.map((row) => row[n]!);
}

/**
 * 2D 刚体 Procrustes：给定对应点 src->dst，求旋转与平移（不允许缩放）。
 * 点不足（<2 对）时退化为纯平移。
 */
export function rigidProcrustes(src: Point[], dst: Point[]): { tx: number; ty: number; rotRad: number } | null {
  const n = src.length;
  if (n === 0 || dst.length !== n) return null;
  const ms = centroid(src);
  const md = centroid(dst);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let syx = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i]!.x - ms.x;
    const sy = src[i]!.y - ms.y;
    const dx = dst[i]!.x - md.x;
    const dy = dst[i]!.y - md.y;
    sxx += sx * dx;
    syy += sy * dy;
    sxy += sx * dy;
    syx += sy * dx;
  }
  let rot = 0;
  if (n >= 2) rot = Math.atan2(sxy - syx, sxx + syy);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return {
    rotRad: rot,
    tx: md.x - (cos * ms.x - sin * ms.y),
    ty: md.y - (sin * ms.x + cos * ms.y),
  };
}

export function centroid(points: Point[]): Point {
  const n = points.length || 1;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / n, y: y / n };
}

export function applyRigid(p: Point, t: { tx: number; ty: number; rotRad: number }): Point {
  const cos = Math.cos(t.rotRad);
  const sin = Math.sin(t.rotRad);
  return { x: cos * p.x - sin * p.y + t.tx, y: sin * p.x + cos * p.y + t.ty };
}

/** 仿射拟合（含平移），返回 2x3 参数 [a b tx; c d ty]。 */
export function affineFit(src: Point[], dst: Point[]): number[] | null {
  if (src.length < 3) return null;
  const rowsA: number[][] = [];
  const rowsB: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const s = src[i]!;
    const d = dst[i]!;
    rowsA.push([s.x, s.y, 1, 0, 0, 0]);
    rowsB.push(d.x);
    rowsA.push([0, 0, 0, s.x, s.y, 1]);
    rowsB.push(d.y);
  }
  return leastSquares(rowsA, rowsB);
}
