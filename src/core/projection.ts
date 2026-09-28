/**
 * 倾转投影物理模型（用于生成带真值的离线案例，确定性、无随机种子依赖外的随机源）。
 *
 * 几何：样品绕图像平面内的“倾转轴”旋转。轴由 pivot（轴上一点）+ directionDeg
 * 给出，刻意不经过图像中心（轴线偏心场景）。
 * 对物理颗粒 P=(X,Y,Z)（样品坐标，Z 为电子束方向），在台倾角 θ：
 *   沿轴方向投影不变；垂直轴方向按 cosθ 压缩，Z*sinθ 产生横向位移：
 *     u(θ) = u0
 *     v(θ) = v0*cosθ + Z*sinθ
 * 其中 (u0,v0) 是颗粒在零倾转时沿轴/垂轴的坐标。该模型即电镜 fiducial 对齐的
 * 经典正弦轨迹模型；fiducial 轨迹因此天然随倾角变化，不能用“少帧换低残差”。
 */

export interface AxisGeometry {
  pivot: { x: number; y: number };
  directionDeg: number;
}

export interface Bead3D {
  physicalBeadId: string;
  /** 零倾转样品平面像素坐标（轴局部坐标 u0 沿轴、v0 垂轴） */
  u0: number;
  v0: number;
  /** 相对样品中平面的高度（像素），决定正弦项幅度 */
  z: number;
}

export function axisBasis(axis: AxisGeometry): {
  along: { x: number; y: number };
  perp: { x: number; y: number };
} {
  const a = (axis.directionDeg * Math.PI) / 180;
  return {
    along: { x: Math.cos(a), y: Math.sin(a) },
    perp: { x: -Math.sin(a), y: Math.cos(a) },
  };
}

export function projectBead(
  bead: Bead3D,
  angleDeg: number,
  axis: AxisGeometry,
): { x: number; y: number } {
  const { along, perp } = axisBasis(axis);
  const t = (angleDeg * Math.PI) / 180;
  const u = bead.u0;
  const v = bead.v0 * Math.cos(t) + bead.z * Math.sin(t);
  return {
    x: axis.pivot.x + along.x * u + perp.x * v,
    y: axis.pivot.y + along.y * u + perp.y * v,
  };
}

/** 反算：给定帧上观测 (x,y)，还原该帧的 (u,v) 轴局部坐标 */
export function toAxisLocal(
  x: number,
  y: number,
  axis: AxisGeometry,
): { u: number; v: number } {
  const { along, perp } = axisBasis(axis);
  const dx = x - axis.pivot.x;
  const dy = y - axis.pivot.y;
  return { u: dx * along.x + dy * along.y, v: dx * perp.x + dy * perp.y };
}

/**
 * 多可分度：当 beads 关于轴线（或某候选轴）镜像对称且 z 成对反号时，
 * 轴方向角 +180°（等价于 v 反号）会给出同样的轨迹族 —— 经典非唯一解。
 * 返回歧义轴方向候选（度）。
 */
export function ambiguousAxisDirections(
  beads: Bead3D[],
  tolerance = 1e-6,
): number[] {
  // 物理上 (v,z) 与 (-v,-z) 关于原点对称 => direction+180 不可区分
  const paired = beads.every((b) =>
    beads.some((o) => Math.abs(o.v0 + b.v0) < tolerance && Math.abs(o.z + b.z) < tolerance),
  );
  if (paired && beads.length >= 4) return [0, 180];
  return [0];
}
