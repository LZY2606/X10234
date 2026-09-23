import type { RuleJudgementContent, TiltAxisRuleContent, TrackSegmentContent } from '../core/types.ts';
import { ArchiveEngine, VersionConflict } from '../engine/archive.ts';
import type { GeneratedSeries } from './generator.ts';
import type { CasePack, ProbeSpec } from './manifest.ts';

export interface ProbeRun {
  probeId: string;
  code: string;
  archiveId: string;
  candidateIds: string[];
  judgementCodes: string[];
  conflictSeen: boolean;
}

export interface Dossier {
  dossierId: string;
  main: ArchiveEngine;
  probeArchives: Map<string, ArchiveEngine>;
  probeRuns: ProbeRun[];
  pack: CasePack;
}

function defaultSegments(series: GeneratedSeries, swapHandled: boolean): TrackSegmentContent[] {
  return series.markers.map(({ markerId }) => {
    const observationIds = series.observations.filter((o) => o.markerId === markerId)
      .map((o) => o.observationId);
    const gapIds = series.gaps.filter((g) => g.markerId === markerId).map((g) => g.gapId);
    const swappedPair = series.truth.swappedMarkerPair;
    const isSwapped = swapHandled && swappedPair !== null
      && (markerId === swappedPair[0] || markerId === swappedPair[1]);
    const [a, b] = swappedPair ?? ['', ''];
    return {
      segmentId: `seg_${markerId}`,
      markerId,
      observationIds,
      gapIds,
      swappedFromMarkerId: isSwapped ? (markerId === a ? b : a) : undefined
    };
  });
}

function primaryAxis(fixedAtImageCenter: boolean, offset: number | null): TiltAxisRuleContent {
  return {
    axisId: 'axis_primary',
    fixedAtImageCenter,
    phiRad: 0,
    centerOffsetXPx: fixedAtImageCenter ? 0 : offset,
    centerOffsetYPx: 0,
    imageCenterXPx: 512,
    imageCenterYPx: 512,
    source: fixedAtImageCenter ? 'default_assumed_center' : 'estimated'
  };
}

function importSeries(engine: ArchiveEngine, series: GeneratedSeries, batchId: string,
                      summary: string, author: string, probeId?: string): void {
  engine.importSource({
    frames: series.frames, tilts: series.tilts, scales: series.scales,
    doses: series.doses, markers: series.markers, observations: series.observations,
    gaps: series.gaps, exclusions: series.exclusions
  }, { batchId, kind: 'initial', summary }, author, probeId);
}

function addSegmentsAndExclusions(engine: ArchiveEngine, series: GeneratedSeries,
                                  swapHandled: boolean, author: string, probeId?: string): void {
  for (const segment of defaultSegments(series, swapHandled)) {
    engine.reviseSegment(segment, 'tracking segments; gaps explicit', author, 'main', probeId);
  }
  for (const exclusion of series.exclusions) {
    engine.changeFrameExclusion(exclusion.exclusionId, true, exclusion.reasonText,
      author, 'main', probeId);
  }
}

export function loadCasePack(pack: CasePack): Dossier {
  const dossierId = pack.manifest.packId;
  const mainId = dossierId.replace('tc_pack_', 'arc_main_');
  const main = new ArchiveEngine(mainId);
  const baseline = pack.fragments[pack.manifest.baseline.fragmentId]?.series as GeneratedSeries;

  main.create('microscopy_team');
  importSeries(main, baseline, 'batch_initial_v1', pack.manifest.baseline.description, 'microscopy_team');

  // 默认（待挑战）轴线规则：固定图像中心
  main.reviseAxis(primaryAxis(true, null),
    'initial default: tilt axis assumed fixed at image center', 'microscopy_team');
  addSegmentsAndExclusions(main, baseline, false, 'microscopy_team');
  main.computeAndRecordCandidates('microscopy_team');

  // 参数修订：轴线自由（失效范围仅限候选）
  main.reviseAxis(primaryAxis(false, baseline.truth.axisCenterOffsetXPx),
    'parameter revision: free axis, center offset estimated', 'reviewer_lead');
  // 轨迹身份交换的显式重连
  for (const segment of defaultSegments(baseline, true)) {
    if (segment.swappedFromMarkerId) {
      main.reviseSegment(segment,
        `identity swap resolved: observations remapped from ${segment.swappedFromMarkerId}`,
        'reviewer_lead');
    }
  }
  main.computeAndRecordCandidates('reviewer_lead');

  // 局部源数据改动：仅 frm_0012 剂量，几何候选不失效
  const badDose = baseline.doses.find((d) => !d.dose.convertible);
  if (badDose) {
    main.reviseSource('dose', `dose_${badDose.frameId}`,
      { frameId: badDose.frameId, dose: {
        ...badDose.dose, raw: '1.91', rawUnit: 'electron_per_nm2',
        value: 1.91, unit: 'electron_per_nm2', convertible: true, diagnostic: undefined
      } },
      'local source change: dosimeter dropout re-read from logbook; geometry unaffected',
      [], 'facility_operator');
  }

  // 第二分支：轴线偏心与轨迹断裂/交换的专门复核
  main.createBranch('review_axis_tracks', 'main',
    'second branch: axis not center by default; tracks may break and swap');
  main.computeAndRecordCandidates('reviewer_lead', 'review_axis_tracks');

  // 主分支人工接受
  main.adjudicate({
    candidateId: 'cnd_rigid_free',
    decision: 'accepted',
    reason: 'free-axis rigid wins on common effective point set with full frame coverage',
    author: 'reviewer_lead', branch: 'main', expectedHeadSeq: main.headSeq
  });

  // 互相冲突的人工决定：第二窗口以旧 headSeq 提交 → 409，重放中冻结冲突与双方差异
  let conflictSeen = false;
  try {
    main.adjudicate({
      candidateId: 'cnd_local_warp',
      decision: 'accepted',
      reason: 'second window: accepts local warp using stale view',
      author: 'reviewer_window2', branch: 'review_axis_tracks',
      expectedHeadSeq: main.headSeq - 1
    });
  } catch (err) {
    if (!(err instanceof VersionConflict)) throw err;
    conflictSeen = true;
  }
  // 刷新后第二窗口在自己的分支保存成功（裁定独立保留）
  main.adjudicate({
    candidateId: 'cnd_rigid_center',
    decision: 'rejected',
    reason: 'conflict resolved: fixed-center candidate rejected, diff retained in history',
    author: 'reviewer_window2', branch: 'review_axis_tracks',
    expectedHeadSeq: main.headSeq
  });
  main.recordJudgement({
    judgementId: 'jud_concurrent_freeze_main',
    code: 'CONCURRENT_FREEZE',
    subject: 'adjudication',
    holds: true,
    evidence: {
      staleSubmitRejected: conflictSeen,
      branches: ['main', 'review_axis_tracks'],
      note: 'later submitter saw version conflict and both-side diff'
    },
    relatedCandidateIds: ['cnd_rigid_free', 'cnd_local_warp', 'cnd_rigid_center']
  }, 'concurrent adjudication freeze captured during replay', 'reviewer_window2');

  // 主档案锁定一版配准供重建引用
  main.lockRegistration('cnd_rigid_free', main.headSeq, 'reviewer_lead', 'main');

  const probeArchives = new Map<string, ArchiveEngine>();
  const probeRuns: ProbeRun[] = [{
    probeId: 'probe_combined',
    code: 'axis_offset',
    archiveId: mainId,
    candidateIds: ['cnd_rigid_center', 'cnd_rigid_free', 'cnd_rigid_free_badframes', 'cnd_local_warp'],
    judgementCodes: [
      'AXIS_NOT_CENTER_DEFAULT', 'TRACK_CAN_BREAK_AND_SWAP', 'COMMON_EFFECTIVE_POINT_SET',
      'NO_FEWER_FRAMES_LOWER_RESIDUAL', 'LOCAL_WARP_OVERFIT', 'BAD_FRAME_EXCLUSION',
      'CONCURRENT_FREEZE'
    ],
    conflictSeen
  }];

  for (const probe of pack.manifest.probes.filter((p) => p.fragmentRole === 'minimal')) {
    probeRuns.push(runMinimalProbe(probe, pack, probeArchives));
  }

  return { dossierId, main, probeArchives, probeRuns, pack };
}

function runMinimalProbe(probe: ProbeSpec, pack: CasePack,
                         archives: Map<string, ArchiveEngine>): ProbeRun {
  const fragment = pack.fragments[probe.fragmentId];
  if (!fragment) throw new Error(`missing fragment ${probe.fragmentId}`);
  const series = fragment.series;
  const archiveId = `arc_${probe.probeId}`;
  const engine = new ArchiveEngine(archiveId);
  engine.create('reviewer_lead');
  importSeries(engine, series, `batch_${probe.probeId}`, probe.title, 'reviewer_lead', probe.probeId);

  const useFreeAxis = probe.code !== 'multi_solution';
  engine.reviseAxis(primaryAxis(!useFreeAxis, useFreeAxis ? series.truth.axisCenterOffsetXPx : null),
    `probe ${probe.code} axis`, 'reviewer_lead', 'main', probe.probeId);
  addSegmentsAndExclusions(engine, series, probe.code === 'track_identity_swap',
    'reviewer_lead', probe.probeId);

  engine.openProbe(probe.probeId, probe.code, 'reviewer_lead');
  const { result } = engine.computeAndRecordCandidates('reviewer_lead', 'main', probe.probeId);
  const codes = result.judgements.map((j) => j.code);

  let conflictSeen = false;
  if (probe.code === 'multi_solution' && result.candidates[1]?.ambiguity.nonUnique) {
    // 保留全部合法候选并显式选择，之后才能锁版
    const free = result.candidates[1]!;
    engine.resolveAmbiguitySet(free.candidateId,
      free.ambiguity.equivalentCandidateIds.length > 0
        ? free.ambiguity.equivalentCandidateIds : [free.candidateId, 'cnd_rigid_free_reparameterized'],
      'non-unique: all legal candidates retained, manual choice recorded',
      'reviewer_lead', 'main', probe.probeId);
  }
  if (probe.code === 'concurrent_freeze') {
    try {
      engine.adjudicate({
        candidateId: 'cnd_rigid_free', decision: 'accepted',
        reason: 'window A', author: 'window_a', branch: 'main',
        expectedHeadSeq: engine.headSeq
      });
      engine.adjudicate({
        candidateId: 'cnd_rigid_center', decision: 'accepted',
        reason: 'window B stale', author: 'window_b', branch: 'main',
        expectedHeadSeq: engine.headSeq - 1
      });
    } catch (err) {
      if (!(err instanceof VersionConflict)) throw err;
      conflictSeen = true;
    }
    engine.recordJudgement({
      judgementId: 'jud_concurrent_freeze',
      code: 'CONCURRENT_FREEZE',
      subject: 'adjudication',
      holds: true,
      evidence: { staleSubmitRejected: true },
      relatedCandidateIds: ['cnd_rigid_free', 'cnd_rigid_center']
    }, 'two-window concurrent freeze', 'window_b', 'main', probe.probeId);
  }
  engine.closeProbe(probe.probeId, 'reviewer_lead');

  archives.set(probe.probeId, engine);
  return {
    probeId: probe.probeId,
    code: probe.code,
    archiveId,
    candidateIds: result.candidates.map((c) => c.candidateId),
    judgementCodes: [...new Set(codes)],
    conflictSeen
  };
}
