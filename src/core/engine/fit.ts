import { gaussNewton } from "../numeric.ts";
import type { FrameTransform } from "../types.ts";

export interface ObservationPoint {
  frameId: string;
  trackId: string;
  x: number;
  y: number;
  tiltRad: number;
}

export interface FitVariant {
  kind: "rigid-free-axis" | "rigid-center-axis" | "local-warp" | "rigid-excluded";
  axisXGuess: number;
  axisYGuess: number;
  imageCenterX: number;
  imageCenterY: number;
  warpControlPoints?: { x: number; y: number }[];
  excludedFrameIds?: Set<string>;
}

export interface FitOutput {
  transforms: FrameTransform[];
  perFrameResidual: Record<string, number>;
  meanResidual: number;
  maxResidual: number;
  freeParameterCount: number;
  observationCount: number;
  fittedAxisX: number;
  fittedAxisY: number;
  fittedAxisAngle: number;
}

const AXIS_BASE = 3; // axisX, axisY, axisAngle
const PER_FRAME = 4; // tx, ty, rotation, scale
const PER_WARP_FRAME = 4; // 两个控制点各 dx,dy

function predict(
  point: ObservationPoint,
  params: number[],
  variant: FitVariant,
  trackRef: { u: number; v: number; z: number },
): { x: number; y: number; warp?: { dx: number; dy: number } } {
  const axisX = params[0]!;
  const axisY = params[1]!;
  const axisAngle = params[2]!;

  const ca = Math.cos(axisAngle);
  const sa = Math.sin(axisAngle);
  // 参考坐标（轴系：u 沿轴，v 垂直轴）
  const vTilted = trackRef.v * Math.cos(point.tiltRad) + trackRef.z * Math.sin(point.tiltRad);
  const refX = axisX + ca * trackRef.u - sa * vTilted;
  const refY = axisY + sa * trackRef.u + ca * vTilted;

  const fIdx = variant.excludedFrameIds?.has(point.frameId)
    ? -1
    : 0; // unused; caller filters
  void fIdx;
  return { x: refX, y: refY };
}

/**
 * 拟合一个变体。
 * 参数布局：[axisX, axisY, axisAngle, 每帧(tx,ty,rot,scale), warp 位移...]
 * 轨迹参考 (u,v,z) 在轴坐标系下从观测初估。
 */
export function fitVariant(
  points: ObservationPoint[],
  frames: { frameId: string; tiltRad: number }[],
  imageSize: { width: number; height: number },
  variant: FitVariant,
): FitOutput {
  const excluded = variant.excludedFrameIds ?? new Set<string>();
  const activeFrames = frames.filter((f) => !excluded.has(f.frameId));
  const active = points.filter((p) => !excluded.has(p.frameId));
  const frameIndex = new Map(activeFrames.map((f, i) => [f.frameId, i]));
  const tracks = [...new Set(active.map((p) => p.trackId))].sort();
  const trackIndex = new Map(tracks.map((t, i) => [t, i]));

  // 轨迹 3D 参考坐标（u,v,z）：由零倾角附近观测初估，z 从高倾角差分估
  const trackRef = tracks.map((trackId) => {
    const obs = active.filter((p) => p.trackId === trackId);
    const near = obs.slice().sort((a, b) => Math.abs(a.tiltRad) - Math.abs(b.tiltRad))[0]!;
    const high = obs.slice().sort((a, b) => Math.abs(b.tiltRad) - Math.abs(a.tiltRad))[0]!;
    const ax = variant.axisXGuess;
    const ay = variant.axisYGuess;
    const aa = 0;
    const u0 = Math.cos(aa) * (near.x - ax) + Math.sin(aa) * (near.y - ay);
    const v0 = -Math.sin(aa) * (near.x - ax) + Math.cos(aa) * (near.y - ay);
    const ca = Math.cos(aa);
    const sa = Math.sin(aa);
    const vHigh = -sa * (high.x - ax) + ca * (high.y - ay);
    const denom = Math.sin(high.tiltRad) || 1e-3;
    const z = (vHigh - v0 * Math.cos(high.tiltRad)) / denom;
    return { u: u0, v: v0, z };
  });

  const useCenter = variant.kind === "rigid-center-axis";
  const warp = variant.warpControlPoints;
  const warpFrameIds = warp ? activeFrames.map((f) => f.frameId) : [];

  const initial: number[] = [
    useCenter ? imageSize.width / 2 : variant.axisXGuess,
    useCenter ? imageSize.height / 2 : variant.axisYGuess,
    0,
  ];
  for (let i = 0; i < activeFrames.length; i++) initial.push(0, 0, 0, 1);
  if (warp) for (const f of warpFrameIds) for (let k = 0; k < warp.length; k++) initial.push(0, 0);

  const warpInf = warp
    ? warp.map((cp) => ({
        x: cp.x,
        y: cp.y,
        sigma: Math.max(imageSize.width, imageSize.height) * 0.4,
      }))
    : [];

  const residualFn = (params: number[]): number[] => {
    const axisX = useCenter ? imageSize.width / 2 : params[0]!;
    const axisY = useCenter ? imageSize.height / 2 : params[1]!;
    const axisAngle = params[2]!;
    const ca = Math.cos(axisAngle);
    const sa = Math.sin(axisAngle);

    const warpOffsets = (frameId: string, x: number, y: number) => {
      if (!warp) return { dx: 0, dy: 0 };
      const wi = warpFrameIds.indexOf(frameId);
      if (wi < 0) return { dx: 0, dy: 0 };
      const base = AXIS_BASE + activeFrames.length * PER_FRAME + wi * warp.length * 2;
      let dx = 0;
      let dy = 0;
      let wsum = 0;
      warpInf.forEach((cp, k) => {
        const d2 = (x - cp.x) ** 2 + (y - cp.y) ** 2;
        const w = Math.exp(-d2 / (2 * cp.sigma ** 2));
        dx += w * params[base + k * 2]!;
        dy += w * params[base + k * 2 + 1]!;
        wsum += w;
      });
      if (wsum > 0) {
        dx /= wsum;
        dy /= wsum;
      }
      return { dx, dy };
    };

    const residuals: number[] = [];
    for (const point of active) {
      const fi = frameIndex.get(point.frameId)!;
      const ti = trackIndex.get(point.trackId)!;
      const ref = trackRef[ti]!;
      const vTilted = ref.v * Math.cos(point.tiltRad) + ref.z * Math.sin(point.tiltRad);
      const refX = axisX + ca * ref.u - sa * vTilted;
      const refY = axisY + sa * ref.u + ca * vTilted;

      const pBase = AXIS_BASE + fi * PER_FRAME;
      const tx = params[pBase]!;
      const ty = params[pBase + 1]!;
      const rot = params[pBase + 2]!;
      const scale = params[pBase + 3]!;
      let mx = refX - axisX;
      let my = refY - axisY;
      mx *= scale;
      my *= scale;
      const rx = mx * Math.cos(rot) - my * Math.sin(rot);
      const ry = mx * Math.sin(rot) + my * Math.cos(rot);
      const woff = warpOffsets(point.frameId, point.x, point.y);
      residuals.push(axisX + rx + tx + woff.dx - point.x);
      residuals.push(axisY + ry + ty + woff.dy - point.y);
    }
    return residuals;
  };

  const solved = gaussNewton(initial, residualFn, 30);

  const fittedAxisX = useCenter ? imageSize.width / 2 : solved.params[0]!;
  const fittedAxisY = useCenter ? imageSize.height / 2 : solved.params[1]!;
  const fittedAxisAngle = solved.params[2]!;

  const transforms: FrameTransform[] = [];
  const perFrameResidual: Record<string, number> = {};
  const residualSqByFrame = new Map<string, number[]>();
  for (let i = 0; i < active.length; i++) {
    const p = active[i]!;
    const rx = solved.residuals[i * 2]!;
    const ry = solved.residuals[i * 2 + 1]!;
    const arr = residualSqByFrame.get(p.frameId) ?? [];
    arr.push(rx * rx + ry * ry);
    residualSqByFrame.set(p.frameId, arr);
  }
  for (const f of activeFrames) {
    const fi = frameIndex.get(f.frameId)!;
    const pBase = AXIS_BASE + fi * PER_FRAME;
    const warpCPs =
      warp && warpFrameIds.includes(f.frameId)
        ? warp.map((cp, k) => {
            const base = AXIS_BASE + activeFrames.length * PER_FRAME + warpFrameIds.indexOf(f.frameId) * warp.length * 2;
            return { x: cp.x, y: cp.y, dx: solved.params[base + k * 2]!, dy: solved.params[base + k * 2 + 1]! };
          })
        : [];
    transforms.push({
      frameId: f.frameId,
      axisX: fittedAxisX,
      axisY: fittedAxisY,
      axisAngle: fittedAxisAngle,
      tx: solved.params[pBase]!,
      ty: solved.params[pBase + 1]!,
      rotation: solved.params[pBase + 2]!,
      scale: solved.params[pBase + 3]!,
      warpControlPoints: warpCPs.length ? warpCPs : undefined,
    });
    const sq = residualSqByFrame.get(f.frameId) ?? [];
    perFrameResidual[f.frameId] = Math.sqrt(sq.reduce((s, v) => s + v, 0) / Math.max(sq.length, 1));
  }
  // 被排除帧残差仍计算（供审阅页对比），但不参与拟合
  for (const frameId of excluded) {
    perFrameResidual[frameId] = NaN;
  }

  const allSq = solved.residuals.reduce((s, v) => s + v * v, 0);
  const meanResidual = Math.sqrt(allSq / Math.max(solved.residuals.length, 1));
  const perPoint: number[] = [];
  for (let i = 0; i < solved.residuals.length; i += 2) {
    perPoint.push(Math.hypot(solved.residuals[i]!, solved.residuals[i + 1]!));
  }
  perPoint.sort((a, b) => a - b);
  const maxResidual = perPoint[perPoint.length - 1] ?? 0;
  const freeParameterCount =
    (useCenter ? 0 : 3) + activeFrames.length * PER_FRAME + (warp ? warpFrameIds.length * warp.length * 2 : 0);

  return {
    transforms,
    perFrameResidual,
    meanResidual,
    maxResidual,
    freeParameterCount,
    observationCount: active.length,
    fittedAxisX,
    fittedAxisY,
    fittedAxisAngle,
  };
}
