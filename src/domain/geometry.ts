// 倾转几何（像素坐标基准：原点左上，x 向右，y 向下）。
// 轴 a=(cosφ,sinφ)，垂直方向 b=(-sinφ,cosφ)；标记点 i 的
// 轴坐标 u_i、零倾垂直坐标 v_i、等效厚度 z_i：
//   xax_ij = u_i + dx_j
//   yb_ij  = v_i cosθ_j - z_i sinθ_j + dy_j
//
// 已知事实：轴直线在画幅中的平移是规范自由度（可被 u_i/v_i 吸收），
// 因此轴线位置必须来自显式参考（这里用零倾帧观测质心这一数据约定），
// 绝不能静默取画幅中心；真正由残差识别的是轴方向 φ。
// 参考帧（最接近 0°）锚定 dx=dy=0。

export interface GeomPoint {
  x: number;
  y: number;
}

export interface ObservationInput {
  trackIndex: number;
  frameIndex: number;
  x: number;
  y: number;
}

export interface SolveOptions {
  axisDirDeg: number;
  axisOrigin: GeomPoint;
  anglesDeg: number[];
  trackCount: number;
  observations: ObservationInput[];
  warp?: boolean;
  warpLambda?: number;
}

export interface SolveResult {
  rms: number;
  minPivot: number;
  perTrack: Array<{ u: number; v: number; z: number }>;
  perFrame: Array<{ dx: number; dy: number; warpA: number }>;
  residuals: Array<{ trackIndex: number; frameIndex: number; rx: number; ry: number }>;
  degreesOfFreedom: number;
}

const DEG = Math.PI / 180;

/** A^T A x = A^T b（带岭正则 reg），带部分主元消元；minPivot 给出秩诊断 */
export function solveLinearNormal(
  rows: Array<{ a: Float64Array; b: number }>,
  n: number,
  reg = 0
): { x: Float64Array; minPivot: number } {
  const ata = new Float64Array(n * n);
  const atb = new Float64Array(n);
  for (const row of rows) {
    for (let p = 0; p < n; p++) {
      const ap = row.a[p];
      if (ap === 0) continue;
      atb[p] += ap * row.b;
      for (let q = 0; q < n; q++) ata[p * n + q] += ap * row.a[q];
    }
  }
  for (let i = 0; i < n; i++) ata[i * n + i] += reg;

  const m = ata.slice();
  const rhs = atb.slice();
  const pivotCols = Int32Array.from({ length: n }, (_, i) => i);
  let scale = 1;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(m[i * n + j]));
  let minPivot = Infinity;

  for (let col = 0; col < n; col++) {
    let piv = col;
    let pivVal = Math.abs(m[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r * n + col]);
      if (v > pivVal) {
        pivVal = v;
        piv = r;
      }
    }
    if (piv !== col) {
      for (let k = 0; k < n; k++) {
        const t = m[col * n + k];
        m[col * n + k] = m[piv * n + k];
        m[piv * n + k] = t;
      }
      const tr = rhs[col];
      rhs[col] = rhs[piv];
      rhs[piv] = tr;
      const tc = pivotCols[col];
      pivotCols[col] = pivotCols[piv];
      pivotCols[piv] = tc;
    }
    minPivot = Math.min(minPivot, pivVal / scale);
    if (pivVal < 1e-12 * scale) continue;
    for (let r = col + 1; r < n; r++) {
      const f = m[r * n + col] / m[col * n + col];
      if (f === 0) continue;
      m[r * n + col] = 0;
      for (let k = col + 1; k < n; k++) m[r * n + k] -= f * m[col * n + k];
      rhs[r] -= f * rhs[col];
    }
  }

  const xSorted = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = rhs[row];
    for (let k = row + 1; k < n; k++) sum -= m[row * n + k] * xSorted[k];
    const diag = m[row * n + row];
    xSorted[row] = Math.abs(diag) < 1e-12 * scale ? 0 : sum / diag;
  }
  const x = new Float64Array(n);
  for (let row = 0; row < n; row++) x[pivotCols[row]] = xSorted[row];
  return { x, minPivot };
}

export function solveModel(opts: SolveOptions): SolveResult {
  const { axisDirDeg, axisOrigin, anglesDeg, trackCount: t, observations } = opts;
  const f = anglesDeg.length;
  const phi = axisDirDeg * DEG;
  const ax = Math.cos(phi);
  const ay = Math.sin(phi);
  const bx = -Math.sin(phi);
  const by = Math.cos(phi);

  let refFrame = 0;
  let bestAbs = Infinity;
  anglesDeg.forEach((th, j) => {
    if (Math.abs(th) < bestAbs) {
      bestAbs = Math.abs(th);
      refFrame = j;
    }
  });

  const warp = opts.warp ?? false;
  const n = 3 * t + 2 * f + (warp ? f : 0);
  const idxU = (i: number) => 3 * i;
  const idxV = (i: number) => 3 * i + 1;
  const idxZ = (i: number) => 3 * i + 2;
  const idxDx = (j: number) => 3 * t + 2 * j;
  const idxDy = (j: number) => 3 * t + 2 * j + 1;
  const idxA = (j: number) => 3 * t + 2 * f + j;

  const rows: Array<{ a: Float64Array; b: number }> = [];
  for (const obs of observations) {
    const i = obs.trackIndex;
    const j = obs.frameIndex;
    const th = anglesDeg[j] * DEG;
    const dx0 = obs.x - axisOrigin.x;
    const dy0 = obs.y - axisOrigin.y;
    const xax = dx0 * ax + dy0 * ay;
    const yb = dx0 * bx + dy0 * by;

    const rowX = new Float64Array(n);
    rowX[idxU(i)] = 1;
    if (j !== refFrame) rowX[idxDx(j)] = 1;
    rows.push({ a: rowX, b: xax });

    const rowY = new Float64Array(n);
    rowY[idxV(i)] = Math.cos(th);
    rowY[idxZ(i)] = -Math.sin(th);
    if (j !== refFrame) rowY[idxDy(j)] = 1;
    if (warp && j !== refFrame) rowY[idxA(j)] = xax * xax;
    rows.push({ a: rowY, b: yb });
  }

  const { x, minPivot } = solveLinearNormal(rows, n, warp ? (opts.warpLambda ?? 1e-3) : 0);

  let sse = 0;
  const residuals: SolveResult["residuals"] = [];
  for (const obs of observations) {
    const i = obs.trackIndex;
    const j = obs.frameIndex;
    const th = anglesDeg[j] * DEG;
    const dx0 = obs.x - axisOrigin.x;
    const dy0 = obs.y - axisOrigin.y;
    const xax = dx0 * ax + dy0 * ay;
    const yb = dx0 * bx + dy0 * by;
    const predX = x[idxU(i)] + (j === refFrame ? 0 : x[idxDx(j)]);
    let predY =
      x[idxV(i)] * Math.cos(th) -
      x[idxZ(i)] * Math.sin(th) +
      (j === refFrame ? 0 : x[idxDy(j)]);
    if (warp && j !== refFrame) predY += x[idxA(j)] * xax * xax;
    const rx = xax - predX;
    const ry = yb - predY;
    sse += rx * rx + ry * ry;
    residuals.push({ trackIndex: i, frameIndex: j, rx, ry });
  }

  const perTrack = Array.from({ length: t }, (_, i) => ({
    u: x[idxU(i)],
    v: x[idxV(i)],
    z: x[idxZ(i)]
  }));
  const perFrame = Array.from({ length: f }, (_, j) => ({
    dx: j === refFrame ? 0 : x[idxDx(j)],
    dy: j === refFrame ? 0 : x[idxDy(j)],
    warpA: warp && j !== refFrame ? x[idxA(j)] : 0
  }));

  return {
    rms: Math.sqrt(sse / Math.max(1, observations.length)),
    minPivot,
    perTrack,
    perFrame,
    residuals,
    degreesOfFreedom: 3 * t + 2 * f - 2 + (warp ? f : 0)
  };
}

export interface AxisGridResult {
  origin: GeomPoint;
  dirDeg: number;
  solve: SolveResult;
}

/**
 * 轴方向搜索；origin 必须由调用方给出显式参考（零倾帧质心等），
 * 本函数不把画幅中心当默认。近优解按方向（模 180°）聚类，用于多解诊断。
 */
export function searchAxis(
  anglesDeg: number[],
  trackCount: number,
  observations: ObservationInput[],
  origin: GeomPoint,
  options: {
    fixedDirDeg?: number;
    dirRange?: [number, number];
    dirStepDeg?: number;
    fineStepDeg?: number;
    warp?: boolean;
    warpLambda?: number;
    nonUniqueRatio?: number;
  } = {}
): { best: AxisGridResult; nearBest: AxisGridResult[] } {
  const ratio = options.nonUniqueRatio ?? 1.05;
  const mk = (dirDeg: number): AxisGridResult => ({
    origin: { ...origin },
    dirDeg,
    solve: solveModel({
      axisDirDeg: dirDeg,
      axisOrigin: origin,
      anglesDeg,
      trackCount,
      observations,
      warp: options.warp,
      warpLambda: options.warpLambda
    })
  });

  let grid: number[];
  if (options.fixedDirDeg !== undefined) {
    grid = [options.fixedDirDeg];
  } else {
    const [lo, hi] = options.dirRange ?? [-30, 46];
    const step = options.dirStepDeg ?? 1;
    grid = [];
    for (let d = lo; d <= hi + 1e-9; d += step) grid.push(+d.toFixed(4));
  }

  let results = grid.map(mk);
  results.sort((p, q) => p.solve.rms - q.solve.rms);
  let best = results[0];

  if (options.fixedDirDeg === undefined) {
    const fine: number[] = [];
    const fstep = options.fineStepDeg ?? 0.25;
    for (let d = best.dirDeg - 1; d <= best.dirDeg + 1 + 1e-9; d += fstep) fine.push(+d.toFixed(4));
    const fineResults = fine.map(mk).filter((r) => r.dirDeg !== best.dirDeg);
    fineResults.sort((p, q) => p.solve.rms - q.solve.rms);
    if (fineResults[0] && fineResults[0].solve.rms < best.solve.rms) best = fineResults[0];
    results = results.concat(fineResults);
  }

  const threshold = best.solve.rms * ratio + 1e-6;
  const nearBest: AxisGridResult[] = [];
  for (const cand of results) {
    if (cand.solve.rms > threshold) continue;
    const dirMod = ((cand.dirDeg % 180) + 180) % 180;
    if (
      !nearBest.some((g) => {
        const gMod = ((g.dirDeg % 180) + 180) % 180;
        return Math.abs(((dirMod - gMod + 90) % 180) - 90) < 2;
      })
    ) {
      nearBest.push(cand);
    }
  }
  return { best, nearBest };
}
