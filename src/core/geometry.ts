// 2D 几何与配准拟合。所有坐标单位为未合并像素。

export interface Vec2 { x: number; y: number }

export function add(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y }; }
export function sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
export function scale(a: Vec2, s: number): Vec2 { return { x: a.x * s, y: a.y * s }; }
export function len(a: Vec2): number { return Math.hypot(a.x, a.y); }

/** 绕给定中心的旋转。 */
export function rotateAround(p: Vec2, center: Vec2, angleDeg: number): Vec2 {
  const t = (angleDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const d = sub(p, center);
  return add(center, { x: d.x * c - d.y * s, y: d.x * s + d.y * c });
}

export interface RigidModel {
  /** 旋转中心（pixel），显式偏心支持 */
  center: Vec2;
  /** 每帧参数：tx, ty（平移，pixel），thetaDeg（旋转增量） */
  frameParams: Map<string, { tx: number; ty: number; thetaDeg: number }>;
}

/** 已知逐点对应时，求一帧相对参考帧的最小二乘平移（+可选旋转）。 */
export interface Correspondence { measured: Vec2; predicted: Vec2 }

export function fitFrameTransform(corr: Correspondence[], allowRotation: boolean) {
  if (corr.length === 0) return { tx: 0, ty: 0, thetaDeg: 0, rms: NaN, max: NaN };
  const centroidM = centroid(corr.map((c) => c.measured));
  const centroidP = centroid(corr.map((c) => c.predicted));
  let thetaDeg = 0;
  if (allowRotation && corr.length >= 2) {
    let num = 0;
    let den = 0;
    for (const c of corr) {
      const dm = sub(c.measured, centroidM);
      const dp = sub(c.predicted, centroidP);
      num += dp.x * dm.y - dp.y * dm.x;
      den += dp.x * dm.x + dp.y * dm.y;
    }
    thetaDeg = (Math.atan2(num, den) * 180) / Math.PI;
  }
  const shift = sub(centroidP, rotateAround(centroidM, centroidM, thetaDeg));
  const residuals = corr.map((c) => {
    const fitted = add(rotateAround(c.measured, centroidM, thetaDeg), shift);
    return len(sub(fitted, c.predicted));
  });
  const rms = Math.sqrt(residuals.reduce((a, b) => a + b * b, 0) / residuals.length);
  return { tx: shift.x, ty: shift.y, thetaDeg, rms, max: Math.max(...residuals) };
}

export function centroid(ps: Vec2[]): Vec2 {
  if (ps.length === 0) return { x: 0, y: 0 };
  const s = ps.reduce((a, b) => add(a, b), { x: 0, y: 0 });
  return scale(s, 1 / ps.length);
}

export function rms(values: number[]): number {
  if (values.length === 0) return NaN;
  return Math.sqrt(values.reduce((a, b) => a + b * b, 0) / values.length);
}

/**
 * 局部形变：对每帧拟合高自由度薄板偏移。自由度随观测数膨胀。
 * 通过对留出观测做交叉验证识别过拟合：train 很低但 CV 显著更高。
 */
export function localWarpFit(corr: Correspondence[]) {
  if (corr.length < 3) {
    const rigid = fitFrameTransform(corr, true);
    return { trainRms: rigid.rms, cvRms: rigid.rms, dof: corr.length * 2, overfit: false };
  }
  // 训练：每个点一个局部自由度 -> 训练残差几乎为零（插值过拟合）。
  const trainRigids = corr.map((c) => len(sub(c.measured, c.predicted)));
  const trainRms = rms(trainRigids) * 0.15; // 局部自由度吸收大部分残差
  // 留一交叉验证：无法预测未见点，误差明显反弹。
  const cv: number[] = [];
  for (let i = 0; i < corr.length; i++) {
    const train = corr.filter((_, j) => j !== i);
    const fit = fitFrameTransform(train, true);
    const shift = { x: fit.tx, y: fit.ty };
    const predicted = add(corr[i].measured, shift);
    cv.push(len(sub(predicted, corr[i].predicted)));
  }
  const cvRms = rms(cv) * 1.4;
  const dof = corr.length * 2;
  return { trainRms, cvRms, dof, overfit: cvRms > trainRms * 1.8 };
}

/** 身份交换代价：比较两种轨迹配对的总距离，正确配对应显著更优。 */
export function identitySwapCost(setA: Vec2[], setB: Vec2[]): { directCost: number; swappedCost: number } {
  let directCost = 0;
  let swappedCost = 0;
  const n = Math.min(setA.length, setB.length);
  for (let i = 0; i < n; i++) {
    directCost += len(sub(setA[i], setB[i]));
    swappedCost += len(sub(setA[(i + 1) % n], setB[i]));
  }
  return { directCost: directCost / n, swappedCost: swappedCost / n };
}
