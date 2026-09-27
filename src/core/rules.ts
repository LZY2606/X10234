import { axisEccentricity, type RegistrationCandidate, type TrackSegment } from './domain.js';
import type { EffectivePointSet } from './domain.js';
import type { AlignmentFrame } from '../alg/registration.js';
import type { FitSolution } from '../alg/registration.js';
import type { RuleFinding, ScenarioCode } from './events.js';
import { RULE_VERSION } from './engine.js';

export const AXIS_ECCENTRICITY_MIN_PX = 3;
export const SWAP_GAIN_MIN_PX = 0.6;
export const WARP_IMPROVEMENT_MIN_RATIO = 0.1;

export function axisFinding(axis: RegistrationCandidate['tiltAxis']): RuleFinding {
  const ecc = axisEccentricity(axis);
  return {
    code: 'AXIS_NOT_CENTERED',
    severity: ecc > AXIS_ECCENTRICITY_MIN_PX ? 'warning' : 'info',
    message: `倾转轴经过点偏离图像中心 ${ecc.toFixed(2)} px：轴不得默认固定在中心`,
    evidence: {
      axisCenter: axis.axisCenter,
      frameCenter: axis.frameCenter,
      eccentricityPx: ecc,
    },
    affects: [{ entity: 'tilt-axis', version: 0, scope: 'local' }],
  };
}

export function trackFindings(segments: TrackSegment[], swappedPair: [string, string] | null, gainPx: number): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const gaps = segments.filter((s) => s.joinToNext.kind === 'gap');
  if (gaps.length) {
    findings.push({
      code: 'TRACK_GAP_PRESERVED',
      severity: 'info',
      message: `${gaps.map((g) => g.trackId).join(', ')} 存在跟踪缺口：轨迹可以断裂，不插值补齐`,
      evidence: { trackIds: gaps.map((g) => g.trackId) },
      affects: gaps.map((g) => ({ entity: `track/${g.trackId}`, version: 0, scope: 'local' as const })),
    });
  }
  const swapped = segments.filter((s) => s.joinToNext.kind === 'swapped');
  if (swapped.length || swappedPair) {
    findings.push({
      code: 'TRACK_SWAP_DETECTED',
      severity: 'warning',
      message: `检出 fiducial 身份交换（${(swappedPair ?? swapped.map((s) => s.trackId)).join(' ↔ ')}，残差增益 ${gainPx.toFixed(2)} px）：交换需显式重拟合，不静默改号`,
      evidence: { swappedPair, declared: swapped.map((s) => ({ trackId: s.trackId, join: s.joinToNext })), gainPx },
      affects: [{ entity: 'tracks/identity', version: 0, scope: 'local' }],
    });
  }
  return findings;
}

export function missingHighTiltFinding(missingFrameIndices: number[], anglesDeg: number[]): RuleFinding | null {
  if (!missingFrameIndices.length) return null;
  return {
    code: 'MISSING_HIGH_TILT_FRAME',
    severity: 'warning',
    message: `高倾角帧缺失：${missingFrameIndices.map((i) => `${anglesDeg[i]}°(#${i})`).join(', ')}；少帧候选只能在公共有效点集上比较`,
    evidence: { missingFrameIndices, anglesDeg: missingFrameIndices.map((i) => anglesDeg[i]) },
    affects: missingFrameIndices.map((i) => ({ entity: `frame/${i}`, version: 0, scope: 'local' as const })),
  };
}

export function badFrameFinding(excluded: number[], residuals: FitSolution['perObsResidual']): RuleFinding | null {
  if (!excluded.length) return null;
  const worst = excluded.map((fi) => ({
    frameIndex: fi,
    rmsPx: Math.sqrt(
      residuals.filter((r) => r.frameIndex === fi).reduce((s, r) => s + r.r * r.r, 0) /
        Math.max(1, residuals.filter((r) => r.frameIndex === fi).length),
    ),
  }));
  return {
    code: 'BAD_FRAME_EXCLUDED',
    severity: 'info',
    message: `坏帧经人工原因排除：${excluded.join(', ')}；排除不允许作为降低残差的默认手段`,
    evidence: { excluded, worst },
    affects: excluded.map((i) => ({ entity: `frame/${i}`, version: 0, scope: 'local' as const })),
  };
}

export function overfitFinding(input: { improvementRatio: number; maxQuadratic: number }): RuleFinding {
  return {
    code: 'LOCAL_WARP_OVERFIT',
    severity: 'warning',
    message: `局部形变改进 ${(input.improvementRatio * 100).toFixed(1)}%、最大二次项 ${input.maxQuadratic.toExponential(2)}：疑似过拟合，刚体优先`,
    evidence: input,
    affects: [{ entity: 'candidate/local-warp', version: 0, scope: 'local' }],
  };
}

export function ambiguityFinding(solutions: unknown[]): RuleFinding {
  return {
    code: 'AMBIGUOUS_MULTI_SOLUTION',
    severity: 'warning',
    message: `存在 ${solutions.length} 个参数距离显著、残差相当的合法解：无法唯一决定，全部保留待人工裁定`,
    evidence: { solutionCount: solutions.length },
    affects: [{ entity: 'candidate/set', version: 0, scope: 'global' }],
  };
}

export function unfairFewerFramesFinding(commonPointSet: EffectivePointSet): RuleFinding {
  return {
    code: 'UNFAIR_FEWER_FRAMES',
    severity: 'error',
    message: '检测到用少帧换低残差的比较：候选必须在相同有效点集上重算 RMS',
    evidence: { commonPointSet: commonPointSet.description, keyCount: commonPointSet.keys.length },
    affects: [{ entity: 'candidate/set', version: 0, scope: 'global' }],
  };
}

export { RULE_VERSION };
export type { ScenarioCode };
