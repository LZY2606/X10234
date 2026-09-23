/**
 * 配准引擎几何：线性最小二乘工具、sinogram 拟合、倾转轴偏心估计。
 * 全部数值基于像素与 degree，角度在边界处显式换算。
 */

const DEG = Math.PI / 180;

/** 最小二乘 y = X β，带列；返回 β 与残差 */
export function lstsq(X: number[][], y: number[]): { beta: number[]; residual: number; fitted: number[] } {
  const n = X.length;
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const beta = solveSymmetric(XtX, Xty);
  const fitted = X.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (y[i] - fitted[i]) ** 2;
  return { beta, residual: Math.sqrt(ss / Math.max(1, n)), fitted };
}

function solveSymmetric(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export interface Obs {
  trackId: string;
  frameIndex: number;
  tiltDeg: number;
  x: number;
  y: number;
  obsRef: { stableId: string; version: number };
}

export interface GlobalFit {
  /** 每帧平移（相对参考帧），像素 */
  translations: Map<number, { dx: number; dy: number }>;
  /** 每条轨迹在去掉帧平移后的 sinogram 系数 */
  trackCoef: Map<string, { ax: number; bx: number; cy: number; dy: number }>;
  /** 每个观测的拟合残差（像素） */
  residuals: Map<string, number>;
  key: (trackId: string, frameIndex: number) => string;
  /** 轴线方向（单位向量 V：垂直于轴线，含符号） */
  axisNormal: { vx: number; vy: number };
  /** 轴线与图像中心的垂直偏心（像素，沿 V） */
  axisOffset: number;
  /** 每个观测残差列表（带帧/轨迹） */
  perObs: { trackId: string; frameIndex: number; residual: number }[];
}

/**
 * 全局刚体模型（线性）：
 *   x = ax_k cosθ + bx_k sinθ + tx_i
 *   y = cy_k cosθ + dy_k sinθ + ty_i
 * 参考帧平移锚定为 0。
 */
export function fitGlobal(obs: Obs[], frameIndices: number[], refFrame: number, axisSign: 1 | -1, width: number, height: number): GlobalFit {
  const tracks = [...new Set(obs.map((o) => o.trackId))].sort();
  const frames = [...new Set(obs.map((o) => o.frameIndex))].sort((a, b) => a - b);
  const tIdx = new Map(frames.map((f, i) => [f, i]));
  const kIdx = new Map(tracks.map((t, i) => [t, i]));
  const nPar = tracks.length * 4 + frames.length * 2;
  const rowsX: number[][] = [];
  const rowsY: number[][] = [];
  const yx: number[] = [];
  const yy: number[] = [];
  for (const o of obs) {
    const rx = new Array<number>(nPar).fill(0);
    const ry = new Array<number>(nPar).fill(0);
    const c = Math.cos(o.tiltDeg * DEG);
    const s = Math.sin(o.tiltDeg * DEG);
    const kb = kIdx.get(o.trackId)! * 4;
    rx[kb] = c;
    rx[kb + 1] = s;
    ry[kb + 2] = c;
    ry[kb + 3] = s;
    if (o.frameIndex !== refFrame) {
      const fb = tracks.length * 4 + tIdx.get(o.frameIndex)! * 2;
      rx[fb] = 1;
      ry[fb + 1] = 1;
    }
    rowsX.push(rx);
    rowsY.push(ry);
    yx.push(o.x);
    yy.push(o.y);
  }
  const fx = lstsq(rowsX, yx);
  const fy = lstsq(rowsY, yy);
  const translations = new Map<number, { dx: number; dy: number }>();
  for (const f of frames) {
    if (f === refFrame) translations.set(f, { dx: 0, dy: 0 });
    else {
      const fb = tracks.length * 4 + tIdx.get(f)! * 2;
      translations.set(f, { dx: fx.beta[fb], dy: fy.beta[fb + 1] });
    }
  }
  const trackCoef = new Map<string, { ax: number; bx: number; cy: number; dy: number }>();
  for (const k of tracks) {
    const kb = kIdx.get(k)! * 4;
    trackCoef.set(k, { ax: fx.beta[kb], bx: fx.beta[kb + 1], cy: fy.beta[kb + 2], dy: fy.beta[kb + 3] });
  }
  const key = (trackId: string, frameIndex: number) => `${trackId}@${frameIndex}`;
  const residualMap = new Map<string, number>();
  const perObs: GlobalFit['perObs'] = [];
  obs.forEach((o, i) => {
    const r = Math.hypot(o.x - fx.fitted[i], o.y - fy.fitted[i]);
    residualMap.set(key(o.trackId, o.frameIndex), r);
    perObs.push({ trackId: o.trackId, frameIndex: o.frameIndex, residual: r });
  });

  // 轴线方向 V：各轨迹 sin 系数向量 (bx,dy) 振幅方向，按权重求方向（符号由 axisSign 控制）
  let vx = 0;
  let vy = 0;
  for (const k of tracks) {
    const c = trackCoef.get(k)!;
    const m = Math.hypot(c.bx, c.dy) || 1;
    vx += c.bx / m;
    vy += c.dy / m;
  }
  const norm = Math.hypot(vx, vy) || 1;
  vx = (axisSign * vx) / norm;
  vy = (axisSign * vy) / norm;

  // 轴线偏心：用 ±θ 对的中点（沿 V 坐标）对轨迹平均，抵消深度项
  const byFrame = new Map<number, Obs[]>();
  for (const o of obs) {
    if (!byFrame.has(o.frameIndex)) byFrame.set(o.frameIndex, []);
    byFrame.get(o.frameIndex)!.push(o);
  }
  const tiltOf = new Map(obs.map((o) => [o.frameIndex, o.tiltDeg]));
  const midV: number[] = [];
  const seen = new Set<number>();
  for (const f of frames) {
    const theta = tiltOf.get(f)!;
    const partner = frames.find((q) => q !== f && !seen.has(q) && Math.abs(tiltOf.get(q)! + theta) < 1e-6);
    if (partner === undefined || seen.has(f)) continue;
    seen.add(f);
    seen.add(partner);
    const a = byFrame.get(f)!;
    const b = byFrame.get(partner)!;
    for (const oa of a) {
      const ob = b.find((z) => z.trackId === oa.trackId);
      if (!ob) continue;
      const ta = translations.get(f)!;
      const tb = translations.get(partner)!;
      const mx = (oa.x - ta.dx + ob.x - tb.dx) / 2;
      const my = (oa.y - ta.dy + ob.y - tb.dy) / 2;
      midV.push((mx - width / 2) * vx + (my - height / 2) * vy);
    }
  }
  const axisOffset = midV.length ? midV.reduce((s, v) => s + v, 0) / midV.length : 0;

  return { translations, trackCoef, residuals: residualMap, key, axisNormal: { vx, vy }, axisOffset, perObs };
}

export function angleDeg(dx: number, dy: number): number {
  return (Math.atan2(dy, dx) / Math.PI) * 180;
}
