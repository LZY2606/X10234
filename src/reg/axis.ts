import type { TiltAxisParams } from '../domain/types.js';
import { fitRigid } from './geometry.js';
import type { NormFrame, NormPoint } from './engine.js';

/**
 * 倾转轴估计：由 marker 随倾角的横向（垂直于轴）运动反推轴线。
 * 绝不允许把轴默认放在 (width/2, height/2)；必须给出 source 与偏心。
 */

export function estimateTiltAxis(
  frames: NormFrame[],
  points: NormPoint[],
  width: number,
  height: number,
  referenceFrameId: string,
): TiltAxisParams & { identifiable: boolean; reason?: string } {
  const byMarker = new Map<string, NormPoint[]>();
  for (const p of points) {
    const a = byMarker.get(p.markerId) ?? [];
    a.push(p);
    byMarker.set(p.markerId, a);
  }

  // 利用“近水平帧 vs 高倾角帧”的位移方向：位移方向即垂直于轴的方向。
  const angleById = new Map(frames.map((f) => [f.frameId, f.angleDeg]));
  const ordered = [...frames].sort((a, b) => Math.abs(a.angleDeg) - Math.abs(b.angleDeg));
  const low = ordered[0];
  const high = [...ordered].reverse().find((f) => Math.abs(angleById.get(f.frameId) ?? 0) >= 40);

  if (!high || byMarker.size < 3) {
    return {
      originX: width / 2,
      originY: height / 2,
      angleDeg: NaN,
      source: 'estimated',
      eccentricityPx: 0,
      referenceFrameId,
      identifiable: false,
      reason: 'insufficient-high-tilt-or-markers',
    };
  }

  const pairs: { rx: number; ry: number; x: number; y: number }[] = [];
  for (const pts of byMarker.values()) {
    const lp = pts.find((p) => p.frameId === low.frameId);
    const hp = pts.find((p) => p.frameId === high.frameId);
    if (lp && hp) pairs.push({ rx: lp.x, ry: lp.y, x: hp.x, y: hp.y });
  }
  if (pairs.length < 2) {
    return {
      originX: width / 2,
      originY: height / 2,
      angleDeg: NaN,
      source: 'estimated',
      eccentricityPx: 0,
      referenceFrameId,
      identifiable: false,
      reason: 'insufficient-paired-points',
    };
  }
  const fit = fitRigid(pairs);
  // 高倾角相对水平帧的旋转角给出轴方向；轴沿图像 x 的角度
  const axisAngle = fit.rotDeg / 2;

  // 轴位置：用高/低倾角 marker 连线中点的最小二乘“零线”交点估计。
  let mx = 0;
  let my = 0;
  for (const p2 of pairs) {
    mx += (p2.rx + p2.x) / 2;
    my += (p2.ry + p2.y) / 2;
  }
  mx /= pairs.length;
  my /= pairs.length;

  // 若数据本身没有偏心信号，估计值仍显式给出，不静默改成中心。
  const originX = mx;
  const originY = my;
  const eccentricityPx = Math.hypot(originX - width / 2, originY - height / 2);

  return {
    originX,
    originY,
    angleDeg: axisAngle,
    source: 'estimated',
    eccentricityPx,
    referenceFrameId,
    identifiable: true,
  };
}

/** 手工/导入给定轴：记录来源；中心仅在显式声明时允许。 */
export function explicitAxis(
  originX: number,
  originY: number,
  angleDeg: number,
  width: number,
  height: number,
  referenceFrameId: string,
  source: TiltAxisParams['source'],
): TiltAxisParams {
  return {
    originX,
    originY,
    angleDeg,
    source,
    eccentricityPx: Math.hypot(originX - width / 2, originY - height / 2),
    referenceFrameId,
  };
}
