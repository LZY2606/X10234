import type { TiltAxisParams } from '../core/domain.js';

export interface ModelPoint {
  x: number;
  y: number;
}

/** 模型坐标（轴为 x 方向）下，3D fiducial 在某倾角的投影 + 帧刚体变换 */
export interface FrameTransformVars {
  along: number; // 沿轴平移 px
  off: number; // 离轴平移 px
  rot: number; // 帧内微旋转 rad
  warpQAlong: number; // 局部二次形变（local-warp 才非零）
  warpQOff: number;
}

export interface Marker3D {
  x: number;
  y: number;
  z: number;
}

export interface GlobalAxis {
  theta: number; // 轴相对图像 x 轴，rad
  cx: number; // 轴经过点（图像像素基准）
  cy: number;
}

export function projectObservation(
  axis: GlobalAxis,
  frame: { tiltRad: number; vars: FrameTransformVars; warp: boolean },
  marker: Marker3D,
): ModelPoint {
  const c = Math.cos(frame.tiltRad);
  const s = Math.sin(frame.tiltRad);
  let mx = marker.x + frame.vars.along;
  let my = marker.y * c + marker.z * s + frame.vars.off;
  if (frame.warp) {
    mx += frame.vars.warpQAlong * marker.x * marker.x;
    my += frame.vars.warpQOff * my * my;
  }
  const r = frame.vars.rot;
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  const rx = mx * cr - my * sr;
  const ry = mx * sr + my * cr;
  const ct = Math.cos(axis.theta);
  const st = Math.sin(axis.theta);
  return {
    x: axis.cx + rx * ct - ry * st,
    y: axis.cy + rx * st + ry * ct,
  };
}

export function describeAxis(axis: GlobalAxis, frameWidth: number, frameHeight: number): TiltAxisParams {
  return {
    angleDeg: (axis.theta * 180) / Math.PI,
    axisCenter: { x: axis.cx, y: axis.cy },
    frameCenter: { x: frameWidth / 2, y: frameHeight / 2 },
    coordinateBasis: 'image-pixel:top-left:x-right-y-down',
  };
}
