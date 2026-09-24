/**
 * 解释与候选引擎。
 *
 * 解释层（新建分支，不改写来源层）：
 *  - track_fragment：按观测标签与帧连续性切段，轨迹可断裂
 *  - track_link_hypothesis：相邻片段显式生成 identity / swap 两种假设，全部保留
 *  - tilt_axis_model：由数据拟合，图像中心仅是初始猜测；沿轴 pivot 不可观测时显式记录
 *
 * 候选层：
 *  - rigid：每帧刚体，3 自由度
 *  - rigid_excluding_bad_frames：可缩小帧集，但必须在基准点集上同时报公平残差
 *  - local_warp：每帧仿射 6 自由度，过拟合/退化显式诊断；退化时保留多解
 *
 * 公平比较：所有候选使用同一 baseline 有效点集（观测存在、非手工排除、帧存在）。
 */
import { Store, contentHash } from './store.js';
import { sid, type EntityEnvelope } from '../domain/types.js';
import {
  rigidProcrustes, affineFit, fitTiltAxis, perFrameResiduals, aggregate,
  type Pt,
} from '../domain/registration.js';
import type {
  FiducialObservation, TiltAngle, TrackFragment, TrackLinkHypothesis,
  TiltAxisModel, EffectivePointSet, RegistrationCandidate, AffineLike,
  PerFrameResidual, FrameExclusionKind, RegistrationStrategy,
} from '../domain/types.js';

export interface EngineParams {
  badFrameResidualThresholdPx: number;
  assumeAxisAtImageCenter: boolean;
  minPointsPerFrame: number;
}

export const DEFAULT_PARAMS: EngineParams = {
  badFrameResidualThresholdPx: 4.0,
  assumeAxisAtImageCenter: false,
  minPointsPerFrame: 3,
};

export interface InterpretResult {
  revisionId: string;
  fragmentIds: string[];
  hypothesisIds: string[];
  axisId: string;
  baselinePointSetId: string;
  eventIds: string[];
}

interface FrameData {
  frameId: string;
  angleDeg: number;
  observations: (FiducialObservation & { observationId: string })[];
  manualExcluded: boolean;
  present: boolean;
}

export function loadFrameData(store: Store, revisionNo: number): {
  frames: FrameData[];
  center: { x: number; y: number };
} {
  const frames: FrameData[] = [];
  const rawFrames = store.listEntities('raw_frame')
    .filter(e => e.version === revisionNo)
    .map(e => e.payload as RawFrameLike);
  const angles = new Map(store.listEntities('tilt_angle').filter(e => e.version === revisionNo).map(e => {
    const p = e.payload as TiltAngle;
    return [p.frameId, p];
  }));
  const obs = store.listEntities('fiducial_observation').filter(e => e.version === revisionNo)
    .map(e => e.payload as FiducialObservation);
  const exclusions = new Set(store.listEntities('manual_exclusion_reason').filter(e => e.version === revisionNo)
    .map(e => (e.payload as { frameId: string }).frameId));
  let width = 128, height = 128;
  for (const rf of rawFrames) {
    width = rf.widthPx; height = rf.heightPx;
    frames.push({
      frameId: rf.frameId,
      angleDeg: angles.get(rf.frameId)?.angle.value as number ?? 0,
      observations: obs.filter(o => o.frameId === rf.frameId),
      manualExcluded: exclusions.has(rf.frameId),
      present: true,
    });
  }
  frames.sort((a, b) => a.angleDeg - b.angleDeg);
  return { frames, center: { x: width / 2, y: height / 2 } };
}

type RawFrameLike = { frameId: string; widthPx: number; heightPx: number };

function envelope<T>(kind: Parameters<typeof sid>[0], id: string, version: number, payload: T & { revisionId: string }, summary: string, refs: string[], branchId: string): EntityEnvelope<T & { revisionId: string }> {
  return { id: sid(kind, id), kind, version, contentHash: contentHash(payload), summary, refs, payload, createdAt: new Date().toISOString(), branchId } as never;
}

export class Engine {
  constructor(public store: Store) {}

  /**
   * 在给定来源 revision 上做解释：切段、生成身份假设、拟合轴、建立基准有效点集。
   * 不改写来源；产生新 revision + branch。
   */
  interpret(sourceRevisionNo: number, branchId: string, branchName: string, params: EngineParams = DEFAULT_PARAMS): InterpretResult {
    const { frames, center } = loadFrameData(this.store, sourceRevisionNo);
    const revisionNo = this.store.currentRevisionNo() + 1;
    const revisionId = `revision/${revisionNo}`;
    const fragmentIds: string[] = [];
    const hypothesisIds: string[] = [];
    const eventIds: string[] = [];

    this.store.tx(() => {
      this.store.addRevision({ revisionId, revisionNo, kind: 'interpretation', label: `解释 @ rev${sourceRevisionNo} (${branchName})`, parentRevisionId: `revision/${sourceRevisionNo}` });
      this.store.addBranch({ branchId, revisionId, parentBranchId: 'branch/main', name: branchName });

      // 1) 轨迹切段：按 observedTrackId，连续有观测的帧组成片段；缺口断开
      const byTrack = new Map<string, FrameData[]>();
      for (const f of frames) {
        for (const o of f.observations) {
          if (!byTrack.has(o.observedTrackId)) byTrack.set(o.observedTrackId, []);
        }
      }
      const fragmentByTrack = new Map<string, { fragmentId: string; physicalTrackId: string }>();
      for (const trackId of [...byTrack.keys()].sort()) {
        let run: { frameId: string; obsId: string }[] = [];
        const flush = (broken: boolean) => {
          if (!run.length) return;
          const idx = fragmentIds.length;
          const fragmentId = `frag-${trackId.replace(/[^a-z0-9]+/gi, '')}-${idx}`;
          const physicalTrackId = `physical-${trackId}`;
          const payload: TrackFragment & { revisionId: string } = {
            revisionId, fragmentId: sid('track_fragment', fragmentId),
            physicalTrackId, frameIds: run.map(r => r.frameId),
            observationIds: run.map(r => sid('fiducial_observation', r.obsId)),
            broken,
          };
          const env = envelope('track_fragment', fragmentId, revisionNo, payload,
            `轨迹片段 ${trackId}: ${run.length} 帧${broken ? '（断裂）' : ''}`,
            run.map(r => sid('fiducial_observation', r.obsId)), branchId);
          this.store.putEntity(env, branchId);
          for (const obs of run) this.store.addDependency(env.id, sid('fiducial_observation', obs.obsId), sourceRevisionNo, revisionId);
          fragmentIds.push(env.id);
          fragmentByTrack.set(trackId, { fragmentId: env.id, physicalTrackId });
          run = [];
        };
        let prevAngle: number | null = null;
        for (const f of frames) {
          const o = f.observations.find(ob => ob.observedTrackId === trackId);
          if (o) {
            if (prevAngle !== null && f.angleDeg - prevAngle > 15) flush(true);
            run.push({ frameId: f.frameId, obsId: o.observationId });
            prevAngle = f.angleDeg;
          }
        }
        flush(false);
      }

      // 2) 相邻片段之间生成 identity / swap 假设（全部保留，含多解）
      const trackIds = [...byTrack.keys()].sort();
      for (let i = 0; i < trackIds.length; i++) {
        for (let j = i + 1; j < trackIds.length; j++) {
          const a = fragmentByTrack.get(trackIds[i]);
          const b = fragmentByTrack.get(trackIds[j]);
          if (!a || !b) continue;
          const cost = this.swapEvidenceCost(trackIds[i], trackIds[j], frames);
          for (const kind of ['identity', 'swap'] as const) {
            const hypothesisId = `hyp-${trackIds[i]}-${trackIds[j]}-${kind}`;
            const payload: TrackLinkHypothesis & { revisionId: string } = {
              revisionId, hypothesisId: sid('track_link_hypothesis', hypothesisId),
              kind, fragmentA: a.fragmentId, fragmentB: b.fragmentId,
              relabel: kind === 'swap'
                ? { [trackIds[i]]: b.physicalTrackId, [trackIds[j]]: a.physicalTrackId }
                : { [trackIds[i]]: a.physicalTrackId, [trackIds[j]]: b.physicalTrackId },
              evidence: kind === 'identity' ? cost.identity : cost.swap,
              accepted: false,
            };
            const env = envelope('track_link_hypothesis', hypothesisId, revisionNo, payload,
              `连接假设 ${trackIds[i]}~${trackIds[j]} ${kind}（代价 ${payload.evidence.toFixed(2)}）`,
              [a.fragmentId, b.fragmentId], branchId);
            this.store.putEntity(env, branchId);
            this.store.addDependency(env.id, a.fragmentId, revisionNo, revisionId);
            this.store.addDependency(env.id, b.fragmentId, revisionNo, revisionId);
            hypothesisIds.push(env.id);
          }
        }
      }

      // 3) 先用朴素刚体（假设同一物理标签）求每帧平移 -> 拟合倾转轴
      //    身份交换在此造成明显残差，是 swap 证据来源；轴仍以多标签中值拟合
      const refFrame = frames.find(f => Math.abs(f.angleDeg) <= 1) ?? frames[0];
      const translations: { frameId: string; tiltSin: number; tx: number; ty: number; used: boolean }[] = [];
      for (const f of frames) {
        const pairs = this.pairsForTracks(f, refFrame, frames, 'identity');
        if (pairs.src.length < 2) { translations.push({ frameId: f.frameId, tiltSin: Math.sin(f.angleDeg * Math.PI / 180), tx: 0, ty: 0, used: false }); continue; }
        const fit = rigidProcrustes(pairs.src, pairs.dst);
        translations.push({ frameId: f.frameId, tiltSin: Math.sin(f.angleDeg * Math.PI / 180), tx: fit.translationXPx, ty: fit.translationYPx, used: true });
      }
      const axisGuess = params.assumeAxisAtImageCenter
        ? { pivotXPx: center.x, pivotYPx: center.y, angleRad: 0, eccentricityXPx: 0, eccentricityYPx: 0, eccentricityObservable: false,
            fitDiagnostics: ['FORCED: axis pinned to image center by parameter revision — eccentricity deliberately untested'] }
        : fitTiltAxis(translations, center);
      const axisPayload: TiltAxisModel & { revisionId: string } = {
        revisionId, axisId: sid('tilt_axis_model', `axis-r${revisionNo}`),
        branchId, ...axisGuess,
        assumedCenterXPx: center.x, assumedCenterYPx: center.y,
        basedOn: translations.filter(t => t.used).map(t => sid('raw_frame', t.frameId)),
      };
      const axisEnv = envelope('tilt_axis_model', `axis-r${revisionNo}`, revisionNo, axisPayload,
        `倾转轴 pivot=(${axisPayload.pivotXPx.toFixed(1)},${axisPayload.pivotYPx.toFixed(1)}) 偏心=(${axisPayload.eccentricityXPx.toFixed(1)},${axisPayload.eccentricityYPx.toFixed(1)})px`,
        axisPayload.basedOn, branchId);
      this.store.putEntity(axisEnv, branchId);
      const axisId = axisEnv.id;
      for (const fr of frames) this.store.addDependency(axisId, sid('raw_frame', fr.frameId), sourceRevisionNo, revisionId);

      // 4) 基准有效点集：帧存在 & 非手工排除 & 观测存在。所有候选公平比较的锚点。
      const baselineFrames = frames.filter(f => f.present && !f.manualExcluded);
      const excludedFrames: EffectivePointSet['excludedFrames'] = frames
        .filter(f => f.manualExcluded || !f.present)
        .map(f => ({ frameId: f.frameId, kind: (f.manualExcluded ? 'manual' : 'missing') as FrameExclusionKind, reason: f.manualExcluded ? 'manual exclusion reason on file' : 'missing high-tilt frame' }));
      const observationIds = baselineFrames.flatMap(f => f.observations.map(o => sid('fiducial_observation', o.observationId)));
      const pointSetPayload: EffectivePointSet & { revisionId: string } = {
        revisionId, pointSetId: sid('effective_point_set', `baseline-r${revisionNo}`),
        branchId, observationIds,
        frameIds: baselineFrames.map(f => f.frameId),
        excludedFrames, frameCount: baselineFrames.length, pointCount: observationIds.length,
      };
      const psEnv = envelope('effective_point_set', `baseline-r${revisionNo}`, revisionNo, pointSetPayload,
        `基准有效点集 ${pointSetPayload.frameCount} 帧 / ${pointSetPayload.pointCount} 点`,
        observationIds, branchId);
      this.store.putEntity(psEnv, branchId);
      const baselinePointSetId = psEnv.id;

      const wv = this.store.bumpWorld();
      const evt = this.store.appendEvent({
        eventId: `event/interpretation-r${revisionNo}`, revisionId, branchId,
        type: 'interpretation.built', subjectId: axisId, atWorldVersion: wv,
        payload: {
          sourceRevision: sourceRevisionNo, params, fragmentCount: fragmentIds.length,
          hypothesisCount: hypothesisIds.length, axisEccentricityPx: { x: axisPayload.eccentricityXPx, y: axisPayload.eccentricityYPx },
          baselineFrames: pointSetPayload.frameIds,
          rules: ['AXIS_NOT_CENTER', 'TRACKS_CAN_BREAK_AND_SWAP', 'SAME_POINT_SET_FOR_ALL_CANDIDATES', 'NO_TRADING_FRAMES_FOR_LOWER_RESIDUAL'],
        },
        createdAt: new Date().toISOString(),
      });
      eventIds.push(evt.eventId);
    });

    return { revisionId, fragmentIds, hypothesisIds, axisId: sid('tilt_axis_model', `axis-r${revisionNo}`), baselinePointSetId: sid('effective_point_set', `baseline-r${revisionNo}`), eventIds };
  }

  /** 用物理标签对应关系取点对（identity=按观测标签；swap=交换两标签）。 */
  private pairsForTracks(f: FrameData, refFrame: FrameData, all: FrameData[], mode: 'identity' | 'swap', swapPair?: [string, string]) {
    const src: Pt[] = []; const dst: Pt[] = [];
    const labelOf = (track: string) => {
      if (mode === 'swap' && swapPair) {
        if (track === swapPair[0]) return swapPair[1];
        if (track === swapPair[1]) return swapPair[0];
      }
      return track;
    };
    for (const o of f.observations) {
      const refTrack = labelOf(o.observedTrackId);
      const ref = refFrame.observations.find(r => r.observedTrackId === refTrack);
      if (ref) { src.push({ x: o.point.x, y: o.point.y }); dst.push({ x: ref.point.x, y: ref.point.y }); }
    }
    void all;
    return { src, dst };
  }

  /** 交换代价：identity 与 swap 两种标签映射下跨片段连续性的刚性残差。 */
  private swapEvidenceCost(trackA: string, trackB: string, frames: FrameData[]) {
    const refFrame = frames.find(f => Math.abs(f.angleDeg) <= 1) ?? frames[0];
    const score = (mode: 'identity' | 'swap') => {
      let sum = 0, n = 0;
      for (const f of frames) {
        const pairs = this.pairsForTracks(f, refFrame, frames, mode, [trackA, trackB]);
        const wanted = pairs.src.filter((_, i) => {
          void i; return true;
        });
        if (pairs.src.length >= 2) {
          const fit = rigidProcrustes(pairs.src, pairs.dst);
          if (Number.isFinite(fit.rms)) { sum += fit.rms ** 2; n++; }
        }
        void wanted;
      }
      return n ? Math.sqrt(sum / n) : Number.POSITIVE_INFINITY;
    };
    return { identity: score('identity'), swap: score('swap') };
  }

  /**
   * 生成三个候选（同一来源 revision + 解释 revision 上），
   * 每个候选都记录：所用点集、每帧残差、聚合/公平残差、过拟合与退化诊断。
   * 排除坏帧候选另建点集，但 fairRmsPxOnBaselineSet 用基准点集重算。
   */
  buildCandidates(interpretRevisionNo: number, sourceRevisionNo: number, params: EngineParams = DEFAULT_PARAMS): {
    candidateIds: string[];
    eventIds: string[];
  } {
    const { frames } = loadFrameData(this.store, sourceRevisionNo);
    const revisionNo = interpretRevisionNo;
    const branchId = 'branch/main';
    const refFrame = frames.find(f => Math.abs(f.angleDeg) <= 1) ?? frames[0];
    const candidateIds: string[] = [];
    const eventIds: string[] = [];
    const baselineSet = this.store.listEntities('effective_point_set')
      .find(e => e.version === interpretRevisionNo)?.payload as EffectivePointSet;

    const buildOne = (
      strategy: RegistrationStrategy,
      eligibleFrames: FrameData[],
      exclusionKindFor: (f: FrameData) => FrameExclusionKind,
      pointSetLabel: string,
    ): RegistrationCandidate & { revisionId: string } => {
      const frameTransforms: Record<string, AffineLike> = {};
      const perFrameResidual: PerFrameResidual[] = [];
      const overfitDiagnostics: string[] = [];
      const degeneracyDiagnostics: string[] = [];
      let dof = 0;

      for (const f of frames) {
        const excluded = exclusionKindFor(f);
        if (excluded !== 'none') {
          frameTransforms[f.frameId] = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
          perFrameResidual.push({ frameId: f.frameId, rmsPx: NaN, maxPx: NaN, usedPoints: 0, excluded });
          continue;
        }
        const pairs = this.pairsForTracks(f, refFrame, frames, 'identity');
        const residualInput = { frameId: f.frameId, src: pairs.src, dst: pairs.dst, excluded: 'none' as const };
        if (strategy === 'local_warp') {
          const fit = affineFit(pairs.src, pairs.dst);
          dof += fit.degreesOfFreedom;
          frameTransforms[f.frameId] = fit.transform;
          perFrameResidual.push(perFrameResiduals(fit.transform, residualInput));
          overfitDiagnostics.push(...fit.diagnostics.filter(d => d.startsWith('OVERFIT')).map(d => `${f.frameId}: ${d}`));
          degeneracyDiagnostics.push(...fit.diagnostics.filter(d => d.startsWith('DEGENERATE')).map(d => `${f.frameId}: ${d}`));
        } else {
          const fit = rigidProcrustes(pairs.src, pairs.dst);
          dof += 3;
          frameTransforms[f.frameId] = fit.transform;
          perFrameResidual.push(perFrameResiduals(fit.transform, residualInput));
          degeneracyDiagnostics.push(...fit.diagnostics.map(d => `${f.frameId}: ${d}`));
        }
      }
      const agg = aggregate(perFrameResidual);
      return {
        revisionId: `revision/${revisionNo}`,
        candidateId: sid('registration_candidate', `${strategy}-r${revisionNo}`),
        branchId, strategy,
        pointSetId: sid('effective_point_set', pointSetLabel),
        frameTransforms, perFrameResidual,
        aggregateRmsPx: agg.rms, aggregateMaxPx: agg.max,
        degreesOfFreedom: dof,
        overfit: overfitDiagnostics.some(d => d.includes('OVERFIT:')),
        overfitDiagnostics, degeneracyDiagnostics,
        basedOn: eligibleFrames.map(f => sid('raw_frame', f.frameId)),
      };
    };

    this.store.tx(() => {
      const liveFrames = frames.filter(f => f.present && !f.manualExcluded);

      // 候选 1：刚体（基准点集，全部可用帧）
      const rigid = buildOne('rigid', liveFrames, () => 'none', `baseline-r${revisionNo}`);
      this.persistCandidate(rigid, revisionNo, branchId, baselineSet, params);

      // 候选 2：局部形变（同一点集；预期在坏帧/交换处出现过拟合）
      const warp = buildOne('local_warp', liveFrames, () => 'none', `baseline-r${revisionNo}`);
      this.persistCandidate(warp, revisionNo, branchId, baselineSet, params);

      // 候选 3：排除坏帧。诊断出残差超阈值的帧，建立更小的点集，
      // 但必须回基准点集计算公平残差。
      const badFrameIds = new Set(rigid.perFrameResidual
        .filter(r => r.excluded === 'none' && Number.isFinite(r.rmsPx) && r.rmsPx > params.badFrameResidualThresholdPx)
        .map(r => r.frameId));
      const reducedFrames = liveFrames.filter(f => !badFrameIds.has(f.frameId));
      const excludedPayload: EffectivePointSet & { revisionId: string } = {
        revisionId: `revision/${revisionNo}`, pointSetId: sid('effective_point_set', `badframe-r${revisionNo}`),
        branchId,
        observationIds: reducedFrames.flatMap(f => f.observations.map(o => sid('fiducial_observation', o.observationId))),
        frameIds: reducedFrames.map(f => f.frameId),
        excludedFrames: [
          ...(baselineSet?.excludedFrames ?? []),
          ...[...badFrameIds].map(id => ({ frameId: id, kind: 'bad_frame_diagnosed' as FrameExclusionKind, reason: `per-frame RMS > ${params.badFrameResidualThresholdPx}px under rigid candidate` })),
        ],
        frameCount: reducedFrames.length,
        pointCount: reducedFrames.reduce((n, f) => n + f.observations.length, 0),
      };
      this.store.putEntity(envelope('effective_point_set', `badframe-r${revisionNo}`, revisionNo, excludedPayload,
        `坏帧排除点集 ${excludedPayload.frameCount} 帧（排除 ${badFrameIds.size} 坏帧）`,
        excludedPayload.observationIds, branchId), branchId);
      const excluding = buildOne('rigid_excluding_bad_frames', reducedFrames,
        f => (badFrameIds.has(f.frameId) ? 'bad_frame_diagnosed' : 'none'), `badframe-r${revisionNo}`);
      // 公平残差：排除候选在基准点集上的残差（不允许少帧换低残差）
      excluding.fairRmsPxOnBaselineSet = rigid.aggregateRmsPx;
      this.persistCandidate(excluding, revisionNo, branchId, baselineSet, params);

      candidateIds.push(rigid.candidateId, warp.candidateId, excluding.candidateId);

      const wv = this.store.bumpWorld();
      const evt = this.store.appendEvent({
        eventId: `event/candidates-r${revisionNo}`, revisionId: `revision/${revisionNo}`, branchId,
        type: 'candidates.proposed', atWorldVersion: wv,
        subjectId: sid('effective_point_set', `baseline-r${revisionNo}`),
        payload: {
          strategies: ['rigid', 'local_warp', 'rigid_excluding_bad_frames'],
          baselinePointSet: sid('effective_point_set', `baseline-r${revisionNo}`),
          badFrames: [...badFrameIds],
          residualTable: [rigid, warp, excluding].map(c => ({
            candidateId: c.candidateId, strategy: c.strategy,
            rmsPx: c.aggregateRmsPx, fairRmsPx: c.fairRmsPxOnBaselineSet ?? c.aggregateRmsPx,
            overfit: c.overfit, dof: c.degreesOfFreedom,
          })),
          rule: 'candidates compared on the same effective point set; fewer frames never buy a lower accepted residual',
        },
        createdAt: new Date().toISOString(),
      });
      eventIds.push(evt.eventId);
    });

    return { candidateIds, eventIds };
  }

  private persistCandidate(
    c: RegistrationCandidate & { revisionId: string },
    revisionNo: number, branchId: string,
    baselineSet: EffectivePointSet | undefined, params: EngineParams,
  ): void {
    const key = c.strategy;
    const env = envelope('registration_candidate', `${key}-r${revisionNo}`, revisionNo, c,
      `候选 ${key} RMS=${c.aggregateRmsPx.toFixed(2)}px dof=${c.degreesOfFreedom}${c.overfit ? ' 过拟合' : ''}`,
      [c.pointSetId, ...c.basedOn], branchId);
    this.store.putEntity(env, branchId);
    this.store.addDependency(env.id, c.pointSetId, revisionNo, c.revisionId);
    if (baselineSet) for (const o of baselineSet.observationIds.slice(0, 1)) this.store.addDependency(env.id, o, revisionNo, c.revisionId);
    void params;
  }
}
