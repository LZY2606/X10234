/**
 * 倾转投影模型（派生层，全部使用规范化单位）：
 *   样品坐标 (X,Y,Z) nm，X 沿倾转轴；轴方位角 alpha（度）；
 *   u = (X cos a + Y sin a) cos t + Z sin t
 *   v = -X sin a + Y cos a
 *   像素坐标 = (u,v)/pixelSize * scale + 图像中心 + 轴偏移 + 每帧平移
 * 倾转轴绝不默认固定在图像中心：pivotX/pivotY 是显式拟合或人工设定的参数。
 */
export interface SpecimenPoint {
  x: number; // nm
  y: number;
  z: number;
}

export interface AxisParams {
  azimuthDeg: number;
  pivotX: number; // px，相对图像中心
  pivotY: number; // px
  scale: number;  // 各向同性缩放
}

export interface FrameParams {
  shiftX: number; // px
  shiftY: number; // px
}

export interface ProjectionContext {
  widthPx: number;
  heightPx: number;
  pixelSizeNm: number;
}

const DEG = Math.PI / 180;

export function projectPoint(
  p: SpecimenPoint,
  tiltDeg: number,
  axis: AxisParams,
  frame: FrameParams,
  ctx: ProjectionContext,
): { x: number; y: number } {
  const a = axis.azimuthDeg * DEG;
  const t = tiltDeg * DEG;
  const along = p.x * Math.cos(a) + p.y * Math.sin(a);
  const across = -p.x * Math.sin(a) + p.y * Math.cos(a);
  const u = along * Math.cos(t) + p.z * Math.sin(t);
  const v = across;
  return {
    x: (u / ctx.pixelSizeNm) * axis.scale + ctx.widthPx / 2 + axis.pivotX + frame.shiftX,
    y: (v / ctx.pixelSizeNm) * axis.scale + ctx.heightPx / 2 + axis.pivotY + frame.shiftY,
  };
}

/** 由观测反投影样品点：给定轴与帧参数，对一条轨迹的所有观测做最小二乘。 */
export function backProject(
  observations: Array<{ tiltDeg: number; xPx: number; yPx: number }>,
  axis: AxisParams,
  frames: FrameParams[],
  ctx: ProjectionContext,
): SpecimenPoint {
  const a = axis.azimuthDeg * DEG;
  let acrossSum = 0;
  const rows: Array<{ t: number; u: number }> = [];
  observations.forEach((o, i) => {
    const f = frames[i]!;
    const u = ((o.xPx - ctx.widthPx / 2 - axis.pivotX - f.shiftX) * ctx.pixelSizeNm) / axis.scale;
    const v = ((o.yPx - ctx.heightPx / 2 - axis.pivotY - f.shiftY) * ctx.pixelSizeNm) / axis.scale;
    acrossSum += v;
    rows.push({ t: o.tiltDeg * DEG, u });
  });
  const across = acrossSum / observations.length;
  // across = -X sin a + Y cos a；沿轴分量由 u 方程解出
  // u_i = along * cos t_i + Z sin t_i，两个未知量 along、Z 的最小二乘
  let scc = 0, sss = 0, scs = 0, su_c = 0, su_s = 0;
  for (const r of rows) {
    const c = Math.cos(r.t), s = Math.sin(r.t);
    scc += c * c; sss += s * s; scs += c * s;
    su_c += r.u * c; su_s += r.u * s;
  }
  const det = scc * sss - scs * scs;
  let along = 0, z = 0;
  if (Math.abs(det) > 1e-9) {
    along = (su_c * sss - su_s * scs) / det;
    z = (su_s * scc - su_c * scs) / det;
  }
  // along = X cos a + Y sin a；与 across 联立解 X,Y
  const x = along * Math.cos(a) - across * Math.sin(a);
  const y = along * Math.sin(a) + across * Math.cos(a);
  return { x, y, z };
}
