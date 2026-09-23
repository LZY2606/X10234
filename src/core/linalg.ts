// Tiny linear-algebra helpers for 2-D fiducial fitting (no external dep).

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rigid2D {
  cos: number;
  sin: number;
  tx: number;
  ty: number;
}

export function applyRigid(t: Rigid2D, p: Vec2): Vec2 {
  return { x: t.cos * p.x - t.sin * p.y + t.tx, y: t.sin * p.x + t.cos * p.y + t.ty };
}

// Weighted Procrustes/Kabsch fit of src -> dst (uniform scale fixed at 1).
export function fitRigid(src: Vec2[], dst: Vec2[]): { transform: Rigid2D; rms: number } {
  const n = src.length;
  if (n === 0) throw new Error('fit/empty-point-set');
  const ms = centroid(src);
  const md = centroid(dst);
  let sxx = 0;
  let syx = 0;
  for (let i = 0; i < n; i++) {
    const ax = src[i].x - ms.x;
    const ay = src[i].y - ms.y;
    const bx = dst[i].x - md.x;
    const by = dst[i].y - md.y;
    sxx += ax * bx + ay * by;
    syx += ax * by - ay * bx;
  }
  const denom = Math.hypot(sxx, syx);
  const cos = denom === 0 ? 1 : sxx / denom;
  const sin = denom === 0 ? 0 : syx / denom;
  const tx = md.x - (cos * ms.x - sin * ms.y);
  const ty = md.y - (sin * ms.x + cos * ms.y);
  const transform = { cos, sin, tx, ty };
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const q = applyRigid(transform, src[i]);
    sum += (q.x - dst[i].x) ** 2 + (q.y - dst[i].y) ** 2;
  }
  return { transform, rms: Math.sqrt(sum / n) };
}

export function centroid(points: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

// Ordinary least squares for y = X * beta.  X is n x p row-major.
export function lstsq(X: number[][], y: number[]): { beta: number[]; residual: number } {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const XtX = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const beta = solveSymmetric(XtX, Xty);
  let residual = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let a = 0; a < p; a++) pred += X[i][a] * beta[a];
    residual += (y[i] - pred) ** 2;
  }
  return { beta, residual: Math.sqrt(residual / Math.max(1, n)) };
}

function solveSymmetric(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row) => row.slice());
  const y = b.slice();
  // Cholesky with ridge fallback for near-singular systems.
  let ridge = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    let ok = attempt % 2 === 0;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = M[i][j] + (i === j ? ridge : 0);
        for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
        if (i === j) {
          if (sum <= 1e-12) {
            ok = false;
            break;
          }
          L[i][j] = Math.sqrt(sum);
        } else {
          L[i][j] = sum / L[j][j];
        }
      }
    }
    if (ok) {
      const z = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        let sum = y[i];
        for (let k = 0; k < i; k++) sum -= L[i][k] * z[k];
        z[i] = sum / L[i][i];
      }
      const x = new Array<number>(n).fill(0);
      for (let i = n - 1; i >= 0; i--) {
        let sum = z[i];
        for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
        x[i] = sum / L[i][i];
      }
      return x;
    }
    ridge = ridge === 0 ? 1e-9 : ridge * 10;
  }
  throw new Error('lstsq/singular-system');
}

// Condition number proxy: smallest vs largest pivot of XtX (for multi-solution
// detection when high-tilt frames are missing).
export function lstsqConditionProxy(X: number[][]): number {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const XtX = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const evs = symmetric2x2Eigenvalues(XtX);
  return Math.sqrt(evs.max / Math.max(evs.min, 1e-30));
}

function symmetric2x2Eigenvalues(A: number[][]): { min: number; max: number } {
  if (A.length !== 2) return { min: 1, max: 1 };
  const a = A[0][0];
  const b = A[1][1];
  const c = A[0][1];
  const tr = a + b;
  const disc = Math.sqrt(((a - b) / 2) ** 2 + c ** 2);
  return { min: tr / 2 - disc, max: tr / 2 + disc };
}
