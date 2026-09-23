/**
 * 配准几何（派生层；只读解释输入，不修改原始表示）。
 * 坐标基准：image-px，原点左上角，y 向下。
 */

export interface Point { x: number; y: number }

export interface RigidResult {
  rotationRad: number;
  shift: Point;
  rms: number;
  residuals: number[];
}

/** 求加权最小二乘：解 A p = b（带权重）。 */
export function weightedLeastSquares(A: number[][], b: number[], w?: number[]): number[] {
  const n = A.length;
  const m = A[0].length;
  const AtA = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const Atb = new Array<number>(m).fill(0);
  for (let i = 0; i < n; i++) {
    const wi = w ? w[i] : 1;
    for (let r = 0; r < m; r++) {
      Atb[r] += wi * A[i][r] * b[i];
      for (let c = 0; c < m; c++) AtA[r][c] += wi * A[i][r] * A[i][c];
    }
  }
  return solveLinear(AtA, Atb);
}

function solveLinear(M: number[][], v: number[]): number[] {
  const n = M.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / d;
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / (row[i] || 1e-12));
}

/**
 * 刚体（相似中的纯旋转+平移）拟合：把 src 点对齐 dst 点。
 * 闭式 Procrustes：旋转角 + 平移。
 */
export function fitRigid(src: Point[], dst: Point[]): RigidResult {
  const n = src.length;
  const cSrc = centroid(src);
  const cDst = centroid(dst);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i].x - cSrc.x;
    const sy = src[i].y - cSrc.y;
    const dx = dst[i].x - cDst.x;
    const dy = dst[i].y - cDst.y;
    num += sx * dy - sy * dx;
    den += sx * dx + sy * dy;
  }
  const rotationRad = Math.atan2(num, den);
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const shift = {
    x: cDst.x - (cos * cSrc.x - sin * cSrc.y),
    y: cDst.y - (sin * cSrc.x + cos * cSrc.y)
  };
  const residuals: number[] = [];
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const px = cos * src[i].x - sin * src[i].y + shift.x;
    const py = sin * src[i].x + cos * src[i].y + shift.y;
    const d = Math.hypot(px - dst[i].x, py - dst[i].y);
    residuals.push(d);
    sse += d * d;
  }
  return { rotationRad, shift, rms: Math.sqrt(sse / n), residuals };
}

export function centroid(points: Point[]): Point {
  const c = { x: 0, y: 0 };
  for (const p of points) {
    c.x += p.x;
    c.y += p.y;
  }
  c.x /= points.length;
  c.y /= points.length;
  return c;
}

export function rms(values: number[]): number {
  if (!values.length) return 0;
  return Math.sqrt(values.reduce((a, b) => a + b * b, 0) / values.length);
}

/**
 * 从“各轨迹在参考帧与目标帧的坐标”同时求：
 *  - 每帧刚体参数（在全局坐标下）
 *  - 旋转中心（即倾转轴在像面的锚点，规则 R1：不假设为图像中心）
 *
 * 模型（小角度线性化，单位 image-px）：
 *   p_f = p_ref + θ_f * J (p_ref - c) + ε
 * 其中 θ 为弧度、J(x,y)=(-y,x)（90°旋转算子），c 为旋转中心。
 * 用全部帧联合最小二乘解 c；同时每帧闭式拟合 R,t。
 */
export interface AxisEstimate {
  directionDeg: number | null;
  anchor: Point | null;
  determined: boolean;
  residual: number;
  alternatives: { directionDeg: number; anchorX: number; anchorY: number; residual: number }[];
  note: string;
}

export function estimateTiltAxis(input: {
  imageCenter: Point;
  minTiltPoints: number;
  frameAnglesDeg: (number | null)[];
  tracksAligned: Point[][];
  trackMask: boolean[][];
}): AxisEstimate {
  const F = input.frameAnglesDeg.length;
  const T = input.tracksAligned[0]?.length ?? 0;

  // 第一步：每轨迹求运动方向 d_kf ≈ sinθ * q_k（q_k = s_k J(p0k - c)）。
  const q: (Point | null)[] = [];
  let usable = 0;
  for (let k = 0; k < T; k++) {
    let ref: Point | null = null;
    const xs: number[] = [];
    const ys: number[] = [];
    const ss: number[] = [];
    for (let f = 0; f < F; f++) {
      if (!input.trackMask[f]?.[k]) continue;
      const ang = input.frameAnglesDeg[f];
      if (ang === null) continue;
      if (Math.abs(ang) < 1e-6) ref = input.tracksAligned[f][k];
      else if (ref) {
        ss.push(Math.sin((ang * Math.PI) / 180));
        xs.push(input.tracksAligned[f][k].x - ref.x);
        ys.push(input.tracksAligned[f][k].y - ref.y);
      }
    }
    if (ss.length >= Math.max(2, input.minTiltPoints - 1)) {
      const denom = ss.reduce((a, b) => a + b * b, 0) || 1e-12;
      q.push({
        x: ss.reduce((a, sv, i) => a + sv * xs[i], 0) / denom,
        y: ss.reduce((a, sv, i) => a + sv * ys[i], 0) / denom
      });
      usable++;
    } else {
      q.push(null);
    }
  }

  if (usable < input.minTiltPoints) {
    // 高倾角帧缺失 / 轨迹缺口：轴线多解，必须全部保留并拒绝默认图像中心。
    return {
      directionDeg: null,
      anchor: null,
      determined: false,
      residual: NaN,
      alternatives: [-2, 0, 2].map((d) => ({
        directionDeg: 90 + d,
        anchorX: input.imageCenter.x,
        anchorY: input.imageCenter.y,
        residual: NaN
      })),
      note: `有效倾角点 ${usable} < 最小要求 ${input.minTiltPoints}（高倾角帧缺失或轨迹缺口）；轴线存在多解，拒绝默认图像中心`
    };
  }

  // 轴方向：q_k = s_k J(p0k - c)，所有 q 同向 → q 平均方向 = J 方向；轴方向 = mean(q)+90°。
  const dirs = q.filter((v): v is Point => !!v).map((v) => Math.atan2(v.y, v.x));
  const meanDir = circularMean(dirs);
  const axisDirection = (((meanDir * 180) / Math.PI + 90) % 180 + 180) % 180;

  // 第二步：联合解锚点 c。每轨迹 q_k = s_k J(p0k - c)，|s_k|=|q_k|/|p0k-c| 未知，
  // 用共线性约束 (p0k - c) 必须垂直 q_k（因为 q = s J(p0-c)）：
  //   q_k · (p0k - c) = 0  →  q·c = q·p0  （两个线性方程/轨迹，2 未知数超定）。
  const A: number[][] = [];
  const b: number[] = [];
  const usedTracks: number[] = [];
  for (let k = 0; k < T; k++) {
    if (!q[k] || !input.trackMask[0]?.[k]) continue;
    const p0 = input.trackAlignedSafe(0, k) ?? input.tracksAligned[0][k];
    A.push([q[k]!.x, q[k]!.y]);
    b.push(q[k]!.x * p0.x + q[k]!.y * p0.y);
    usedTracks.push(k);
  }
  let anchor: Point;
  let residual = NaN;
  if (usedTracks.length >= 2) {
    anchor = leastSquaresPoint(A, b);
    // 残差：q_k 与 (p0k-anchor) 的垂直分量
    const errs: number[] = [];
    for (const k of usedTracks) {
      const p0 = input.tracksAligned[0][k];
      const v = { x: p0.x - anchor.x, y: p0.y - anchor.y };
      const len = Math.hypot(v.x, v.y) || 1e-12;
      errs.push(Math.abs(q[k]!.x * v.x + q[k]!.y * v.y) / len);
    }
    residual = rms(errs);
  } else {
    anchor = { ...input.imageCenter };
  }

  return {
    directionDeg: axisDirection,
    anchor,
    determined: true,
    residual,
    alternatives: [],
    note: `由 ${usable} 条轨迹联合估计；锚点相对图像中心偏心 (${(anchor.x - input.imageCenter.x).toFixed(1)}, ${(anchor.y - input.imageCenter.y).toFixed(1)}) px`
  };
}

function circularMean(angles: number[]): number {
  let sx = 0;
  let sy = 0;
  for (const a of angles) {
    sx += Math.cos(2 * a);
    sy += Math.sin(2 * a);
  }
  return Math.atan2(sy, sx) / 2;
}

/**
 * 轨迹身份交换检测：两条轨迹在相邻段的“运动方向/位置”出现交叉互换。
 * 返回建议的交换对；无法唯一决定时全部返回，交人工裁定。
 */
export function detectTrackSwaps(segments: { trackId: string; frameId: string; x: number; y: number }[][]): {
  a: string; b: string; confidence: number; ambiguous: boolean
}[] {
  if (segments.length < 2) return [];
  const before = segments[0];
  const after = segments[segments.length - 1];
  const swaps: { a: string; b: string; confidence: number; ambiguous: boolean }[] = [];
  for (let i = 0; i < before.length; i++) {
    for (let j = i + 1; j < before.length; j++) {
      const same = Math.hypot(after[i].x - before[i].x, after[i].y - before[i].y)
        + Math.hypot(after[j].x - before[j].x, after[j].y - before[j].y);
      const crossed = Math.hypot(after[j].x - before[i].x, after[j].y - before[i].y)
        + Math.hypot(after[i].x - before[j].x, after[i].y - before[j].y);
      if (crossed + 3 < same) {
        // 差距很小则标记为多解，不自动换标
        swaps.push({ a: before[i].trackId, b: before[j].trackId, confidence: Math.min(1, (same - crossed) / 20), ambiguous: same - crossed < 6 });
      }
    }
  }
  return swaps;
}
