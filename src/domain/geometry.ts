// 倾转面内几何。
// 每帧模型：p' = R(theta_i) (p - c_i) + c_i + d_i*a
// 其中所有旋转中心 c_i 必须落在同一条全局轴线 L 上：
// c_i = c0 + s_i * n  （n 为轴法向，d_i*a 为沿轴漂移）。
// 这样轴线位置（偏心）是全局拟合量，不默认固定在图像中心。

export interface Vec2 { x: number; y: number; }

export interface Observation {
  trackUid: string;
  markUid: string;
  frameUid: string;
  /** 参考帧（近 0°）上的位置 */
  refX: number;
  refY: number;
  observedX: number;
  observedY: number;
  tiltDeg: number;
}

export interface FitResult {
  /** 轴角 a（度） */
  axisAngleDeg: number;
  /** 轴线上基准点（偏心中心） */
  c0: Vec2;
  /** 每帧：沿轴漂移 d_i 与法向位置 s_i */
  perFrame: Map<string, { driftAlong: number; offsetNormal: number; rmsePx: number; n: number }>;
  trainRmse: number;
  heldoutRmse: number;
  center: Vec2;
}

export function axisVectors(angleDeg: number): { a: Vec2; n: Vec2 } {
  const t = (angleDeg * Math.PI) / 180;
  return { a: { x: Math.cos(t), y: Math.sin(t) }, n: { x: -Math.sin(t), y: Math.cos(t) } };
}

export function predict(o: Observation, p: Params): Vec2 {
  const { a, n } = axisVectors(p.angle);
  const theta = (o.tiltDeg * Math.PI) / 180;
  const f = p.frames[o.frameUid] ?? { d: 0, s: 0 };
  // c_i = c0 + s_i*n
  const ciX = p.c0x + f.s * n.x;
  const ciY = p.c0y + f.s * n.y;
  const dx = o.refX - ciX;
  const dy = o.refY - ciY;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const rx = c * dx - s * dy;
  const ry = s * dx + c * dy;
  return { x: rx + ciX + f.d * a.x, y: ry + ciY + f.d * a.y };
}

interface FrameParams { d: number; s: number; }
interface Params {
  angle: number;
  c0x: number;
  c0y: number;
  frames: Record<string, FrameParams>;
}

export function rmse(obs: Observation[], p: Params): number {
  if (obs.length === 0) return Infinity;
  let acc = 0;
  for (const o of obs) {
    const q = predict(o, p);
    acc += (q.x - o.observedX) ** 2 + (q.y - o.observedY) ** 2;
  }
  return Math.sqrt(acc / obs.length);
}

function initParams(obs: Observation[], pinnedAngle: number | null, pinnedCenter: Vec2 | null): Params {
  const frameUids = [...new Set(obs.map((o) => o.frameUid))];
  const frames: Record<string, FrameParams> = {};
  for (const f of frameUids) frames[f] = { d: 0, s: 0 };
  const meanX = obs.reduce((m, o) => m + o.observedX, 0) / obs.length;
  const meanY = obs.reduce((m, o) => m + o.observedY, 0) / obs.length;
  return {
    angle: pinnedAngle ?? 85,
    c0x: pinnedCenter?.x ?? meanX,
    c0y: pinnedCenter?.y ?? meanY,
    frames
  };
}

function vectorize(p: Params, frameOrder: string[]): number[] {
  const v = [p.angle, p.c0x, p.c0y];
  for (const f of frameOrder) v.push(p.frames[f].d, p.frames[f].s);
  return v;
}

function devectorize(v: number[], frameOrder: string[]): Params {
  const frames: Record<string, FrameParams> = {};
  frameOrder.forEach((f, i) => { frames[f] = { d: v[3 + 2 * i], s: v[4 + 2 * i] }; });
  return { angle: v[0], c0x: v[1], c0y: v[2], frames };
}

function residuals(obs: Observation[], p: Params): number[] {
  const r: number[] = [];
  for (const o of obs) {
    const q = predict(o, p);
    r.push(q.x - o.observedX, q.y - o.observedY);
  }
  return r;
}

/**
 * Levenberg-Marquardt（带阻尼的高斯-牛顿）非线性最小二乘。
 * 3 + 2F 个参数，残差为每个观测的 x/y。
 */
export function fitRigid(
  obs: Observation[],
  opts: { pinnedAngle?: number; pinnedCenter?: Vec2; maxIter?: number } = {}
): { params: Params; trainRmse: number } {
  if (obs.length === 0) throw new Error('no observations');
  const frameOrder = [...new Set(obs.map((o) => o.frameUid))];
  let p = initParams(obs, opts.pinnedAngle ?? null, opts.pinnedCenter ?? null);
  let v = vectorize(p, frameOrder);
  let lambda = 1e-3;
  const eps = 1e-6;
  const maxIter = opts.maxIter ?? 40;

  const isFixed = (idx: number) =>
    (idx === 0 && opts.pinnedAngle !== undefined) ||
    ((idx === 1 || idx === 2) && opts.pinnedCenter !== undefined);

  for (let iter = 0; iter < maxIter; iter++) {
    p = devectorize(v, frameOrder);
    const r0 = residuals(obs, p);
    const m = obs.length * 2;
    const n = v.length;
    // 数值雅可比
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      if (isFixed(j)) continue;
      const step = Math.max(1e-5, Math.abs(v[j]) * 1e-6);
      const v2 = v.slice();
      v2[j] += step;
      const r1 = residuals(obs, devectorize(v2, frameOrder));
      for (let i = 0; i < m; i++) J[i][j] = (r1[i] - r0[i]) / step;
    }
    // J^T J, J^T r
    const JTJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const JTr = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        JTr[j] += J[i][j] * r0[i];
        for (let k = 0; k < n; k++) JTJ[j][k] += J[i][j] * J[i][k];
      }
    }
    let accepted = false;
    for (let inner = 0; inner < 12; inner++) {
      const A = JTJ.map((row, j) => row.map((val, k) => (j === k ? val * (1 + lambda) : val)));
      for (let j = 0; j < n; j++) if (isFixed(j)) { A[j][j] = 1; }
      const b = JTr.map((x, j) => (isFixed(j) ? 0 : -x));
      const delta = solve(A, b, isFixed);
      if (!delta) { lambda *= 4; continue; }
      const vTry = v.map((x, j) => (isFixed(j) ? x : x + delta[j]));
      const pTry = devectorize(vTry, frameOrder);
      const eNow = r0.reduce((s, x) => s + x * x, 0);
      const eTry = residuals(obs, pTry).reduce((s, x) => s + x * x, 0);
      if (eTry < eNow) {
        v = vTry;
        lambda = Math.max(lambda / 3, 1e-9);
        accepted = true;
        break;
      }
      lambda *= 4;
    }
    if (!accepted) break;
  }
  const params = devectorize(v, frameOrder);
  return { params, trainRmse: Math.sqrt(residuals(obs, params).reduce((s, x) => s + x * x, 0) / obs.length) };
}

// 高斯消元解 Ax=b（固定参数行被替换为单位约束）
function solve(A: number[][], b: number[], isFixed: (idx: number) => boolean): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) {
      if (!isFixed(col)) return null;
      continue;
    }
    [M[piv], M[col]] = [M[col], M[piv]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (Math.abs(M[i][i]) < 1e-12) {
      if (isFixed(i)) x[i] = 0;
      else return null;
    } else x[i] = M[i][n] / M[i][i];
  }
  return x;
}

export function summarizeFit(
  params: Params,
  obs: Observation[],
  heldout: Observation[],
  imageCenter: Vec2
): FitResult {
  const { a, n } = axisVectors(params.angle);
  const perFrame = new Map<string, { driftAlong: number; offsetNormal: number; rmsePx: number; n: number }>();
  const byFrame = new Map<string, Observation[]>();
  for (const o of obs) {
    if (!byFrame.has(o.frameUid)) byFrame.set(o.frameUid, []);
    byFrame.get(o.frameUid)!.push(o);
  }
  for (const [f, rows] of byFrame) {
    const fp = params.frames[f] ?? { d: 0, s: 0 };
    const r = rmse(rows, params);
    perFrame.set(f, { driftAlong: fp.d, offsetNormal: fp.s, rmsePx: r, n: rows.length });
  }
  return {
    axisAngleDeg: params.angle,
    c0: { x: params.c0x, y: params.c0y },
    perFrame,
    trainRmse: rmse(obs, params),
    heldoutRmse: heldout.length ? rmse(heldout, params) : NaN,
    center: imageCenter
  };
}

export { axisVectors as axisGeometry };
