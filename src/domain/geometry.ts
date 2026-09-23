/**
 * 倾转几何：fiducial 在绕倾转轴旋转下的投影模型。
 *
 * 图像坐标系：x 沿列方向、y 沿行方向，原点在图像左上。
 * 轴方向单位向量 a=(cosα,sinα)，平面内法向 p=(-sinα,cosα)。
 * 标记点相对“轴上点 C”的零倾角坐标 (along0, perp0) 与离面高度 z：
 *   along(θ) = along0 + z·sinθ
 *   perp(θ)  = perp0·cosθ
 * 投影像素位置：
 *   q = C + a·along(θ) + p·perp(θ)
 *
 * 关键点：C=(centerX,centerY) 必须被显式拟合，绝不默认取图像中心。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface AxisGeometry {
  angleDeg: number;
  center: Vec2;
}

export interface BeadModel {
  along0: number;
  perp0: number;
  z: number;
}

export function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

export function axisVectors(angleDeg: number): { ax: number; ay: number; px: number; py: number } {
  const a = deg2rad(angleDeg);
  return {
    ax: Math.cos(a),
    ay: Math.sin(a),
    px: -Math.sin(a),
    py: Math.cos(a),
  };
}

export function projectBead(axis: AxisGeometry, bead: BeadModel, thetaDeg: number): Vec2 {
  const t = deg2rad(thetaDeg);
  const along = bead.along0 + bead.z * Math.sin(t);
  const perp = bead.perp0 * Math.cos(t);
  const { ax, ay, px, py } = axisVectors(axis.angleDeg);
  return {
    x: axis.center.x + ax * along + px * perp,
    y: axis.center.y + ay * along + py * perp,
  };
}

// ---------------------------------------------------------------------------
// 最小二乘（正规方程 + 高斯消元）
// ---------------------------------------------------------------------------

export interface LsObservation {
  /** 物理标记索引（参数块 3 个/标记） */
  beadIndex: number;
  beadCount: number;
  /** 帧索引（frameShift 参数，帧 0 固定为基准） */
  frameIndex: number;
  frameCount: number;
  thetaDeg: number;
  x: number;
  y: number;
  /** 是否使用帧平移项（刚体漂移） */
  withFrameShift: boolean;
}

export interface LsResult {
  center: Vec2;
  beads: BeadModel[];
  frameShifts: Vec2[];
  rms: number;
  /** 每条观测的残差向量，顺序与输入一致 */
  residuals: Vec2[];
  /** 自由度估计：核心轴参数3 + 每标记3 + 每非基准帧2（刚体） */
  degreesOfFreedom: number;
}

/**
 * 对固定轴角 α 做线性 LS：
 * 参数 = [Cx, Cy, along0_0, perp0_0, z_0, ..., (sx_j, sy_j) j>=1]
 */
export function fitFixedAngle(obsIn: LsObservation[], angleDeg: number): LsResult {
  const obs = obsIn;
  if (obs.length === 0) throw new Error("empty observation set for fit");
  const beadCount = obs[0]!.beadCount;
  const frameCount = obs[0]!.frameCount;
  const withFrameShift = obs[0]!.withFrameShift;
  const shiftParams = withFrameShift ? 2 * (frameCount - 1) : 0;
  const ncol = 2 + 3 * beadCount + shiftParams;
  const ata: number[][] = Array.from({ length: ncol }, () => new Array<number>(ncol).fill(0));
  const atb: number[] = new Array<number>(ncol).fill(0);

  const { ax, ay, px, py } = axisVectors(angleDeg);

  const design = (o: LsObservation): { rx: number[]; ry: number[] } => {
    const t = deg2rad(o.thetaDeg);
    const s = Math.sin(t);
    const c = Math.cos(t);
    const rx = new Array<number>(ncol).fill(0);
    const ry = new Array<number>(ncol).fill(0);
    rx[0] = 1;
    ry[1] = 1;
    // q = C + a*(along0 + z sinθ) + p*(perp0 cosθ)
    const k = 2 + 3 * o.beadIndex;
    rx[k] = ax;
    rx[k + 1] = px * c;
    rx[k + 2] = ax * s;
    ry[k] = ay;
    ry[k + 1] = py * c;
    ry[k + 2] = ay * s;
    if (withFrameShift && o.frameIndex > 0) {
      const sj = 2 + 3 * beadCount + 2 * (o.frameIndex - 1);
      rx[sj] = 1;
      ry[sj + 1] = 1;
    }
    return { rx, ry };
  };

  const accumulate = (row: number[], b: number) => {
    for (let i = 0; i < ncol; i++) {
      if (row[i] === 0) continue;
      atb[i] += row[i] * b;
      for (let j = 0; j < ncol; j++) ata[i][j] += row[i] * row[j];
    }
  };

  for (const o of obs) {
    const { rx, ry } = design(o);
    accumulate(rx, o.x);
    accumulate(ry, o.y);
  }

  // Tikhonov 极小正则，仅抑制零空间（例如缺失视角），不偏向中心
  for (let i = 0; i < ncol; i++) ata[i][i] += 1e-9;

  const params = solveSymmetric(ata, atb);
  const center = { x: params[0]!, y: params[1]! };
  const beads: BeadModel[] = [];
  for (let k = 0; k < beadCount; k++) {
    beads.push({
      along0: params[2 + 3 * k]!,
      perp0: params[2 + 3 * k + 1]!,
      z: params[2 + 3 * k + 2]!,
    });
  }
  const frameShifts: Vec2[] = [{ x: 0, y: 0 }];
  if (withFrameShift) {
    for (let j = 1; j < frameCount; j++) {
      const sj = 2 + 3 * beadCount + 2 * (j - 1);
      frameShifts.push({ x: params[sj] ?? 0, y: params[sj + 1] ?? 0 });
    }
  }

  const axis: AxisGeometry = { angleDeg, center };
  const residuals: Vec2[] = [];
  let sse = 0;
  for (const o of obs) {
    const q = projectBead(axis, beads[o.beadIndex]!, o.thetaDeg);
    const sh = frameShifts[o.frameIndex] ?? { x: 0, y: 0 };
    const dx = o.x - (q.x + sh.x);
    const dy = o.y - (q.y + sh.y);
    residuals.push({ x: dx, y: dy });
    sse += dx * dx + dy * dy;
  }

  return {
    center,
    beads,
    frameShifts,
    rms: Math.sqrt(sse / obs.length),
    residuals,
    degreesOfFreedom: 3 + 3 * beadCount + shiftParams,
  };
}

/** 轴角一维搜索（粗扫 + 两级细化）。中心在内部与 α 联合估计。 */
export function fitAxis(obs: LsObservation[]): { angleDeg: number; fit: LsResult } {
  const score = (a: number) => fitFixedAngle(obs, a).rms;
  let bestA = -90;
  let bestR = Infinity;
  for (let a = -90; a < 90; a += 2) {
    const r = score(a);
    if (r < bestR) {
      bestR = r;
      bestA = a;
    }
  }
  const refine = (lo: number, hi: number, step: number) => {
    for (let a = lo; a <= hi + 1e-9; a += step) {
      const r = score(a);
      if (r < bestR) {
        bestR = r;
        bestA = a;
      }
    }
  };
  refine(bestA - 2, bestA + 2, 0.2);
  refine(bestA - 0.2, bestA + 0.2, 0.02);
  return { angleDeg: bestA, fit: fitFixedAngle(obs, bestA) };
}

function solveSymmetric(aIn: number[][], bIn: number[]): number[] {
  const n = aIn.length;
  const a = aIn.map((row) => row.slice());
  const b = bIn.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]!) > Math.abs(a[piv][col]!)) piv = r;
    if (Math.abs(a[piv][col]!) < 1e-12) continue;
    [a[col], a[piv]] = [a[piv], a[col]];
    [b[col], b[piv]] = [b[piv]!, b[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col]! / a[col][col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r][c] = a[r][c]! - f * a[col][c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) x[i] = Math.abs(a[i][i]!) > 1e-12 ? b[i]! / a[i][i]! : 0;
  return x;
}
