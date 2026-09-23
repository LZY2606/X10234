import { TiltService } from './service-read';
import {
  SCENARIO_CONFIGS,
  buildAxis,
  buildCandidates,
  buildTracks,
  type ScenarioConfig
} from '../domain/scenario-build';
import { compareCandidates } from '../domain/rules';
import { contentId } from '../domain/hash';
import type {
  EntityKind,
  RegistrationCandidate,
  ScenarioKey,
  TiltAxis,
  Track,
  VersionRef
} from '../domain/types';
import type { CaseMaterials } from '../domain/ingest';

export interface ScenarioBuildResult {
  branchId: string;
  headSeq: number;
  trackRefs: VersionRef[];
  axisRef: VersionRef;
  candidateRefs: VersionRef[];
  candidates: RegistrationCandidate[];
  violations: string[];
}

/**
 * 为一个反例情形构建独立解释分支。
 * 最小输入与组合输入共享基线来源内容（blob 只存一份），
 * 但解释版本、失败诊断、人工决定彼此独立。
 */
export function buildScenarioBranch(
  service: TiltService,
  mainBranchId: string,
  materials: CaseMaterials,
  key: ScenarioKey
): ScenarioBuildResult {
  const config = SCENARIO_CONFIGS[key];
  const branchId = `scenario_${key}`;
  const store = service.store;

  store.transaction(() => {
    if (store.branchExists(branchId)) return;
    store.createBranch(branchId, mainBranchId);
    let headSeq = 0;
    const appendExpected = <P extends object>(
      type: never,
      payload: P,
      author = 'scenario-builder'
    ) => {
      const result = store.append(
        branchId,
        type as never,
        payload as never,
        { expectedHeadSeq: headSeq, author }
      );
      headSeq = result.newHeadSeq;
      return result;
    };

    // 复制基线来源事件到分支历史（引用的是同一 contentId / blob，不复制字节）。
    const baselineEvents = store.events(mainBranchId);
    for (const event of baselineEvents) {
      if (
        event.type === 'entity_recorded' ||
        event.type === 'material_set_committed' ||
        event.type === 'rule_asserted'
      ) {
        const result = store.append(
          branchId,
          event.type,
          event.payload as never,
          {
            expectedHeadSeq: headSeq,
            author: event.author
          }
        );
        headSeq = result.newHeadSeq;
      }
    }

    appendExpected('scenario_boundary_recorded' as never, {
      boundary: {
        scenario: key,
        phase: config.key === 'combined' ? 'combined_input' : 'minimum_input',
        sharedBlobIds: materials.frames
          .filter((frame) => frame.blob)
          .map((frame) => `blob_${frame.blob!.sha256.slice(0, 32)}`),
        affectedRange: []
      }
    });

    appendExpected('case_annotation' as never, {
      scenario: key,
      title: config.title,
      narrative: config.note
    });

    // 来源实体引用表（entityId 与基线一致）。
    const state = service.state(branchId);
    const sourceRef = (entityId: string): VersionRef | undefined => {
      const version = state.headVersionByEntity.get(entityId);
      if (version === undefined) return undefined;
      const record = state.entities.get(entityId)?.get(version);
      return record
        ? {
            entityId,
            kind: record.kind as EntityKind,
            version,
            contentId: record.contentId
          }
        : undefined;
    };

    const { tracks, swapQuestion } = buildTracks(materials, config, sourceRef);
    const trackRefs: VersionRef[] = [];
    for (const track of tracks) {
      const cid = contentId('track', track);
      const recordResult = store.append(
        branchId,
        'entity_recorded',
        {
          entityId: `track_${track.trackId}`,
          kind: 'track',
          version: 1,
          contentId: cid,
          body: track,
          refs: track.basedOnRefs.concat(track.gapRefs)
        },
        { expectedHeadSeq: headSeq, author: 'scenario-builder' }
      );
      headSeq = recordResult.newHeadSeq;
      for (const ref of track.basedOnRefs.concat(track.gapRefs)) {
        store.addRef(cid, `track_${track.trackId}`, ref, recordResult.event.seq);
      }
      trackRefs.push({
        entityId: `track_${track.trackId}`,
        kind: 'track',
        version: 1,
        contentId: cid
      });
    }

    if (swapQuestion) {
      const cid = contentId('identity_swap_question', swapQuestion);
      const result = store.append(
        branchId,
        'entity_recorded',
        {
          entityId: `swap_${swapQuestion.swapId}`,
          kind: 'identity_swap_question',
          version: 1,
          contentId: cid,
          body: swapQuestion,
          refs: swapQuestion.basedOnRefs
        },
        { expectedHeadSeq: headSeq, author: 'scenario-builder' }
      );
      headSeq = result.newHeadSeq;
      for (const ref of swapQuestion.basedOnRefs) {
        store.addRef(cid, `swap_${swapQuestion.swapId}`, ref, result.event.seq);
      }
      store.append(
        branchId,
        'rule_outcome_recorded',
        {
          outcome: {
            rule: 'RULE_TRACKS_CAN_BREAK_AND_SWAP',
            scenario: key,
            passed: swapQuestion.status === 'open',
            severity: swapQuestion.status === 'open' ? 'warning' : 'info',
            affectedEntityIds: [
              `track_${swapQuestion.trackIdA}`,
              `track_${swapQuestion.trackIdB}`
            ],
            evidence: {
              range: [
                swapQuestion.fromSequenceIndex,
                swapQuestion.toSequenceIndex
              ]
            },
            message:
              swapQuestion.status === 'open'
                ? '检测到身份交换疑点，未决前不静默合并，保留全部候选'
                : '身份交换已人工裁定'
          }
        },
        { expectedHeadSeq: headSeq, author: 'rules' }
      );
      headSeq = store.getBranch(branchId).headBranchSeq;
    }

    const axis = buildAxis(materials, config, trackRefs);
    const axisRef = recordDerived(
      service,
      branchId,
      () => headSeq,
      (value) => {
        headSeq = value;
      },
      `axis_${axis.axisId}`,
      'tilt_axis',
      axis
    );

    const candidates = buildCandidates(materials, config, tracks, axisRef, trackRefs);
    const candidateRefs: VersionRef[] = [];
    for (const candidate of candidates) {
      const ref = recordDerived(
        service,
        branchId,
        () => headSeq,
        (value) => {
          headSeq = value;
        },
        candidate.candidateId,
        'registration_candidate',
        candidate
      );
      candidateRefs.push(ref);
      store.append(
        branchId,
        'candidate_proposed',
        {
          candidateId: candidate.candidateId,
          ambiguityGroup: candidate.ambiguityGroup
        },
        { expectedHeadSeq: headSeq, author: 'scenario-builder' }
      );
      headSeq = store.getBranch(branchId).headBranchSeq;
    }

    emitScenarioRuleOutcomes(store, branchId, () => headSeq, (value) => {
      headSeq = value;
    }, config, axis, candidates);

    const verdict = compareCandidates(candidates);
    const comparisonId = `comparison_${key}`;
    recordDerived(
      service,
      branchId,
      () => headSeq,
      (value) => {
        headSeq = value;
      },
      comparisonId,
      'comparison',
      {
        ...verdict.comparison,
        comparisonId
      },
      false
    );
  });

  const state = service.state(branchId);
  const candidates = [...state.entities.entries()]
    .filter(([id]) => id.startsWith(`cand_${key}_`))
    .map(([id]) => {
      const version = state.headVersionByEntity.get(id)!;
      return state.entities.get(id)!.get(version)!.body as RegistrationCandidate;
    });
  const axisVersion = state.headVersionByEntity.get(`axis_axis_${key}`)!;
  const axisRecord = state.entities.get(`axis_axis_${key}`)!.get(axisVersion)!;
  const trackRefs = candidates[0]?.basedOnRefs.filter((ref) => ref.kind === 'track') ?? [];
  return {
    branchId,
    headSeq: store.getBranch(branchId).headBranchSeq,
    trackRefs,
    axisRef: {
      entityId: axisRecord.entityId,
      kind: 'tilt_axis',
      version: axisVersion,
      contentId: axisRecord.contentId
    },
    candidateRefs: candidates.map((candidate) => ({
      entityId: candidate.candidateId,
      kind: 'registration_candidate' as const,
      version: 1,
      contentId: candidate.candidateId
    })),
    candidates,
    violations: compareCandidates(candidates).violations
  };
}

function recordDerived(
  service: TiltService,
  branchId: string,
  getHeadSeq: () => number,
  setHeadSeq: (value: number) => void,
  entityId: string,
  kind: EntityKind,
  body: unknown,
  addReferences = true
): VersionRef {
  const store = service.store;
  const refs =
    body && typeof body === 'object' && 'basedOnRefs' in body
      ? ((body as { basedOnRefs: VersionRef[] }).basedOnRefs ?? [])
      : [];
  const cid = contentId(kind, body);
  const result = store.append(
    branchId,
    'entity_recorded',
    {
      entityId,
      kind,
      version: 1,
      contentId: cid,
      body,
      refs
    },
    { expectedHeadSeq: getHeadSeq(), author: 'scenario-builder' }
  );
  setHeadSeq(result.newHeadSeq);
  if (addReferences) {
    for (const ref of refs) store.addRef(cid, entityId, ref, result.event.seq);
  }
  return { entityId, kind, version: 1, contentId: cid };
}

function emitScenarioRuleOutcomes(
  store: TiltService['store'] extends infer T ? any : never,
  branchId: string,
  getHeadSeq: () => number,
  setHeadSeq: (value: number) => void,
  config: ScenarioConfig,
  axis: TiltAxis,
  candidates: RegistrationCandidate[]
): void {
  const outcomes = buildOutcomes(config, axis, candidates);
  for (const outcome of outcomes) {
    const result = (store as any).append(
      branchId,
      'rule_outcome_recorded',
      { outcome },
      { expectedHeadSeq: getHeadSeq(), author: 'rules' }
    );
    setHeadSeq(result.newHeadSeq);
  }
}

function buildOutcomes(
  config: ScenarioConfig,
  axis: TiltAxis,
  candidates: RegistrationCandidate[]
) {
  const outcomes = [];
  if (config.assumeCenter || config.key === 'axis_offset' || config.key === 'combined') {
    outcomes.push({
      rule: 'RULE_AXIS_NOT_ASSUMED_CENTER',
      scenario: config.key,
      passed: !axis.centered || config.assumeCenter === true ? !config.assumeCenter : false,
      severity: (config.assumeCenter ? 'violation' : axis.centered ? 'warning' : 'info'),
      affectedEntityIds: [axis.axisId],
      evidence: { offsetFromCenterPx: axis.offsetFromCenterPx },
      message: config.assumeCenter
        ? '禁止把倾转轴默认固定在图像中心'
        : `轴线显式估计偏心 ${axis.offsetFromCenterPx}px，未采用中心默认`
    });
  }
  const fingerprintCount = new Set(
    candidates.map((candidate) => candidate.effectivePointSetFingerprint)
  ).size;
  if (candidates.length > 1) {
    outcomes.push({
      rule: 'RULE_SAME_EFFECTIVE_POINT_SET',
      scenario: config.key,
      passed: fingerprintCount === 1,
      severity: fingerprintCount === 1 ? 'info' : 'warning',
      affectedEntityIds: candidates.map((candidate) => candidate.candidateId),
      evidence: { fingerprintCount },
      message:
        fingerprintCount === 1
          ? '候选使用相同有效点集，允许直接比较残差'
          : '候选有效点集不同，残差不可直接比较'
    });
  }
  const excluder = candidates.find(
    (candidate) => candidate.strategy === 'exclude_bad_frames'
  );
  if (excluder) {
    const allJustified = excluder.excludedFrames.every((frame) => frame.reason);
    outcomes.push({
      rule: 'RULE_NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL',
      scenario: config.key,
      passed: allJustified && fingerprintCount !== 1,
      severity: 'warning',
      affectedEntityIds: [excluder.candidateId],
      evidence: {
        excludedFrames: excluder.excludedFrames,
        effectiveFrameCount: excluder.effectiveFrameSequence.length
      },
      message:
        '排除坏帧方案有效点集与其它候选不同，只能凭坏帧依据单独评估，不能以少帧换低残差取胜'
    });
  }
  const warper = candidates.find(
    (candidate) => candidate.strategy === 'local_warp'
  );
  if (warper) {
    const overfit =
      warper.degreesOfFreedom / Math.max(warper.pointCount, 1) > 0.5;
    outcomes.push({
      rule: 'RULE_WARP_DEGREES_OF_FREEDOM_CAP',
      scenario: config.key,
      passed: !overfit,
      severity: overfit ? 'violation' : 'info',
      affectedEntityIds: [warper.candidateId],
      evidence: {
        degreesOfFreedom: warper.degreesOfFreedom,
        pointCount: warper.pointCount
      },
      message: overfit
        ? '局部形变自由度超出有效点支撑，判过拟合'
        : '局部形变自由度在数据支撑范围内'
    });
  }
  const ambiguous = candidates.some(
    (candidate) => candidate.ambiguityGroup
  );
  if (ambiguous || config.key === 'ambiguity' || config.key === 'missing_high_tilt') {
    outcomes.push({
      rule: 'RULE_KEEP_ALL_EQUIVOCAL_CANDIDATES',
      scenario: config.key,
      passed: true,
      severity: ambiguous ? 'warning' : 'info',
      affectedEntityIds: candidates.map((candidate) => candidate.candidateId),
      evidence: {
        ambiguityGroups: [
          ...new Set(
            candidates
              .map((candidate) => candidate.ambiguityGroup)
              .filter(Boolean)
          )
        ]
      },
      message: '无法唯一决定时保留全部合法候选，等待人工裁定'
    });
  }
  return outcomes;
}
