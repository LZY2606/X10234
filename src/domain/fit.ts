/**
 * 配准候选推导。
 *
 * 刚体模型：观测 = R(-θ_f)·B_b + C + t_f
 *   θ_f = α·tan(τ_f)，C = 图像中心 + h·n（轴线偏心 h 显式估计，绝不固定为 0）
 * 局部形变候选为每帧加入小仿射项，用交叉验证识别过拟合。
 *
 * 公平性：
 *  - 不同候选用相同有效点集（交集）比较 rmsOnCommonSet；
 *  - 排除坏帧不得仅靠删帧降低残差；
 *  - 多解时保留全部等价候选，不做不可逆选择。
 */
import type {
  AlignmentCandidate,
  CandidateStrategy,
  Diagnostic,
  JudgmentBasis,
  MarkerObservation,
  TiltAxisSpec,
  Uid,
} from './types.js';
import { leastSquares, rms } from './geometry.js';
import { requireValue, scalarQuantity } from './quantities.js';
import { canonicalJson, sha256Json, stableId } from './identifiers.js';

export interface FitFrame {
  frameId: Uid;
  index: number;
  tiltDeg: number;
  width: number;
  height: number;
}

export interface FitObservation {
  trackId: Uid;
  frameId: Uid;
  x: number;
  y: number;
}

export type TrackIdentityResolution = Record<Uid, Uid>;

export interface FitInput {
  frames: FitFrame[];
  observations: MarkerObservation[];
  identityResolution?: TrackIdentityResolution;
  manuallyExcludedFrameIds?: Uid[];
  imageCenterAssumed?: boolean;
  ruleVersion: string;
  interpretationId: Uid;
  variantTag?: string;
}

interface Solution {
  betaDeg: number;
  alpha: number;
  h: number;
  beadPoints: Array<{ trackId: Uid; bx: number; by: number }>;
  translations: Array<{ frameId: Uid; tx: number; ty: number }>;
  warps?: Array<{ frameId: Uid; a: number; b: number; c: number; d: number }>;
  used: FitObservation[];
  heldOut?: FitObservation[];
  rms: number;
  heldOutRms?: number;
  dof: number;
}

function sinDeg(d: number): number {
  return Math.sin((d * Math.PI) / 180);
}
function cosDeg(d: number): number {
  return Math.cos((d * Math.PI) / 180);
}

function toFitObservations(
  observations: MarkerObservation[],
  resolution?: TrackIdentityResolution,
): FitObservation[] {
  return observations
    .filter((o) => o.observed)
    .map((o) => ({
      trackId: resolution?.[o.trackId] ?? o.trackId,
      frameId: o.frameId,
      x: requireValue(o.x),
      y: requireValue(o.y),
    }));
}

export function effectivePointSet(
  observations: MarkerObservation[],
  frameIds: Uid[],
): { points: Array<{ trackId: Uid; frameId: Uid }>; hash: string } {
  const allowed = new Set(frameIds);
  const points = observations
    .filter((o) => o.observed && allowed.has(o.frameId))
    .map((o) => ({ trackId: o.trackId, frameId: o.frameId }))
    .sort((a, b) =>
      a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : a.frameId < b.frameId ? -1 : 1,
    );
  return { points, hash: sha256Json(points) };
}

interface CoreOptions {
  localWarp: boolean;
  excluded: Set<Uid>;
  trainKeys?: Set<string>;
}

/**
 * 在给定轴线方向 beta 下求解：先把观测旋转到以 beta 为 x 轴的坐标系，
 * C = (cx0, cy0 + h)（x 用图像中心 gauge 固定，h 沿法向显式自由）。
 */
export function fitAtBeta(
  frames: FitFrame[],
  observations: FitObservation[],
  betaDeg: number,
  alpha: number,
  opts: CoreOptions,
): Solution | null {
  const cb = cosDeg(betaDeg);
  const sb = sinDeg(betaDeg);
  const frameById = new Map(frames.map((f) => [f.frameId, f]));
  const activeFrames = frames.filter((f) => !opts.excluded.has(f.frameId));
  if (activeFrames.length < 2) return null;

  const rot = (x: number, y: number): [number, number] => [
    cb * x + sb * y,
    -sb * x + cb * y,
  ];

  const trackIds = [...new Set(observations.map((o) => o.trackId))].sort();
  // bead0 隐式位于原点（相对坐标）；其余珠各 2 参数
  const beadIndex = new Map<Uid, number>();
  trackIds.forEach((t, i) => {
    if (i > 0) beadIndex.set(t, (i - 1) * 2);
  });
  const gIndex = (trackIds.length - 1) * 2;
  const hIndex = gIndex + 1;
  const transIndex = new Map<Uid, number>();
  activeFrames.forEach((f, i) => transIndex.set(f.frameId, hIndex + 1 + i * 2));
  const transBase = hIndex + 1;
  const warpBase = transBase + activeFrames.length * 2;
  const nParams = warpBase + (opts.localWarp ? activeFrames.length * 4 : 0);

  const train = observations.filter(
    (o) => !opts.excluded.has(o.frameId) && (!opts.trainKeys || opts.trainKeys.has(`${o.trackId}|${o.frameId}`)),
  );
  if (train.length < trackIds.length * 2 + 3) return null;

  const A: number[][] = [];
  const b: number[] = [];
  for (const obs of train) {
    const frame = frameById.get(obs.frameId);
    if (!frame) continue;
    const [ur0, vr0] = rot(obs.x, obs.y);
    const [uc0, vc0] = rot(frame.width / 2, frame.height / 2);
    const theta = alpha * Math.tan((frame.tiltDeg * Math.PI) / 180);
    const ct = cosDeg(-theta);
    const st = sinDeg(-theta);
    const bi = beadIndex.get(obs.trackId);
    const ti = transIndex.get(obs.frameId)!;

    const uRow = new Array(nParams).fill(0);
    if (bi !== undefined) {
      uRow[bi] = ct;
      uRow[bi + 1] = -st;
    }
    uRow[gIndex] = 1;
    uRow[ti] = 1; // 平移在旋转之后相加，不乘 R(-θ)
    A.push(uRow);
    b.push(ur0 - uc0);

    const vRow = new Array(nParams).fill(0);
    if (bi !== undefined) {
      vRow[bi] = st;
      vRow[bi + 1] = ct;
    }
    vRow[hIndex] = 1;
    vRow[ti + 1] = 1;
    if (opts.localWarp) {
      const fi = activeFrames.findIndex((f) => f.frameId === frame.frameId);
      const wi = warpBase + fi * 4;
      const du = ur0 - uc0;
      const dv = vr0 - vc0;
      vRow[wi + 2] = du;
      vRow[wi + 3] = dv;
      uRow[wi] = du;
      uRow[wi + 1] = dv;
    }
    A.push(vRow);
    b.push(vr0 - vc0);
  }

  // gauge（硬约束：直接把约束参数列删除）：
  //  1) 第一帧平移 = 0；
  //  2) 基准珠（trackIds[0]）位于旋转系原点 (0,0)；
  //  3) 第二颗珠位于 u 轴上（v=0），锁死绕原点旋转。
  const fixedCols = new Set<number>();
  const ti0 = transIndex.get(activeFrames[0]!.frameId)!;
  fixedCols.add(ti0);
  fixedCols.add(ti0 + 1);
  if (trackIds.length > 1) fixedCols.add(beadIndex.get(trackIds[1]!)! + 1);
  const redA = A.map((row) => row.filter((_, p) => !fixedCols.has(p)));

  let rx: number[];
  try {
    ({ x: rx } = leastSquares(redA, b));
  } catch {
    return null;
  }
  const x = new Array(nParams).fill(0);
  let k = 0;
  for (let p = 0; p < nParams; p++) {
    if (!fixedCols.has(p)) x[p] = rx[k++]!;
  }
  const residRms = rms(
    A.map((row, i) => b[i]! - row.reduce((s, a, p) => s + a * x[p]!, 0)),
  );

  // 转回图像坐标
  const h = x[hIndex]!;
  const g = x[gIndex]!;
  void g;
  const [axisCX, axisCY] = [cb * 0 - sb * h, sb * 0 + cb * h].map((v, i) =>
    i === 0 ? v + activeFrames[0]!.width / 2 : v + activeFrames[0]!.height / 2,
  );
  const beadPoints = trackIds.map((t, i) => {
    if (i === 0) return { trackId: t, bx: 0, by: 0 };
    const bi = beadIndex.get(t)!;
    const u = x[bi]!;
    const v = x[bi + 1]!;
    return { trackId: t, bx: cb * u - sb * v, by: sb * u + cb * v };
  });
  const translations = activeFrames.map((f) => {
    const ti = transIndex.get(f.frameId)!;
    const tu = x[ti]!;
    const tv = x[ti + 1]!;
    return { frameId: f.frameId, tx: cb * tu - sb * tv, ty: sb * tu + cb * tv };
  });
  const warps = opts.localWarp
    ? activeFrames.map((f, fi) => {
        const wi = warpBase + fi * 4;
        return { frameId: f.frameId, a: x[wi]!, b: x[wi + 1]!, c: x[wi + 2]!, d: x[wi + 3]! };
      })
    : undefined;

  return {
    betaDeg,
    alpha,
    h,
    beadPoints,
    translations,
    warps,
    used: train,
    rms: residRms,
    dof: nParams - 2 - (trackIds.length > 1 ? 1 : 0),
  };
}

function evaluateSolution(
  frames: FitFrame[],
  allObs: FitObservation[],
  sol: Solution,
  excluded: Set<Uid>,
  localWarp: boolean,
): {
  perFrame: Map<Uid, { mean: number; max: number; n: number }>;
  perObs: Map<string, number>;
  heldOutRms?: number;
} {
  const frameById = new Map(frames.map((f) => [f.frameId, f]));
  const bead = new Map(sol.beadPoints.map((p) => [p.trackId, p]));
  const trans = new Map(sol.translations.map((t) => [t.frameId, t]));
  const warp = new Map((sol.warps ?? []).map((w) => [w.frameId, w]));
  const cb = cosDeg(sol.betaDeg);
  const sb = sinDeg(sol.betaDeg);
  const rot = (x: number, y: number): [number, number] => [cb * x + sb * y, -sb * x + cb * y];

  const perFrame = new Map<Uid, { vals: number[] }>();
  const perObs = new Map<string, number>();
  const heldOutVals: number[] = [];
  const trainKeys = new Set(sol.used.map((o) => `${o.trackId}|${o.frameId}`));

  for (const obs of allObs) {
    const frame = frameById.get(obs.frameId);
    if (!frame) continue;
    const p = bead.get(obs.trackId);
    if (!p) continue;
    const isExcluded = excluded.has(obs.frameId);
    const tr = trans.get(obs.frameId) ?? { frameId: obs.frameId, tx: 0, ty: 0 };
    const theta = sol.alpha * Math.tan((frame.tiltDeg * Math.PI) / 180);
    const ct = cosDeg(-theta);
    const st = sinDeg(-theta);
    const [uc, vc] = rot(frame.width / 2, frame.height / 2);
    const [pu, pv] = rot(p.bx, p.by);
    let predU = ct * pu - st * pv + uc + cb * tr.tx - sb * tr.ty;
    let predV = st * pu + ct * pv + vc + sb * tr.tx + cb * tr.ty + sol.h;
    const [ou, ov] = rot(obs.x, obs.y);
    if (localWarp && !isExcluded) {
      const w = warp.get(obs.frameId);
      if (w) {
        predU += w.a * (ou - uc) + w.b * (ov - vc);
        predV += w.c * (ou - uc) + w.d * (ov - vc);
      }
    }
    const dist = Math.hypot(ou - predU, ov - predV);
    perObs.set(`${obs.trackId}|${obs.frameId}`, dist);
    if (!isExcluded) {
      const entry = perFrame.get(obs.frameId) ?? { vals: [] };
      entry.vals.push(dist);
      perFrame.set(obs.frameId, entry);
    }
    if (!trainKeys.has(`${obs.trackId}|${obs.frameId}`) && !isExcluded) heldOutVals.push(dist);
  }

  const result = new Map<Uid, { mean: number; max: number; n: number }>();
  for (const [frameId, { vals }] of perFrame) {
    result.set(frameId, {
      mean: vals.reduce((s, v) => s + v, 0) / vals.length,
      max: Math.max(...vals),
      n: vals.length,
    });
  }
  return {
    perFrame: result,
    perObs,
    heldOutRms: heldOutVals.length > 0 ? rms(heldOutVals) : undefined,
  };
}

interface GridResult {
  solutions: Solution[];
  equivalentGroups: Solution[][];
}

function gridSearch(
  frames: FitFrame[],
  observations: FitObservation[],
  opts: CoreOptions,
  alphaRange: [number, number],
  heldOutKeys?: Set<string>,
): GridResult {
  const betas: number[] = [];
  for (let b = -90; b < 90; b += 5) betas.push(b);
  const alphas: number[] = [];
  for (let a = alphaRange[0]; a <= alphaRange[1]; a += 0.1) alphas.push(Number(a.toFixed(4)));

  let best: Solution | null = null;
  const allMinima: Solution[] = [];
  for (const beta of betas) {
    for (const alpha of alphas) {
      const trainOpts: CoreOptions = heldOutKeys
        ? { ...opts, trainKeys: undefined }
        : opts;
      if (heldOutKeys) {
        trainOpts.trainKeys = new Set(
          observations
            .filter((o) => !heldOutKeys.has(`${o.trackId}|${o.frameId}`))
            .map((o) => `${o.trackId}|${o.frameId}`),
        );
      }
      const sol = fitAtBeta(frames, observations, beta, alpha, trainOpts);
      if (!sol) continue;
      if (heldOutKeys) {
        sol.heldOut = observations.filter((o) => heldOutKeys.has(`${o.trackId}|${o.frameId}`));
      }
      allMinima.push(sol);
      if (!best || sol.rms < best.rms) best = sol;
    }
  }
  if (!best) return { solutions: [], equivalentGroups: [] };

  // 局部精炼：在最优点附近加密 beta/alpha
  const refine: Solution[] = [];
  for (let b = best.betaDeg - 5; b <= best.betaDeg + 5; b += 1) {
    for (let a = best.alpha - 0.1; a <= best.alpha + 0.1; a += 0.02) {
      const sol = fitAtBeta(frames, observations, b, Number(a.toFixed(4)), opts);
      if (sol) refine.push(sol);
    }
  }
  refine.sort((p, q) => p.rms - q.rms);
  best = refine[0] ?? best;

  // 多解检测：找出与最优 RMS 相差 <1% 的不同 (beta, alpha) 吸引盆
  const threshold = best.rms * 1.01;
  const near = allMinima
    .filter((s) => s.rms <= threshold)
    .sort((p, q) => p.rms - q.rms);
  const groups: Solution[][] = [];
  for (const s of near) {
    const g = groups.find((grp) =>
      grp.some(
        (m) =>
          Math.abs(m.betaDeg - s.betaDeg) < 12 && Math.abs(m.alpha - s.alpha) < 0.15,
      ),
    );
    if (g) g.push(s);
    else groups.push([s]);
  }
  const representatives = groups
    .map((g) => g.reduce((p, q) => (q.rms < p.rms ? q : p)))
    .sort((p, q) => p.rms - q.rms);

  return { solutions: representatives, equivalentGroups: groups };
}

let CANDIDATE_SEQ = 0;

export interface CandidateSet {
  candidates: AlignmentCandidate[];
  basis: JudgmentBasis[];
}

export function resetCandidateSeq(): void {
  CANDIDATE_SEQ = 0;
}

function makeAxisSpec(
  sol: Solution,
  frame: { width: number; height: number },
  imageCenterAssumed: boolean,
): TiltAxisSpec {
  const cb = cosDeg(sol.betaDeg);
  const sb = sinDeg(sol.betaDeg);
  // 旋转坐标下中心 (0, h) → 图像坐标
  const cx = cb * 0 - sb * sol.h + frame.width / 2;
  const cy = sb * 0 + cb * sol.h + frame.height / 2;
  const off = Math.hypot(cx - frame.width / 2, cy - frame.height / 2);
  return {
    kind: 'TiltAxisSpec',
    axisId: stableId('axis', { interp: sol.betaDeg, alpha: sol.alpha, h: sol.h }),
    directionAngle: {
      kind: 'angle',
      raw: Number(sol.betaDeg.toFixed(3)),
      unit: 'degree',
      value: Number(sol.betaDeg.toFixed(3)),
      normalizedUnit: 'degree',
      coordFrame: 'image-pixel',
    },
    centerX: {
      kind: 'length',
      raw: Number(cx.toFixed(3)),
      unit: 'pixel',
      value: Number(cx.toFixed(3)),
      normalizedUnit: 'pixel',
      coordFrame: 'image-pixel',
    },
    centerY: {
      kind: 'length',
      raw: Number(cy.toFixed(3)),
      unit: 'pixel',
      value: Number(cy.toFixed(3)),
      normalizedUnit: 'pixel',
      coordFrame: 'image-pixel',
    },
    assumedImageCenter: imageCenterAssumed,
    diagnostic:
      off > 1 && !imageCenterAssumed
        ? {
            code: 'AXIS_NOT_CENTERED',
            severity: 'info',
            message: `倾转轴穿过点偏离图像中心 ${off.toFixed(2)} px；不允许默认固定在中心`,
          }
        : imageCenterAssumed
          ? {
              code: 'AXIS_CENTER_ASSUMED',
              severity: 'warning',
              message: '显式采用了图像中心假设；该假设是可见选择而非默认值',
            }
          : undefined,
  };
}

function toCandidate(
  sol: Solution,
  input: FitInput,
  strategy: CandidateStrategy,
  label: string,
  effectiveFrames: FitFrame[],
  evaluated: ReturnType<typeof evaluateSolution>,
  ambiguityGroup?: string,
  extraDiags: Diagnostic[] = [],
): { candidate: AlignmentCandidate; perObs: Map<string, number> } {
  const obs = toFitObservations(input.observations, input.identityResolution);
  const { points, hash } = effectivePointSet(
    input.observations,
    effectiveFrames.map((f) => f.frameId),
  );
  const excludedSet = new Set(
    input.frames.filter((f) => !effectiveFrames.some((e) => e.frameId === f.frameId)).map((f) => f.frameId),
  );
  const first = effectiveFrames[0] ?? input.frames[0]!;
  const residuals = effectiveFrames.map((f) => {
    const stat = evaluated.perFrame.get(f.frameId);
    return {
      residualId: stableId('resid', { cand: sol.betaDeg, frame: f.frameId }),
      candidateId: '',
      frameId: f.frameId,
      meanResidual: scalarQuantity(stat?.mean ?? NaN),
      maxResidual: scalarQuantity(stat?.max ?? NaN),
      observationCount: stat?.n ?? 0,
      excludedFromFit: excludedSet.has(f.frameId),
      frameWeight: 1,
    };
  });
  const usedKeys = new Set(sol.used.map((o) => `${o.trackId}|${o.frameId}`));
  const usedVals = [...evaluated.perObs.entries()]
    .filter(([k]) => usedKeys.has(k))
    .map(([, v]) => v);
  const rmsVal = rms(usedVals);
  const cand: AlignmentCandidate = {
    kind: 'AlignmentCandidate',
    candidateId: '',
    interpretationId: input.interpretationId,
    strategy,
    label,
    tiltAxis: makeAxisSpec(sol, first, input.imageCenterAssumed ?? false),
    effectivePointSetHash: hash,
    effectivePointSet: points,
    effectiveFrameIds: effectiveFrames.map((f) => f.frameId),
    perFrameResiduals: [],
    rmsResidual: scalarQuantity(sol.rms),
    rmsOnCommonSet: scalarQuantity(Number.isFinite(rmsVal) ? rmsVal : sol.rms),
    heldOutRms: evaluated.heldOutRms !== undefined ? scalarQuantity(evaluated.heldOutRms) : undefined,
    degreesOfFreedom: sol.dof,
    parameterSummary: `alpha=${sol.alpha.toFixed(3)}, beta=${sol.betaDeg.toFixed(2)}°, h=${sol.h.toFixed(2)}px, frames=${effectiveFrames.length}, tracks=${sol.beadPoints.length}`,
    diagnostics: extraDiags,
    ambiguityGroup,
  };
  const candidateId = stableId(`cand-${++CANDIDATE_SEQ}`, {
    interp: input.interpretationId,
    strategy,
    hash,
    label,
    sol: [sol.betaDeg, sol.alpha, sol.h, sol.rms],
    variant: input.variantTag ?? null,
  });
  cand.candidateId = candidateId;
  cand.perFrameResiduals = residuals.map((r) => ({
    ...r,
    residualId: stableId('resid', { cand: candidateId, frame: r.frameId }),
    candidateId,
  }));
  cand.tiltAxis.axisId = stableId('axis', { cand: candidateId });
  void obs;
  return { candidate: cand, perObs: evaluated.perObs };
}

/**
 * 计算一个解释下的全部候选（刚体 / 局部形变 / 排除坏帧）。
 * 多解时保留同一 ambiguityGroup 内全部合法候选。
 */
export function computeCandidates(input: FitInput): CandidateSet {
  const obs = toFitObservations(input.observations, input.identityResolution);
  const perObsById = new Map<string, Map<string, number>>();
  const manualExcluded = new Set(input.manuallyExcludedFrameIds ?? []);
  const allFrames = input.frames;

  // ---- 刚体（全部帧）----
  const rigidGrid = gridSearch(allFrames, obs, { localWarp: false, excluded: manualExcluded }, [0.8, 1.6]);
  const rigidCandidates = rigidGrid.solutions.map((sol, i) => {
    const evaluated = evaluateSolution(allFrames, obs, sol, manualExcluded, false);
    const group =
      rigidGrid.equivalentGroups.length > 1
        ? stableId('ambg', { interp: input.interpretationId, beta: sol.betaDeg, alpha: sol.alpha })
        : undefined;
    const diags: Diagnostic[] = [];
    if (rigidGrid.equivalentGroups.length > 1) {
      diags.push({
        code: 'MULTI_SOLUTION_ALL_KEPT',
        severity: 'warning',
        message: `有效点集上存在 ${rigidGrid.equivalentGroups.length} 个等价合法解，全部保留，等待人工裁定`,
      });
    }
    const built = toCandidate(
      sol,
      input,
      'rigid',
      rigidGrid.equivalentGroups.length > 1 ? `刚体候选 ${i + 1}（等价多解）` : '刚体（全部帧）',
      allFrames.filter((f) => !manualExcluded.has(f.frameId)),
      evaluated,
      group,
      diags,
    );
    perObsById.set(built.candidate.candidateId, built.perObs);
    return built.candidate;
  });

  // ---- 局部形变（25% 观测留出交叉验证）----
  const heldOutKeys = new Set<string>();
  const sortedObs = [...obs].sort((a, b) =>
    a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : a.frameId < b.frameId ? -1 : 1,
  );
  sortedObs.forEach((o, i) => {
    if (i % 4 === 3) heldOutKeys.add(`${o.trackId}|${o.frameId}`);
  });
  const warpGrid = gridSearch(
    allFrames,
    obs,
    { localWarp: true, excluded: manualExcluded },
    [0.8, 1.6],
    heldOutKeys,
  );
  const warpCandidates = warpGrid.solutions.slice(0, 1).map((sol) => {
    const evaluated = evaluateSolution(allFrames, obs, sol, manualExcluded, true);
    const diags: Diagnostic[] = [];
    if (evaluated.heldOutRms !== undefined && evaluated.heldOutRms > sol.rms * 1.5 + 0.2) {
      diags.push({
        code: 'LOCAL_WARP_OVERFIT_DETECTED',
        severity: 'warning',
        message: `局部形变训练 RMS=${sol.rms.toFixed(3)} 但留出集 RMS=${evaluated.heldOutRms.toFixed(
          3,
        )}，自由度被用来拟合噪声`,
      });
    }
    const built = toCandidate(sol, input, 'local-warp', '局部形变（每帧仿射）', allFrames.filter((f) => !manualExcluded.has(f.frameId)), evaluated, undefined, diags);
    perObsById.set(built.candidate.candidateId, built.perObs);
    return built.candidate;
  });

  // ---- 排除坏帧：自动识别残差离群帧，但必须与刚体在公共有效点集上比较 ----
  const rigidBest = rigidGrid.solutions[0];
  let excludeCandidates: AlignmentCandidate[] = [];
  if (rigidBest) {
    const beforeEval = evaluateSolution(allFrames, obs, rigidBest, manualExcluded, false);
    const frameMeans = [...beforeEval.perFrame.entries()].map(([fid, s]) => ({ fid, mean: s.mean }));
    const median = [...frameMeans.map((m) => m.mean)].sort((a, b) => a - b)[Math.floor(frameMeans.length / 2)] ?? 0;
    const badIds = new Set<Uid>([
      ...manualExcluded,
      ...frameMeans.filter((m) => m.mean > median * 2.5 + 0.8).map((m) => m.fid),
    ]);
    if (badIds.size > manualExcluded.size) {
      const exGrid = gridSearch(allFrames, obs, { localWarp: false, excluded: badIds }, [0.8, 1.6]);
      excludeCandidates = exGrid.solutions.slice(0, 1).flatMap((sol) => {
        const evaluated = evaluateSolution(allFrames, obs, sol, badIds, false);
        const kept = allFrames.filter((f) => !badIds.has(f.frameId));
        const dropped = allFrames.filter((f) => badIds.has(f.frameId));
        const diags: Diagnostic[] = [];
        const highTiltDropped = dropped.filter(
          (f) => Math.abs(f.tiltDeg) >= 55,
        );
        if (highTiltDropped.length > 0) {
          diags.push({
            code: 'FEWER_FRAMES_TRICK_REJECTED',
            severity: 'warning',
            message: `删帧方案丢掉了 ${highTiltDropped.length} 个 |τ|≥55° 高倾角帧；不允许用少帧换低残差，须在公共有效点集上比较`,
          });
        } else {
          diags.push({
            code: 'BAD_FRAME_EXCLUSION_RECORDED',
            severity: 'info',
            message: `自动识别并排除 ${dropped.length} 个离群帧；公平指标取公共有效点集 RMS`,
          });
        }
        const built = toCandidate(sol, input, 'exclude-bad-frames', `排除坏帧（${dropped.length} 帧）`, kept, evaluated, undefined, diags);
        perObsById.set(built.candidate.candidateId, built.perObs);
        return [built.candidate];
      });
    }
  }

  const candidates = [...rigidCandidates, ...warpCandidates, ...excludeCandidates];
  const perObsByCandidate = new Map(candidates.map((c) => [c.candidateId, perObsById.get(c.candidateId)!]));
  assignCommonSetRms(candidates, perObsByCandidate);

  const basis: JudgmentBasis[] = [
    {
      code: 'AXIS_NOT_CENTERED',
      message: '倾转轴穿过点显式估计；不默认固定在图像中心',
      evidence: {
        imageCenter: {
          x: allFrames[0]?.width ? allFrames[0].width / 2 : null,
          y: allFrames[0]?.height ? allFrames[0].height / 2 : null,
        },
      },
    },
    {
      code: 'TRACKS_MAY_BREAK_OR_SWAP',
      message: 'fiducial 轨迹允许断裂与身份交换；交换通过 identityResolution 产生独立候选',
    },
    {
      code: 'FAIR_COMMON_POINT_SET',
      message: '不同候选只按公共有效点集上的 rmsOnCommonSet 比较',
    },
    {
      code: 'NO_FEWER_FRAMES_TRICK',
      message: '排除坏帧后若高倾角信息覆盖下降，标记 FEWER_FRAMES_TRICK_REJECTED',
    },
  ];
  if (rigidGrid.equivalentGroups.length > 1) {
    basis.push({
      code: 'AMBIGUITY_ALL_CANDIDATES_KEPT',
      message: `无法唯一决定时保留全部 ${rigidGrid.equivalentGroups.length} 个合法候选`,
    });
  }
  void canonicalJson;
  return { candidates, basis };
}

/**
 * 公共有效点集：所有候选 effectivePointSet 的交集。
 * 用该交集重算每个候选的 RMS，写回 rmsOnCommonSet。
 */
function assignCommonSetRms(
  candidates: AlignmentCandidate[],
  perObsByCandidate: Map<string, Map<string, number>>,
): void {
  if (candidates.length === 0) return;
  const sets = candidates.map(
    (c) => new Set(c.effectivePointSet.map((p) => `${p.trackId}|${p.frameId}`)),
  );
  const common = [...sets[0]!].filter((k) => sets.every((s) => s.has(k)));
  if (common.length === 0) {
    for (const c of candidates) {
      c.diagnostics.push({
        code: 'NO_COMMON_POINT_SET',
        severity: 'error',
        message: '候选之间没有公共有效点，无法公平比较；拒绝排序',
      });
    }
    return;
  }
  const commonKeySet = new Set(common);
  for (const cand of candidates) {
    const perObs = perObsByCandidate.get(cand.candidateId);
    if (!perObs) continue;
    const vals = [...commonKeySet].map((k) => perObs.get(k)).filter((v): v is number => Number.isFinite(v));
    if (vals.length > 0) {
      cand.rmsOnCommonSet = scalarQuantity(rms(vals));
    }
    cand.diagnostics.push({
      code: 'FAIR_COMMON_POINT_SET',
      severity: 'info',
      message: `公共有效点集含 ${common.length} 个点，公平 RMS 基于该集合`,
    });
  }
}
