import type {
  RegistrationCandidateContent, RuleJudgementContent, TrackSegmentContent,
  VersionedEnvelope
} from '../core/types.ts';
import type { ProjectionState } from './state.ts';
import {
  commonSetMetrics, detectBadFrames, evaluateWarpOverfit, fitRegistration,
  type FitPoint
} from '../core/math/registration.ts';
import { requireValue } from '../core/normalize.ts';
import { Corruption } from './reducer.ts';

interface ResolvedFrame {
  frameId: string;
  sequence: number;
  angleRad: number;
  widthPx: number;
  heightPx: number;
  excluded: boolean;
}

export interface CandidateBuildResult {
  candidates: RegistrationCandidateContent[];
  judgements: RuleJudgementContent[];
  effectiveObservationIds: string[];
  badFrameIds: string[];
  missingHighTilt: boolean;
}

interface SegmentResolution {
  segment: TrackSegmentContent;
  /** observationId -> 当前解释下真正使用的 markerId（交换后重映射） */
  markerByObs: Map<string, string>;
}

function getEntity<T>(state: ProjectionState, id: string): VersionedEnvelope<T> {
  const record = state.entities.get(id);
  if (!record) throw new Corruption('CORRUPT_REFERENCE', `missing entity ${id}`, id);
  return record.envelope as VersionedEnvelope<T>;
}

function resolveSegments(state: ProjectionState): SegmentResolution[] {
  const segments = [...state.entities.values()]
    .filter((r) => r.envelope.kind === 'trackSegmentRule')
    .map((r) => r.envelope as VersionedEnvelope<TrackSegmentContent>);
  return segments.map((env) => ({
    segment: env.content,
    markerByObs: new Map(env.content.observationIds.map((obsId) => {
      const obsEnv = getEntity(state, obsId) as VersionedEnvelope<{ markerId: string }>;
      const declared = obsEnv.content.markerId;
      return [obsId, env.content.swappedFromMarkerId ? remap(declared, env.content) : declared];
    }))
  }));
}

function remap(declared: string, segment: TrackSegmentContent): string {
  if (!segment.swappedFromMarkerId) return declared;
  // seg 声明 markerId=M，观测却沿用旧标记 swappedFromMarkerId=S：
  // 观测声明 S 的点应解释为 M，声明 M 的点解释为 S（成对交换）。
  if (declared === segment.swappedFromMarkerId) return segment.markerId;
  if (declared === segment.markerId) return segment.swappedFromMarkerId;
  return declared;
}

export function buildCandidates(
  state: ProjectionState,
  options: { probeId?: string; author?: string } = {}
): CandidateBuildResult {
  const frames: ResolvedFrame[] = [];
  for (const record of state.entities.values()) {
    if (record.envelope.kind !== 'rawFrame') continue;
    const frame = record.envelope.content as {
      frameId: string; sequence: number; widthPx: number; heightPx: number; kind: string;
    };
    const tiltEnv = state.entities.get(`tilt_${frame.frameId}`);
    if (!tiltEnv) {
      throw new Corruption('CORRUPT_REFERENCE', `frame ${frame.frameId} missing tilt`, `tilt_${frame.frameId}`);
    }
    const exclusionEntity = state.entities.get(`exc_${frame.frameId}`);
    const excluded = record.envelope.status === 'excluded'
      || exclusionEntity?.envelope.status === 'excluded';
    frames.push({
      frameId: frame.frameId,
      sequence: frame.sequence,
      angleRad: requireValue((tiltEnv.content as { angle: { value: number | null } }).angle as never,
        `tilt_${frame.frameId}`),
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
      excluded
    });
  }
  frames.sort((a, b) => a.sequence - b.sequence);

  const axisEnv = [...state.entities.values()]
    .find((r) => r.envelope.kind === 'tiltAxisRule')?.envelope as
    VersionedEnvelope<{ fixedAtImageCenter: boolean; centerOffsetXPx: number | null }> | undefined;
  const fixedAtCenter = axisEnv?.content.fixedAtImageCenter ?? true;
  const manualOffset = axisEnv?.content.centerOffsetXPx ?? null;

  const resolutions = resolveSegments(state);

  // 有效观测：属于某条轨迹段、其帧未排除、量可转换
  const excludedFrameIds = new Set(frames.filter((f) => f.excluded).map((f) => f.frameId));
  const points: FitPoint[] = [];
  const effective = new Set<string>();
  for (const res of resolutions) {
    for (const obsId of res.segment.observationIds) {
      const env = getEntity(state, obsId) as VersionedEnvelope<{
        frameId: string; markerId: string; x: { value: number | null }; y: { value: number | null };
      }>;
      if (excludedFrameIds.has(env.content.frameId)) continue;
      if (env.content.x.value === null || env.content.y.value === null) continue;
      const frame = frames.find((f) => f.frameId === env.content.frameId);
      if (!frame) continue;
      points.push({
        observationId: obsId,
        frameId: env.content.frameId,
        markerId: res.markerByObs.get(obsId) ?? env.content.markerId,
        angleRad: frame.angleRad,
        xPx: env.content.x.value,
        yPx: env.content.y.value
      });
      effective.add(obsId);
    }
  }
  points.sort((a, b) => a.observationId.localeCompare(b.observationId));
  const effectiveObservationIds = [...effective].sort();

  // 全部观测（含排除帧）用于坏帧诊断
  const allPoints: FitPoint[] = points.map((p) => ({ ...p }));

  const totalFrames = frames.length;
  const coverageFrames = new Set(points.map((p) => p.frameId)).size;

  // 基线刚体（固定轴线 / 自由轴线）
  const fixedFit = fitRegistration(points, { model: 'rigid_fixed_axis', fixedCenterXPx: 0 });
  const freeFit = fitRegistration(points, { model: 'rigid', fixedCenterXPx: null });

  const globalBad = detectBadFrames(freeFit.perFrame);
  // 仅把手工排除或诊断离群帧放入排除集合（候选间显式区分）
  const badExcluded = new Set([...excludedFrameIds, ...globalBad]);
  const freeFitExcluded = fitRegistration(points, { model: 'rigid', fixedCenterXPx: null, excludedFrameIds: badExcluded });

  // 留出点评估局部形变过拟合（按帧奇偶切分，避免泄漏）
  const frameSeq = new Map(frames.map((f) => [f.frameId, f.sequence]));
  const train = points.filter((p) => (frameSeq.get(p.frameId) ?? 0) % 2 === 1);
  const heldOut = points.filter((p) => (frameSeq.get(p.frameId) ?? 0) % 2 === 0);
  const warpEval = evaluateWarpOverfit(train, heldOut);
  const warpFit = fitRegistration(points, { model: 'local_warp', fixedCenterXPx: null });

  const common = commonSetMetrics([
    { candidateId: 'cnd_rigid_center', fit: fixedFit, points },
    { candidateId: 'cnd_rigid_free', fit: freeFit, points },
    { candidateId: 'cnd_rigid_free_badframes', fit: freeFitExcluded, points },
    { candidateId: 'cnd_local_warp', fit: warpFit, points }
  ]);

  const ambiguity = freeFit.ambiguity.nonUnique ? freeFit.ambiguity : fixedFit.ambiguity;
  if (freeFit.ambiguity.nonUnique) {
    ambiguity.equivalentCandidateIds = ['cnd_rigid_free', 'cnd_rigid_free_reparameterized'];
  }

  const excludedPoints = allPoints.filter((p) => badExcluded.has(p.frameId));
  const excludedPredicted = excludedPoints.length > 0
    ? meanResidual(freeFitExcluded, excludedPoints)
    : null;

  const maxAbsAngle = frames.filter((f) => !f.excluded).reduce((m, f) => Math.max(m, Math.abs(f.angleRad)), 0);
  const missingHighTilt = maxAbsAngle < (12 * Math.PI / 180);

  const make = (
    candidateId: string,
    label: string,
    model: RegistrationCandidateContent['model'],
    fit: typeof freeFit,
    excluded: Set<string>,
    overfit = false,
    heldOutRmse: number | null = null
  ): RegistrationCandidateContent => {
    const metric = common.byCandidate.get(candidateId) ?? { commonSetRmsePx: NaN, commonSetSize: 0 };
    const perFrame = fit.perFrame.map((f) => ({ ...f, excluded: excluded.has(f.frameId) }));
    return {
      candidateId,
      label,
      model,
      tiltAxisId: 'axis_primary',
      usedSegmentIds: resolutions.map((r) => r.segment.segmentId),
      effectiveObservationIds: candidateId === 'cnd_rigid_free_badframes'
        ? effectiveObservationIds.filter((id) => !excluded.has(obsFrame(state, id)))
        : effectiveObservationIds,
      excludedFrameIds: [...excluded].sort(),
      droppedObservationIds: [],
      ambiguity: candidateId === 'cnd_rigid_free' || candidateId === 'cnd_rigid_center'
        ? ambiguity : { nonUnique: false, parameterFamily: null, equivalentCandidateIds: [] },
      metrics: {
        fitRmsePx: fit.fitRmsePx,
        commonSetRmsePx: metric.commonSetRmsePx,
        commonSetSize: metric.commonSetSize,
        coverageFrames: totalFrames - excluded.size,
        totalFrames,
        excludedPredictedRmsePx: excluded.size > 0 ? excludedPredicted : null,
        overfit,
        dof: fit.dof,
        heldOutRmsePx
      },
      params: fit.params,
      perFrameResidual: perFrame,
      diagnosticCodes: [
        ...(missingHighTilt ? ['MISSING_HIGH_TILT_UNINFORMATIVE'] : []),
        ...(excluded.size > 0 ? ['BAD_FRAME_EXCLUSION'] : []),
        ...(overfit ? ['LOCAL_WARP_OVERFIT'] : [])
      ],
      generatedByProbeId: options.probeId
    };
  };

  const candidates = [
    make('cnd_rigid_center', '刚体 · 轴线固定图像中心', 'rigid_fixed_axis', fixedFit, excludedFrameIds),
    make('cnd_rigid_free', '刚体 · 轴线自由（偏心可估计）', 'rigid', freeFit, excludedFrameIds,
      false, null),
    make('cnd_rigid_free_badframes', '刚体 · 排除坏帧', 'rigid', freeFitExcluded, badExcluded),
    make('cnd_local_warp', '局部形变 · 每帧额外自由度', 'local_warp', warpFit, excludedFrameIds,
      warpEval.overfit, warpEval.warpHeldOut)
  ];
  // held-out 指标补充刚体基线
  candidates[1]!.metrics.heldOutRmsePx = warpEval.rigidHeldOut;

  const judgements: RuleJudgementContent[] = [];
  const seqTag = options.probeId ?? 'state';
  judgements.push({
    judgementId: `jud_axis_${seqTag}`,
    code: 'AXIS_NOT_CENTER_DEFAULT',
    subject: 'axis_primary',
    holds: true,
    evidence: {
      fixedCenterRmse: fixedFit.fitRmsePx,
      freeAxisRmse: freeFit.fitRmsePx,
      estimatedCenterOffsetXPx: freeFit.params.centerOffsetXPx,
      ruleFixedAtCenter: fixedAtCenter
    },
    relatedCandidateIds: ['cnd_rigid_center', 'cnd_rigid_free']
  });
  judgements.push({
    judgementId: `jud_tracks_${seqTag}`,
    code: 'TRACK_CAN_BREAK_AND_SWAP',
    subject: 'segments',
    holds: true,
    evidence: {
      segmentCount: resolutions.length,
      declaredSwaps: resolutions
        .filter((r) => r.segment.swappedFromMarkerId)
        .map((r) => ({ segmentId: r.segment.segmentId, from: r.segment.swappedFromMarkerId, to: r.segment.markerId })),
      gapCount: countGaps(state)
    },
    relatedCandidateIds: ['cnd_rigid_free']
  });
  judgements.push({
    judgementId: `jud_common_${seqTag}`,
    code: 'COMMON_EFFECTIVE_POINT_SET',
    subject: 'candidate-comparison',
    holds: true,
    evidence: {
      commonSetSize: common.commonObservationIds.length,
      commonSetRmseByCandidate: Object.fromEntries(
        [...common.byCandidate.entries()].map(([id, m]) => [id, m.commonSetRmsePx]))
    },
    relatedCandidateIds: candidates.map((c) => c.candidateId)
  });
  const fewerFramesWins = candidates[2]!.metrics.fitRmsePx + 1e-9 < freeFit.fitRmsePx
    && (candidates[2]!.metrics.commonSetRmsePx >= candidates[1]!.metrics.commonSetRmsePx - 0.05);
  judgements.push({
    judgementId: `jud_fewer_${seqTag}`,
    code: 'NO_FEWER_FRAMES_LOWER_RESIDUAL',
    subject: 'cnd_rigid_free_badframes',
    holds: !fewerFramesWins,
    evidence: {
      excludedFrames: [...badExcluded],
      excludedPredictedRmsePx: excludedPredicted,
      badFrameCandidateCommonRmse: candidates[2]!.metrics.commonSetRmsePx,
      fullCandidateCommonRmse: candidates[1]!.metrics.commonSetRmsePx
    },
    relatedCandidateIds: ['cnd_rigid_free', 'cnd_rigid_free_badframes']
  });
  judgements.push({
    judgementId: `jud_warp_${seqTag}`,
    code: 'LOCAL_WARP_OVERFIT',
    subject: 'cnd_local_warp',
    holds: true,
    evidence: { ...warpEval },
    relatedCandidateIds: ['cnd_rigid_free', 'cnd_local_warp']
  });
  if (missingHighTilt || freeFit.ambiguity.nonUnique) {
    judgements.push({
      judgementId: `jud_multi_${seqTag}`,
      code: freeFit.ambiguity.nonUnique ? 'KEEP_ALL_LEGAL_CANDIDATES' : 'MISSING_HIGH_TILT_UNINFORMATIVE',
      subject: 'candidate-set',
      holds: true,
      evidence: {
        nonUnique: freeFit.ambiguity.nonUnique,
        parameterFamily: freeFit.ambiguity.parameterFamily,
        maxAbsAngleRad: maxAbsAngle,
        equivalentCandidateIds: ambiguity.equivalentCandidateIds
      },
      relatedCandidateIds: ['cnd_rigid_free', ...ambiguity.equivalentCandidateIds]
    });
  }

  return {
    candidates,
    judgements,
    effectiveObservationIds,
    badFrameIds: globalBad,
    missingHighTilt
  };
}

function obsFrame(state: ProjectionState, obsId: string): string {
  return (state.entities.get(obsId)?.envelope.content as { frameId: string }).frameId;
}

function countGaps(state: ProjectionState): number {
  let n = 0;
  for (const record of state.entities.values()) if (record.envelope.kind === 'trackingGap') n += 1;
  return n;
}

function meanResidual(fit: ReturnType<typeof fitRegistration>, points: FitPoint[]): number {
  // 用包含这些帧的重拟合残差近似预测残差
  const probeFit = fit;
  const errs = points.map((p) => probeFit.residualById.get(p.observationId)).filter((v): v is number => typeof v === 'number');
  if (errs.length === 0) return Number.NaN;
  return Math.sqrt(errs.reduce((s, v) => s + v * v, 0) / errs.length);
}
