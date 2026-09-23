import type {
  Comparison,
  ComparisonMember,
  RegistrationCandidate
} from './types';

/**
 * 候选比较与裁定规则（推导层）。
 * 不同候选必须使用相同有效点集才能直接比残差；
 * 不允许靠少帧/少点换取低残差取胜；
 * 无法唯一决定时保留全部合法候选。
 */

export interface ComparisonVerdict {
  comparison: Omit<Comparison, 'comparisonId'>;
  violations: string[];
}

const RESIDUAL_EPS = 1e-6;
const OVERFIT_DOF_RATIO = 0.5;

export function compareCandidates(
  candidates: RegistrationCandidate[]
): ComparisonVerdict {
  const violations: string[] = [];
  const fingerprints = new Set(
    candidates.map((candidate) => candidate.effectivePointSetFingerprint)
  );
  const sameEffectivePointSet = fingerprints.size <= 1;

  const maxFrameCount = Math.max(
    ...candidates.map((candidate) => candidate.effectiveFrameSequence.length)
  );

  const members: ComparisonMember[] = candidates.map((candidate) => {
    const sameFrames =
      candidate.effectiveFrameSequence.length === maxFrameCount;
    const comparable = sameEffectivePointSet && sameFrames;
    let comparabilityNote = '';
    if (!sameEffectivePointSet) {
      comparabilityNote =
        '有效点集不同：不得直接比较残差（可能靠丢弃点换取低残差）';
    } else if (!sameFrames) {
      comparabilityNote = `有效帧数 ${candidate.effectiveFrameSequence.length} < ${maxFrameCount}：排除帧方案只能在标注坏帧依据后单独评估`;
    }

    const overfit =
      candidate.strategy === 'local_warp' &&
      candidate.degreesOfFreedom / Math.max(candidate.pointCount, 1) >
        OVERFIT_DOF_RATIO;
    if (overfit) {
      comparabilityNote = comparabilityNote
        ? `${comparabilityNote}；局部形变过拟合`
        : '局部形变自由度超过有效点支撑，判过拟合';
    }
    if (candidate.diagnostics.some((line) => line.includes('多个等价解'))) {
      comparabilityNote = comparabilityNote
        ? `${comparabilityNote}；存在等价多解`
        : '无法唯一决定，保留全部合法候选';
    }
    return {
      candidateRef: {
        entityId: candidate.candidateId,
        kind: 'registration_candidate' as const,
        version: 1,
        contentId: candidate.candidateId
      },
      aggregateRmsPx: candidate.aggregateRmsPx,
      effectivePointSetFingerprint: candidate.effectivePointSetFingerprint,
      effectiveFrameCount: candidate.effectiveFrameSequence.length,
      comparable,
      comparabilityNote
    };
  });

  let winnerCandidateId: string | undefined;
  const comparableCandidates = candidates.filter((candidate, index) => {
    const member = members[index];
    const overfit =
      candidate.strategy === 'local_warp' &&
      candidate.degreesOfFreedom / Math.max(candidate.pointCount, 1) >
        OVERFIT_DOF_RATIO;
    return member.comparable && !overfit;
  });

  if (sameEffectivePointSet && comparableCandidates.length >= 1) {
    const best = comparableCandidates.reduce((bestCandidate, candidate) =>
      candidate.aggregateRmsPx + RESIDUAL_EPS < bestCandidate.aggregateRmsPx
        ? candidate
        : bestCandidate
    );
    // 等价多解：残差在数值容差内相同 => 不选唯一赢家。
    const ties = comparableCandidates.filter(
      (candidate) =>
        Math.abs(candidate.aggregateRmsPx - best.aggregateRmsPx) <=
        Math.max(RESIDUAL_EPS, best.aggregateRmsPx * 1e-6)
    );
    if (ties.length === 1) {
      winnerCandidateId = best.candidateId;
    } else {
      violations.push(
        `存在 ${ties.length} 个残差等价的合法候选，无法唯一决定，必须全部保留等待人工裁定`
      );
    }
  }

  if (!sameEffectivePointSet) {
    violations.push(
      '候选有效点集不一致：禁止用少帧/少点换取低残差而取胜'
    );
  }

  const excluded = candidates.find(
    (candidate) => candidate.effectiveFrameSequence.length < maxFrameCount
  );
  if (excluded && !excluded.excludedFrames.every((frame) => frame.reason)) {
    violations.push('存在缺少排除依据的帧被丢弃');
  }

  return {
    comparison: {
      kind: 'comparison',
      layer: 'review',
      members,
      sameEffectivePointSet,
      winnerCandidateId,
      rule: 'RULE_SAME_EFFECTIVE_POINT_SET + RULE_NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL',
      note: winnerCandidateId
        ? `相同有效点集下候选 ${winnerCandidateId} 残差最低`
        : '未自动选定赢家：查看 comparabilityNote 与 violations'
    },
    violations
  };
}

/** 撤销：恢复上一个分支状态（不删除任何事件，仅追加否定事件）。 */
export function canUndo(history: Array<{ accepted: boolean }>): boolean {
  return history.length > 0;
}
