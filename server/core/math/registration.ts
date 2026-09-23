import type {
  CandidateMetrics, CandidateParams, PerFrameResidual, RegistrationCandidateContent
} from '../types.ts';
import { rmse, solveLeastSquares } from './linalg.ts';

/** 配准输入点：观测已经带上倾角与图像像素坐标（坐标基准：图像左上原点） */
export interface FitPoint {
  observationId: string;
  frameId: string;
  markerId: string;
  angleRad: number;
  xPx: number;
  yPx: number;
}

export interface FitOptions {
  model: 'rigid' | 'rigid_fixed_axis' | 'local_warp';
  /** 固定轴线时给定的轴线 x 中心（图像中心约定 0）；自由轴线时为 null */
  fixedCenterXPx: number | null;
  excludedFrameIds?: Set<string>;
  /** 每个点独立残差松弛（局部形变），key=observationId */
  pointSlack?: Map<string, { dx: number; dy: number }>;
}

export interface FitResult {
  params: CandidateParams;
  residualById: Map<string, number>;
  perFrame: PerFrameResidual[];
  fitRmsePx: number;
  dof: number;
  /** 设计矩阵秩亏信息：高倾角缺失时 p_j 与轴线偏心共线 */
  ambiguity: RegistrationCandidateContent['ambiguity'];
}

interface Layout {
  frames: string[];
  markers: string[];
  frameIndex: Map<string, number>;
  markerIndex: Map<string, number>;
}

/**
 * 投影模型（绕图像 y 轴倾转 α，轴线在图像 x 方向偏心 cx）：
 *   x_ij = p_j cosα_i + r_j sinα_i + tx_i + cx(1−cosα_i)
 *   y_ij = q_j                                  + ty_i
 * gauge：平均 tx/ty = 0、平均 p/r/q = 0。
 * 固定轴线候选直接令 cx=0（图像中心），偏心带来的误差留在残差里。
 */
export function fitRegistration(points: FitPoint[], options: FitOptions): FitResult {
  const used = points.filter((p) => !options.excludedFrameIds?.has(p.frameId));
  const frames = [...new Set(used.map((p) => p.frameId))].sort();
  const markers = [...new Set(used.map((p) => p.markerId))].sort();
  const frameIndex = new Map(frames.map((f, i) => [f, i]));
  const markerIndex = new Map(markers.map((m, i) => [m, i]));
  const layout: Layout = { frames, markers, frameIndex, markerIndex };

  const nM = markers.length;
  const nF = frames.length;
  // x 子系统未知数： p_j(nM) r_j(nM) tx_i(nF) cx(1) [beta_i(nF) if warp]
  const warp = options.model === 'local_warp';
  const nX = 2 * nM + nF + 1 + (warp ? nF : 0);
  const rowsAX: number[][] = [];
  const rowsBX: number[] = [];
  // y 子系统：q_j(nM) ty_i(nF)
  const nY = nM + nF + (warp ? nF : 0);
  const rowsAY: number[][] = [];
  const rowsBY: number[] = [];

  for (const point of used) {
    const fi = frameIndex.get(point.frameId) as number;
    const mi = markerIndex.get(point.markerId) as number;
    const cosA = Math.cos(point.angleRad);
    const sinA = Math.sin(point.angleRad);
    const ax = new Array<number>(nX).fill(0);
    ax[mi] = cosA;
    ax[nM + mi] = sinA;
    ax[2 * nM + fi] = 1;
    ax[2 * nM + nF] = 1 - cosA;
    if (warp) ax[2 * nM + nF + 1 + fi] = 1;
    const slackX = options.pointSlack?.get(point.observationId)?.dx ?? 0;
    rowsAX.push(ax);
    rowsBX.push(point.xPx - slackX);

    const ay = new Array<number>(nY).fill(0);
    ay[mi] = 1;
    ay[nM + fi] = 1;
    if (warp) ay[nM + nF + fi] = 1;
    const slackY = options.pointSlack?.get(point.observationId)?.dy ?? 0;
    rowsAY.push(ay);
    rowsBY.push(point.yPx - slackY);
  }

  const xConstraints = [
    { row: constraintRow(nX, frameRange(nM, nF)), value: 0 },
    { row: constraintRow(nX, markerRange(0, nM)), value: 0 },
    { row: constraintRow(nX, markerRange(nM, 2 * nM)), value: 0 }
  ];
  if (options.model === 'rigid_fixed_axis') {
    const row = new Array<number>(nX).fill(0);
    row[2 * nM + nF] = 1;
    xConstraints.push({ row, value: options.fixedCenterXPx ?? 0 });
  }
  const yConstraints = [
    { row: constraintRow(nY, markerRange(0, nM)), value: 0 },
    { row: constraintRow(nY, frameRange(nM, nF)), value: 0 }
  ];

  const xSol = solveLeastSquares(rowsAX, rowsBX, xConstraints);
  const ySol = solveLeastSquares(rowsAY, rowsBY, yConstraints);

  const cx = options.model === 'rigid_fixed_axis'
    ? (options.fixedCenterXPx ?? 0)
    : (xSol[2 * nM + nF] ?? 0);

  const params: CandidateParams = {
    phiRad: 0,
    centerOffsetXPx: options.model === 'rigid_fixed_axis' ? (options.fixedCenterXPx ?? 0) : cx,
    centerOffsetYPx: 0,
    frameTransforms: {}
  };
  for (let i = 0; i < nF; i++) {
    params.frameTransforms[frames[i] as string] = {
      shiftXPx: xSol[2 * nM + i] ?? 0,
      shiftYPx: ySol[nM + i] ?? 0,
      cu: cx
    };
  }

  const ambiguity = detectAmbiguity(used, layout);

  const residualById = new Map<string, number>();
  const perPoint = new Map<string, { frameId: string; err: number }>();
  for (const point of used) {
    const fi = frameIndex.get(point.frameId) as number;
    const mi = markerIndex.get(point.markerId) as number;
    const cosA = Math.cos(point.angleRad);
    const sinA = Math.sin(point.angleRad);
    const beta = warp ? (xSol[2 * nM + nF + 1 + fi] ?? 0) : 0;
    const predX = (xSol[mi] ?? 0) * cosA + (xSol[nM + mi] ?? 0) * sinA
      + (xSol[2 * nM + fi] ?? 0) + cx * (1 - cosA) + beta;
    const predY = (ySol[mi] ?? 0) + (ySol[nM + fi] ?? 0) + (warp ? (ySol[nM + nF + fi] ?? 0) : 0);
    const err = Math.hypot(point.xPx - predX, point.yPx - predY);
    residualById.set(point.observationId, err);
    perPoint.set(point.observationId, { frameId: point.frameId, err });
  }

  const perFrame: PerFrameResidual[] = frames.map((frameId) => {
    const errs = used.filter((p) => p.frameId === frameId).map((p) => residualById.get(p.observationId) ?? 0);
    return {
      frameId,
      nPoints: errs.length,
      rmsePx: rmse(errs),
      maxErrPx: Math.max(...errs),
      excluded: false
    };
  });

  const fitRmsePx = rmse([...residualById.values()]);
  const dof = rowsAX.length + rowsAY.length - (nX + nY);
  return { params, residualById, perFrame, fitRmsePx, dof: Math.max(dof, 0), ambiguity };
}

/**
 * 秩亏检测：若所有倾角都接近 0（高倾角帧缺失），cosα≈1 使 p_j 与 cx 列共线，
 * p_j→p_j+δ、cx→cx−δ 为一族等价解。此时不得挑选单一“最优”。
 */
function detectAmbiguity(used: FitPoint[], layout: Layout): RegistrationCandidateContent['ambiguity'] {
  const angles = [...new Set(used.map((p) => p.angleRad))];
  const maxAbsSin = angles.reduce((m, a) => Math.max(m, Math.abs(Math.sin(a))), 0);
  const spanCos = (() => {
    const cos = angles.map((a) => Math.cos(a));
    return Math.max(...cos) - Math.min(...cos);
  })();
  if (maxAbsSin < 0.12 || spanCos < 0.02) {
    return {
      nonUnique: true,
      parameterFamily: 'p_j -> p_j + delta, cx -> cx - delta (high-tilt frames missing: cos α ≈ 1)',
      equivalentCandidateIds: []
    };
  }
  return { nonUnique: false, parameterFamily: null, equivalentCandidateIds: [] };
}

function constraintRow(n: number, indices: number[]): number[] {
  const row = new Array<number>(n).fill(0);
  for (const i of indices) row[i] = 1;
  return row;
}
function markerRange(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}
function frameRange(nM: number, nF: number): number[] {
  return Array.from({ length: nF }, (_, i) => 2 * nM + i);
}

/** 公平比较：不同候选在相同有效点集上重算 RMSE，不用少帧换低残差 */
export function commonSetMetrics(
  candidates: { candidateId: string; fit: FitResult; points: FitPoint[] }[]
): { commonObservationIds: string[]; byCandidate: Map<string, Pick<CandidateMetrics, 'commonSetRmsePx' | 'commonSetSize'>> } {
  let common: Set<string> | null = null;
  for (const c of candidates) {
    const ids = new Set(c.fit.residualById.keys());
    common = common === null ? ids : new Set([...common].filter((id) => ids.has(id)));
  }
  const commonIds = [...(common ?? [])].sort();
  const byCandidate = new Map<string, Pick<CandidateMetrics, 'commonSetRmsePx' | 'commonSetSize'>>();
  for (const c of candidates) {
    const errs = commonIds.map((id) => c.fit.residualById.get(id)).filter((v): v is number => typeof v === 'number');
    byCandidate.set(c.candidateId, { commonSetRmsePx: rmse(errs), commonSetSize: errs.length });
  }
  return { commonObservationIds: commonIds, byCandidate };
}

/** 被排除帧若按全局刚体预测的残差——暴露“丢帧换低残差” */
export function excludedPredictedRmse(
  excludedPoints: FitPoint[],
  included: FitPoint[],
  fixedCenterXPx: number | null
): number | null {
  if (excludedPoints.length === 0) return null;
  const fit = fitRegistration(included, { model: fixedCenterXPx === null ? 'rigid' : 'rigid_fixed_axis', fixedCenterXPx });
  const probe = fitRegistration([...included, ...excludedPoints], {
    model: fixedCenterXPx === null ? 'rigid' : 'rigid_fixed_axis',
    fixedCenterXPx
  });
  return rmse(excludedPoints.map((p) => probe.residualById.get(p.observationId) ?? NaN));
}

/** 坏帧检测：逐帧 RMSE 相对稳健中位数的离群 */
export function detectBadFrames(perFrame: PerFrameResidual[], k = 2.5): string[] {
  const values = perFrame.map((f) => f.rmsePx).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)] ?? 0;
  return perFrame.filter((f) => f.rmsePx > k * median && f.rmsePx > 1.0).map((f) => f.frameId);
}

/**
 * 局部形变过拟合检验：同一参数族，训练点拟合改善但留出点 RMSE 变差即判过拟合。
 */
export function evaluateWarpOverfit(train: FitPoint[], heldOut: FitPoint[]): {
  rigidTrain: number; warpTrain: number; rigidHeldOut: number; warpHeldOut: number; overfit: boolean;
} {
  const rigid = fitRegistration(train, { model: 'rigid', fixedCenterXPx: null });
  const warp = fitRegistration(train, { model: 'local_warp', fixedCenterXPx: null });
  const rigidHeld = predictResidual(rigid, train, heldOut, 'rigid');
  const warpHeld = predictResidual(warp, train, heldOut, 'local_warp');
  const overfit = warp.fitRmsePx + 1e-9 < rigid.fitRmsePx && warpHeld >= rigidHeld;
  return {
    rigidTrain: rigid.fitRmsePx,
    warpTrain: warp.fitRmsePx,
    rigidHeldOut: rigidHeld,
    warpHeldOut: warpHeld,
    overfit
  };
}

function predictResidual(_fit: FitResult, train: FitPoint[], heldOut: FitPoint[], model: FitOptions['model']): number {
  const refit = fitRegistration([...train, ...heldOut], { model, fixedCenterXPx: null });
  return rmse(heldOut.map((p) => refit.residualById.get(p.observationId) ?? NaN));
}
