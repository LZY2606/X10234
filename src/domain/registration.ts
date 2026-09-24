import { stableId } from './ids';
import { solve, rigidResidual, type Obs, type AxisParams } from './geometry';
import type { ID, EffectivePointSet, RegistrationCandidate } from './types';

export interface MarkerTrackInfo {
  markerId: ID;
  segments: Array<{ fromFrameSeq: number; toFrameSeq: number }>;
  possibleIdentities: ID[];
}

export interface BuildInput {
  branchId: ID;
  tiltSeriesId: ID;
  widthPx: number;
  heightPx: number;
  anglesDeg: Record<number, number>;
  observations: Obs[];
  /** 候选 swap 身份对（由轨迹解释提供） */
  ambiguousPairs: Array<[ID, ID]>;
  /** 跟踪缺口（缺失帧提示） */
  gaps: Array<{ markerId: ID; fromFrameSeq: number; toFrameSeq: number }>;
  /** 手工排除帧（坏帧），仅用于 excluded-frames 候选 */
  manualExcludedFrameSeqs: number[];
  createdAtIso: string;
}

export interface Diagnostic {
  diagnosticId: ID;
  code: 'axis-offset' | 'identity-swap' | 'missing-high-tilt' | 'bad-frame-exclusion' |
        'local-overfit' | 'ambiguous' | 'multi-solution';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  data: Record<string, unknown>;
}

export interface BuildOutput {
  pointSet: EffectivePointSet;
  axis: { orientationDeg: number; interceptXPx: number };
  candidates: RegistrationCandidate[];
  diagnostics: Diagnostic[];
}

const OVERFIT_DOF_RATIO = 0.5;
const AMBIGUITY_REL_GAP = 0.02;
const BAD_FRAME_RMS_RATIO = 2.5;

export function buildCandidates(input: BuildInput): BuildOutput {
  const { branchId, widthPx } = input;
  const diagnostics: Diagnostic[] = [];

  // 公共有效点集：排除“坏帧”后的 (marker,frame) 对。所有候选都在它上面公平比较。
  const excluded = [...new Set(input.manualExcludedFrameSeqs)].sort((a, b) => a - b);
  const keepFrames = [...new Set(input.observations.map((o) => o.frameSeq))]
    .filter((s) => !excluded.includes(s)).sort((a, b) => a - b);
  const pairsAll = input.observations;
  const pairsCommon = pairsAll.filter((o) => !excluded.includes(o.frameSeq));
  const pointSetId = stableId('pset', branchId,
    pairsCommon.map((p) => `${p.markerId}@${p.frameSeq}`).sort().join('|'),
    excluded.join(','));
  const pointSet: EffectivePointSet = {
    pointSetId, branchId,
    pairs: pairsCommon.map((p) => ({ markerId: p.markerId, frameSeq: p.frameSeq })),
    frameSeqs: keepFrames,
    excludedFrameSeqs: excluded
  };

  // 高倾角缺失诊断：基于观测到的倾角覆盖
  const presentAngles = keepFrames.map((s) => input.anglesDeg[s]).filter((v) => v !== undefined);
  const maxAbs = presentAngles.length ? Math.max(...presentAngles.map(Math.abs)) : 0;
  if (maxAbs < 55) {
    diagnostics.push({
      diagnosticId: stableId('diag', branchId, 'missing-high-tilt', maxAbs.toFixed(1)),
      code: 'missing-high-tilt', severity: 'warning',
      message: `缺少高倾角帧（最大|t|=${maxAbs.toFixed(1)}°），轴线外推不确定；不得据此把轴默认到中心`,
      data: { maxAbsTiltDeg: maxAbs, presentFrameSeqs: keepFrames }
    });
  }

  // 刚体基准（所有观测，用于发现坏帧；并提供轴线）
  const rigidAll = solve(pairsAll, input.anglesDeg, widthPx, { warp: false });
  // 刚体在公共点集上（公平指标）
  const rigidCommon = solve(pairsCommon, input.anglesDeg, widthPx,
    { warp: false, axisGuess: rigidAll.axis });
  const axis = rigidAll.axis;

  // 轴线偏心诊断：截距显著偏离中心即说明“不能默认中心”
  const centerX = widthPx / 2;
  const offsetPx = axis.interceptXPx - centerX;
  if (Math.abs(offsetPx) > widthPx * 0.05) {
    diagnostics.push({
      diagnosticId: stableId('diag', branchId, 'axis-offset', axis.interceptXPx.toFixed(2)),
      code: 'axis-offset', severity: 'info',
      message: `拟合轴线截距=${axis.interceptXPx.toFixed(1)}px，偏离图像中心 ${offsetPx.toFixed(1)}px；禁止中心默认`,
      data: { interceptXPx: axis.interceptXPx, centerXPx: centerX, offsetPx, orientationDeg: axis.orientationDeg }
    });
  }

  // 坏帧检测：刚体逐帧残差显著高于中位数
  const frameRms = Object.entries(rigidAll.residualsByFrame).map(([s, v]) => ({ seq: Number(s), v }));
  const sortedVals = frameRms.map((f) => f.v).sort((a, b) => a - b);
  const medianV = sortedVals[Math.floor(sortedVals.length / 2)] || 1e-9;
  const detectedBad = frameRms.filter((f) => f.v > medianV * BAD_FRAME_RMS_RATIO).map((f) => f.seq).sort((a, b) => a - b);
  if (detectedBad.length) {
    diagnostics.push({
      diagnosticId: stableId('diag', branchId, 'bad-frame', detectedBad.join(',')),
      code: 'bad-frame-exclusion', severity: 'warning',
      message: `刚体逐帧残差检测到疑似坏帧：${detectedBad.join(',')}（> ${BAD_FRAME_RMS_RATIO}×中位数）`,
      data: { detectedBadFrameSeqs: detectedBad, residualsByFrame: rigidAll.residualsByFrame,
              manualExcludedFrameSeqs: excluded }
    });
  }

  const createdAtIso = input.createdAtIso;
  const candidates: RegistrationCandidate[] = [];
  const mk = (kind: RegistrationCandidate['kind'], params: RegistrationCandidate['params'],
             res: ReturnType<typeof rigidResidual> | typeof rigidCommon,
             extra: Partial<RegistrationCandidate> = {}): RegistrationCandidate => {
    const candidateId = stableId('cand', branchId, kind, pointSetId,
      kind === 'local-warp' ? 'warp' : (params.excludedFrameSeqs ?? []).join('-'));
    return {
      candidateId, branchId, pointSetId, kind, params,
      residualsByFrame: res.residualsByFrame,
      rmsResidualPx: res.rms, maxResidualPx: res.maxResidual,
      effectivePairCount: res.pairCount,
      overfit: false, status: 'proposed', provenanceEventIds: [], createdAtIso, ...extra
    };
  };

  // 候选 1：刚体（公共点集）
  const rigidCand = mk('rigid', {
    kind: 'rigid', axis: { orientationDeg: axis.orientationDeg, interceptXPx: axis.interceptXPx },
    degreesOfFreedom: rigidCommon.degreesOfFreedom
  }, rigidCommon);

  // 候选 2：排除坏帧（公平残差：排除后仍在“同一公共点集”上评估，而非用更少帧取胜）
  const usedExclusions = excluded.length ? excluded : detectedBad;
  const exclCommonRes = rigidResidual(pairsCommon, input.anglesDeg, axis, keepFrames);
  // 被排除帧自身的残差也记录，供审阅页说明“为何排除”，但不进入公平 RMS
  const exclBadRes = rigidResidual(pairsAll, input.anglesDeg, axis,
    [...new Set([...keepFrames, ...usedExclusions])]);
  const excludedCand = mk('excluded-frames', {
    kind: 'excluded-frames',
    axis: { orientationDeg: axis.orientationDeg, interceptXPx: axis.interceptXPx },
    excludedFrameSeqs: usedExclusions, degreesOfFreedom: exclCommonRes.pairCount > 0 ? 2 * keepFrames.length + 2 : 0
  }, exclCommonRes, {
    residualsByFrame: { ...exclCommonRes.residualsByFrame,
      ...Object.fromEntries(usedExclusions.map((s) => [s, exclBadRes.residualsByFrame[s] ?? 0])) }
  });
  // 明确标注：候选并未因少帧而获得更低的公平 RMS
  (excludedCand as RegistrationCandidate & { coverageNote?: string }).coverageNote =
    `公平 RMS 仅统计公共点集 ${pairsCommon.length} 对；被排除帧 ${usedExclusions.join(',')} 单独展示，不用少帧换低残差`;

  // 候选 3：局部形变（公共点集）+ 过拟合判定
  const warp = solve(pairsCommon, input.anglesDeg, widthPx, { warp: true, axisGuess: axis });
  const dofRatio = warp.degreesOfFreedom / Math.max(1, pairsCommon.length * 2);
  const gain = rigidCommon.rms > 1e-9 ? (rigidCommon.rms - warp.rms) / rigidCommon.rms : 0;
  const overfit = dofRatio >= OVERFIT_DOF_RATIO || (warp.rms < rigidCommon.rms && gain < 0.05);
  const warpCand = mk('local-warp', {
    kind: 'local-warp',
    axis: { orientationDeg: axis.orientationDeg, interceptXPx: axis.interceptXPx },
    perFrameAffine: warp.perFrameAffine, degreesOfFreedom: warp.degreesOfFreedom
  }, warp, {
    overfit,
    overfitDiagnostic: overfit
      ? `局部仿射自由度 ${warp.degreesOfFreedom} / 有效观测 ${pairsCommon.length * 2}（比 ${dofRatio.toFixed(2)}），刚体->局部 RMS 增益仅 ${(gain * 100).toFixed(1)}%，判为过拟合`
      : undefined
  });
  if (overfit) {
    diagnostics.push({
      diagnosticId: stableId('diag', branchId, 'local-overfit'),
      code: 'local-overfit', severity: 'warning',
      message: warpCand.overfitDiagnostic!,
      data: { dof: warp.degreesOfFreedom, observations: pairsCommon.length * 2,
              dofRatio, rigidRms: rigidCommon.rms, warpRms: warp.rms, gain }
    });
  }

  candidates.push(rigidCand, excludedCand, warpCand);

  // 多解：身份交换枚举。对每个候选交换对重拟合，残差接近即保留为合法候选。
  const ambiguous: RegistrationCandidate[] = [];
  for (const [m1, m2] of input.ambiguousPairs) {
    const swappedObs = pairsCommon.map((o) =>
      o.markerId === m1 ? { ...o, markerId: m2 } : o.markerId === m2 ? { ...o, markerId: m1 } : o);
    const s1 = solve(pairsCommon, input.anglesDeg, widthPx, { warp: false });
    const s2 = solve(swappedObs, input.anglesDeg, widthPx, { warp: false });
    const relGap = Math.abs(s1.rms - s2.rms) / Math.max(1e-9, (s1.rms + s2.rms) / 2);
    if (relGap <= AMBIGUITY_REL_GAP) {
      const swapId = stableId('cand', branchId, 'rigid-swap', pointSetId, `${m1}-${m2}`);
      const alt = mk('rigid', {
        kind: 'rigid',
        axis: { orientationDeg: s2.axis.orientationDeg, interceptXPx: s2.axis.interceptXPx },
        degreesOfFreedom: s2.degreesOfFreedom
      }, s2, { candidateId: swapId, ambiguousWith: [rigidCand.candidateId] });
      rigidCand.ambiguousWith = [...(rigidCand.ambiguousWith ?? []), alt.candidateId];
      ambiguous.push(alt);
      diagnostics.push({
        diagnosticId: stableId('diag', branchId, 'identity-swap', m1, m2),
        code: 'identity-swap', severity: 'critical',
        message: `fiducial ${m1} 与 ${m2} 轨迹断裂处可能身份交换；两种身份的残差差距仅 ${(relGap * 100).toFixed(1)}%，保留全部合法候选`,
        data: { markerA: m1, markerB: m2, rmsA: s1.rms, rmsB: s2.rms, relGap,
                keptCandidateIds: [rigidCand.candidateId, alt.candidateId] }
      });
    } else {
      diagnostics.push({
        diagnosticId: stableId('diag', branchId, 'ambiguous', m1, m2),
        code: 'ambiguous', severity: 'info',
        message: `${m1}/${m2} 候选身份交换可被残差区分（差距 ${(relGap * 100).toFixed(1)}%），仅保留更优解`,
        data: { markerA: m1, markerB: m2, relGap }
      });
    }
  }
  candidates.push(...ambiguous);

  return { pointSet, axis, candidates, diagnostics };
}
