// 纯函数几何层：2D 相似变换（刚体+缩放）拟合、倾转轴、残差与候选规则判定。

export interface Pt { x: number; y: number }

export interface Similarity {
  rotationDeg: number;
  txPx: number;
  tyPx: number;
  scale: number;
}

export function applySimilarity(s: Similarity, p: Pt): Pt {
  const a = (s.rotationDeg * Math.PI) / 180;
  const c = Math.cos(a) * s.scale;
  const sn = Math.sin(a) * s.scale;
  return { x: c * p.x - sn * p.y + s.txPx, y: sn * p.x + c * p.y + s.tyPx };
}

/**
 * 各向同性 2D 相似变换最小二乘（Umeyama / Kabsch 二维形式）。
 * q ≈ s R(theta) p + t。至少需要 2 对不共线点。
 */
export function fitSimilarity(pairs: { p: Pt; q: Pt }[]): Similarity | null {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const mp = { x: pairs.reduce((a, z) => a + z.p.x, 0) / n, y: pairs.reduce((a, z) => a + z.p.y, 0) / n };
  const mq = { x: pairs.reduce((a, z) => a + z.q.x, 0) / n, y: pairs.reduce((a, z) => a + z.q.y, 0) / n };
  let hxx = 0, hxy = 0, hyx = 0, hyy = 0, varP = 0;
  for (const { p, q } of pairs) {
    const px = p.x - mp.x, py = p.y - mp.y;
    const qx = q.x - mq.x, qy = q.y - mq.y;
    hxx += px * qx; hxy += px * qy; hyx += py * qx; hyy += py * qy;
    varP += px * px + py * py;
  }
  if (varP === 0) return null;
  // 二维闭式旋转：协方差行向量构造
  const det = hxx * hyy - hxy * hyx;
  const denom = Math.sqrt(Math.max(1e-12, hxx * hxx + hyx * hyx) * Math.max(1e-12, hxy * hxy + hyy * hyy));
  const cos = (hxx + hyy) / denom;
  const sin = (hyx - hxy) / denom;
  void det;
  const rotationDeg = (Math.atan2(sin, cos) * 180) / Math.PI;
  const scale = (hxx * cos + hyx * sin + hxy * -sin + hyy * cos) / varP;
  const txPx = mq.x - scale * (cos * mp.x - sin * mp.y);
  const tyPx = mq.y - scale * (sin * mp.x + cos * mp.y);
  return { rotationDeg, txPx, tyPx, scale };
}

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function rms(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((a, v) => a + v * v, 0) / values.length);
}

export interface AxisLine {
  /** 轴线与图像平面交点（px，参考视图坐标），显式记录，绝不默认等于图像中心 */
  intersectionPx: Pt;
  angleDeg: number;
  assumedCenter: Pt;
  eccentricPx: number;
}

export function axisFromEvidence(
  evidence: { intersectionPx: Pt; angleDeg: number },
  imageSize: { widthPx: number; heightPx: number },
): AxisLine {
  const assumedCenter = { x: imageSize.widthPx / 2, y: imageSize.heightPx / 2 };
  return {
    intersectionPx: { ...evidence.intersectionPx },
    angleDeg: evidence.angleDeg,
    assumedCenter,
    eccentricPx: distance(evidence.intersectionPx, assumedCenter),
  };
}

/** 没有外部证据时唯一安全的退化为“未标定”，而不是悄悄放到中心。 */
export function uncalibratedAxis(imageSize: { widthPx: number; heightPx: number }): AxisLine {
  const c = { x: imageSize.widthPx / 2, y: imageSize.heightPx / 2 };
  return { intersectionPx: c, angleDeg: 90, assumedCenter: c, eccentricPx: NaN };
}
