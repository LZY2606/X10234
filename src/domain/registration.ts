import { solveLinear } from './linalg';
import { degToRad } from '../shared/geometry';

/**
 * 配准推导引擎（领域层）。
 *
 * 倾转轴绝不默认固定在图像中心：对每个候选同时拟合“自由锚点”与
 * “中心锚点”两种模型，保留自由锚点结果，并给出偏心量与中心假设的代价。
 */

export interface EngineObservation {
  canonicalTrackId: string;
  frameId: string;
  frameIndex: number;
  tiltDeg: number;
  xPx: number;
  yPx: number;
  excluded: boolean;
}

export interface AxisFit {
  angleDeg: number;
  anchorXPx: number;
  anchorYPx: false | number;
  imageCenterXPx: number;
  imageCenterYPx: number;
  eccentricityPx: number;
  anchoredAtImageCenter: number;
  ssePx2: number;
  centerAnchorSsePx2: number;
  ambiguityAnglesDeg: number[];
}

export interface CandidateConfig {
  kind: 'rigid' | 'local-deformation' | 'frame-exclusion';
  heldOutTrackIds: string[];
  allowCenterAnchor: boolean;
  ridgeLambda: number;
  equivalentResidualRatio: number;
  nmPerPx: number;
  imageWidthPx: number;
  imageHeightPx: number;
}

interface GlobalParams {
  alphaDeg: number;
  anchorXPx: number;
  anchorYPx: number;
  shiftPerp0: number;
  shiftPerp1: number;
  shiftPerp2: number;
  shiftPara0: number;
  shiftPara1: number;
  shiftPara2: number;
  trackS: number[];
  trackD: number[];
}

interface AxisSolution {
  alphaDeg: number;
  ssePx2: number;
  params: number[];
}

/** 给定轴角，解全局刚体模型（轴锚点 + 平滑漂移 + 各轨迹深度/侧向参数）。 */
function solveAtAngle(
  obs: EngineObservation[],
  alphaDeg: number,
  anchorToCenter: boolean,
  cx: number,
  cy: number,
  ridgeLambda: number,
): AxisSolution {
  const trackIds = [...new Set(obs.map((o) => o.canonicalTrackId))].sort();
  const t = degToRad(alphaDeg);
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const trackOffset = anchorToCenter ? 6 : 8;
  // 未知量: [sx0,sx1,sx2, sy0,sy1,sy2, (ax,ay,) s_k,d_k...]
  const n = trackOffset + 2 * trackIds.length;
  const rows: number[][] = [];
  const b: number[] = [];
  for (const o of obs) {
    const rx = new Array<number>(n).fill(0);
    const ry = new Array<number>(n).fill(0);
    rx[0] = 1; rx[1] = ti; rx[2] = ti * ti;
    ry[3] = 1; ry[4] = ti; ry[5] = ti * ti;
    if (!anchorToCenter) {
      rx[6] = 1 - c;
      rx[7] = sn;
      ry[6] = -sn;
      ry[7] = 1 - c;
    }
    const k = trackIds.indexOf(o.canonicalTrackId);
    rx[trackOffset + 2 * k] = c;
    rx[trackOffset + 2 * k + 1] = sn;
    ry[trackOffset + 2 * k] = -sn;
    ry[trackOffset + 2 * k + 1] = c;
    rows.push(rx, ry);
    b.push(o.xPx - (anchorToCenter ? cx : 0), o.yPx - (anchorToCenter ? cy : 0));
  }
  if (ridgeLambda > 0) {
    for (let p = trackOffset; p < n; p++) {
      const rx = new Array<number>(n).fill(0);
      rx[p] = ridgeLambda;
      rows.push(rx);
      b.push(0);
    }
  }
  const sol = solveLinear(rows, b, 1e-9);
  const params = sol.solution;
  let sse = 0;
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i].reduce((a, v, p) => a + v * params[p], 0) - b[i];
    sse += d * d;
  }
  return { alphaDeg, ssePx2: sse, params };
}
