import type {
  CandidateKind,
  Diagnostic,
  EffectivePointSet,
  RegistrationCandidate,
  SerializedAlignmentModel,
  TrackSegment,
  Uid,
} from '../core/domain.js';
import type { AlignmentFrame, FitOptions, FitSolution } from './registration.js';
import { fitAlignment, perFrameResiduals } from './registration.js';

export interface CandidateRequest {
  candidateId: Uid;
  branchId: Uid;
  kind: CandidateKind;
  ruleVersion: string;
  parentCandidateId: Uid | null;
  frames: AlignmentFrame[];
  segments: TrackSegment[];
  width: number;
  height: number;
  useWarp: boolean;
  excludedFrames?: Set<number>;
  identityMap?: Record<string, number>;
  seedZ?: number[];
  axisGuess?: FitOptions['axisGuess'];
  overfitThresholds?: { minImprovementRatio: number; maxWarpQuadratic: number };
}

export interface BuiltCandidate {
  candidate: RegistrationCandidate;
  solution: FitSolution;
  pointSet: EffectivePointSet;
  diagnostics: Diagnostic[];
}

export function pointSetOf(
  frames: AlignmentFrame[],
  segments: TrackSegment[],
  excluded: Set<number>,
): EffectivePointSet {
  const keys: string[] = [];
  const frameSet = new Set<number>();
  for (const frame of frames) {
    if (!frame.available || excluded.has(frame.frameIndex)) continue;
    for (const seg of segments) {
      if (seg.observations.some((o) => o.frameIndex === frame.frameIndex && o.normalized)) {
        keys.push(`${frame.frameIndex}:${seg.trackId}`);
        frameSet.add(frame.frameIndex);
      }
    }
  }
  keys.sort();
  return {
    keys,
    frameIndices: [...frameSet].sort((a, b) => a - b),
    description: `${frameSet.size} frames x ${segments.length} tracks, ${keys.length} observations`,
  };
}

function toModel(solution: FitSolution, trackIds: Uid[], useWarp: boolean): SerializedAlignmentModel {
  return {
    perFrame: solution.perFrame.map((pf) => ({
      frameIndex: pf.frameIndex,
      alongAxisShift: pf.vars.along,
      offAxisShift: pf.vars.off,
      inPlaneRotationDeg: (pf.vars.rot * 180) / Math.PI,
      warp: useWarp
        ? { quadraticAlong: pf.vars.warpQAlong, quadraticOff: pf.vars.warpQOff }
        : undefined,
    })),
    trackIdentity: Object.fromEntries(
      trackIds.map((id) => [id, `marker-${(solution.identityMap[id] ?? 0) + 1}`]),
    ),
  };
}

/** 枚举段两两身份交换并整体重拟合；返回显著降低残差的交换（fiducial 可断裂且可能身份交换）。 */
export function searchIdentitySwaps(
  base: FitSolution,
  common: Omit<CandidateRequest, 'candidateId' | 'branchId' | 'kind' | 'parentCandidateId'>,
  minGainPx = 0.5,
): { solution: FitSolution; map: Record<string, number>; swappedPair: [string, string] | null; gainPx: number } {
  const trackIds = common.segments.map((s) => s.trackId);
  let best: FitSolution = base;
  let bestMap = base.identityMap;
  let bestPair: [string, string] | null = null;
  let bestGain = 0;
  for (let i = 0; i < trackIds.length; i++) {
    for (let j = i + 1; j < trackIds.length; j++) {
      const trial: Record<string, number> = { ...base.identityMap };
      trial[trackIds[i]] = base.identityMap[trackIds[j]];
      trial[trackIds[j]] = base.identityMap[trackIds[i]];
      const sol = fitAlignment({
        width: common.width,
        height: common.height,
        frames: common.frames,
        segments: common.segments,
        useWarp: common.useWarp,
        identityMap: trial,
        excludedFrames: common.excludedFrames,
        axisGuess: common.axisGuess,
        maxIterations: 18,
      });
      const gain = base.overallRmsPx - sol.overallRmsPx;
      if (gain > bestGain) {
        best = sol;
        bestMap = trial;
        bestPair = [trackIds[i], trackIds[j]];
        bestGain = gain;
      }
    }
  }
  return {
    solution: bestGain > minGainPx ? best : base,
    map: bestGain > minGainPx ? bestMap : base.identityMap,
    swappedPair: bestGain > minGainPx ? bestPair : null,
    gainPx: bestGain,
  };
}

/** 迭代剔除最坏帧（残差 > 阈值），返回被排除帧集合；用于坏帧方案。 */
export function detectBadFrames(
  solution: FitSolution,
  relativeToMedian = 3,
): Set<number> {
  const byFrame = new Map<number, number[]>();
  for (const r of solution.perObsResidual) {
    const list = byFrame.get(r.frameIndex) ?? [];
    list.push(r.r);
    byFrame.set(r.frameIndex, list);
  }
  const rms = [...byFrame.entries()].map(([frame, arr]) => ({
    frame,
    rms: Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length),
  }));
  const sorted = rms.map((r) => r.rms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return new Set(rms.filter((r) => r.rms > median * relativeToMedian && r.rms > 2).map((r) => r.frame));
}

/** 多个 z 种子产生的不同合法解；参数距离足够大即视为不同解（多解时全部保留）。 */
export function fitMultiSolution(
  common: Omit<CandidateRequest, 'candidateId' | 'branchId' | 'kind' | 'parentCandidateId'>,
  seeds: number[][],
  distinctParamDistance = 4,
): FitSolution[] {
  const solutions: FitSolution[] = [];
  for (const seedZ of seeds) {
    const sol = fitAlignment({
      width: common.width,
      height: common.height,
      frames: common.frames,
      segments: common.segments,
      useWarp: common.useWarp,
      identityMap: common.identityMap,
      excludedFrames: common.excludedFrames,
      seedZ,
      axisGuess: common.axisGuess,
      maxIterations: 20,
    });
    const distinct = solutions.every((other) => {
      const dz = sol.markers.reduce(
        (sum, marker, i) => sum + (marker.z - other.markers[i].z) ** 2,
        0,
      );
      return Math.sqrt(dz / Math.max(1, sol.markers.length)) > distinctParamDistance;
    });
    if (distinct) solutions.push(sol);
  }
  return solutions;
}

/** 用候选模型在指定有效点集上重算 RMS（公平比较：同一有效点集，不用少帧换低残差）。 */
export function scoreOnPointSet(solution: FitSolution, pointSet: EffectivePointSet): number {
  const wanted = new Set(pointSet.keys);
  const used = solution.perObsResidual.filter((r) => wanted.has(`${r.frameIndex}:${r.trackId}`));
  if (!used.length) return Number.POSITIVE_INFINITY;
  return Math.sqrt(used.reduce((s, r) => s + r.r * r.r, 0) / used.length);
}

export function detectOverfit(
  warpSolution: FitSolution,
  rigidSolution: FitSolution,
  thresholds = { minImprovementRatio: 0.1, maxWarpQuadratic: 1e-3 },
): { overfit: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const improvement =
    (rigidSolution.overallRmsPx - warpSolution.overallRmsPx) / Math.max(rigidSolution.overallRmsPx, 1e-9);
  if (improvement < thresholds.minImprovementRatio) {
    reasons.push(`improvement ${(improvement * 100).toFixed(1)}% < ${thresholds.minImprovementRatio * 100}%`);
  }
  const maxQ = Math.max(
    ...warpSolution.perFrame.map((pf) => Math.max(Math.abs(pf.vars.warpQAlong), Math.abs(pf.vars.warpQOff))),
  );
  if (maxQ > thresholds.maxWarpQuadratic) {
    reasons.push(`max quadratic warp ${maxQ.toExponential(2)} > ${thresholds.maxWarpQuadratic.toExponential(2)}`);
  }
  return { overfit: reasons.length > 0, reasons };
}

export function buildCandidate(request: CandidateRequest, solution: FitSolution, diagnostics: Diagnostic[]): BuiltCandidate {
  const excluded = request.excludedFrames ?? new Set<number>();
  const pointSet = pointSetOf(request.frames, request.segments, excluded);
  const residuals = perFrameResiduals(solution, request.frames, excluded);
  const trackIds = request.segments.map((s) => s.trackId);
  const candidate: RegistrationCandidate = {
    candidateId: request.candidateId,
    kind: request.kind,
    branchId: request.branchId,
    parentCandidateId: request.parentCandidateId,
    ruleVersion: request.ruleVersion,
    pointSetDigest: '',
    excludedFrameIndices: [...excluded].sort((a, b) => a - b),
    tiltAxis: solution.axis,
    residuals,
    score: {
      overallRmsPx: solution.overallRmsPx,
      commonPointSetRmsPx: 0,
      degreesOfFreedom: solution.degreesOfFreedom,
      usedFrameCount: pointSet.frameIndices.length,
      overfitFlag: false,
      ambiguityFlag: false,
    },
    diagnostics,
    model: toModel(solution, trackIds, request.useWarp),
  };
  return { candidate, solution, pointSet, diagnostics };
}

export interface RankedCandidate {
  candidateId: Uid;
  commonRmsPx: number;
  overfitFlag: boolean;
  ambiguityFlag: boolean;
  rank: number;
}

/** 公平排序：全部候选在公共有效点集上重算 RMS；过拟合与多解候选降权，不用少帧换低残差。 */
export function rankCandidates(
  candidates: Array<{ candidateId: Uid; solution: FitSolution; overfitFlag: boolean; ambiguityFlag: boolean }>,
  commonPointSet: EffectivePointSet,
): RankedCandidate[] {
  const scored = candidates.map((c) => ({
    candidateId: c.candidateId,
    commonRmsPx: scoreOnPointSet(c.solution, commonPointSet),
    overfitFlag: c.overfitFlag,
    ambiguityFlag: c.ambiguityFlag,
    rank: 0,
  }));
  scored.sort((a, b) => {
    if (a.overfitFlag !== b.overfitFlag) return a.overfitFlag ? 1 : -1;
    return a.commonRmsPx - b.commonRmsPx;
  });
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}
