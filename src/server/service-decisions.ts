import { TiltService } from './service-read';
import { contentId } from '../domain/hash';
import type {
  Decision,
  RegistrationCandidate,
  VersionRef
} from '../domain/types';

/**
 * 复核裁定。视图选择/候选切换/接受/否定都不改写原数据，
 * 只追加 decision 事件；任一裁定可撤销（追加否定事件并恢复上一分支状态）。
 */

export interface DecisionResult {
  headSeq: number;
  decisionRef: VersionRef;
  candidateStatus: RegistrationCandidate['status'];
}

function latestCandidate(
  service: TiltService,
  branchId: string,
  candidateId: string
): { record: import('../domain/types').EntityRecord; version: number } {
  const state = service.state(branchId);
  const version = state.headVersionByEntity.get(candidateId);
  if (version === undefined) throw new Error(`未知候选 ${candidateId}`);
  return { record: state.entities.get(candidateId)!.get(version)!, version };
}

export function decideCandidate(
  service: TiltService,
  branchId: string,
  candidateId: string,
  accepted: boolean,
  reason: string,
  expectedHeadSeq: number
): DecisionResult {
  return service.store.transaction(() => {
    const { record, version } = latestCandidate(service, branchId, candidateId);
    const candidate = record.body as RegistrationCandidate;
    const newStatus: RegistrationCandidate['status'] = accepted
      ? 'accepted'
      : 'rejected';

    const updated: RegistrationCandidate = { ...candidate, status: newStatus };
    const newVersion = version + 1;
    const updatedContentId = contentId('registration_candidate', updated);
    const targetRef: VersionRef = {
      entityId: candidateId,
      kind: 'registration_candidate',
      version: newVersion,
      contentId: updatedContentId
    };

    let headSeq = expectedHeadSeq;
    const candidateAppend = service.store.append(
      branchId,
      'entity_recorded',
      {
        entityId: candidateId,
        kind: 'registration_candidate',
        version: newVersion,
        contentId: updatedContentId,
        body: updated,
        refs: candidate.basedOnRefs
      },
      { expectedHeadSeq: headSeq, author: 'reviewer' }
    );
    headSeq = candidateAppend.newHeadSeq;
    for (const ref of candidate.basedOnRefs) {
      service.store.addRef(
        updatedContentId,
        candidateId,
        ref,
        candidateAppend.event.seq
      );
    }

    const decision: Decision = {
      kind: 'decision',
      layer: 'review',
      decisionId: `decision_${candidateId}_${accepted ? 'accept' : 'reject'}`,
      decisionKind: accepted ? 'accept_candidate' : 'reject_candidate',
      targetRef,
      accepted,
      reason,
      basedOnHeadSeq: expectedHeadSeq
    };
    const decisionContentId = contentId('decision', decision);
    const decisionAppend = service.store.append(
      branchId,
      'entity_recorded',
      {
        entityId: decision.decisionId,
        kind: 'decision',
        version: 1,
        contentId: decisionContentId,
        body: decision,
        refs: [targetRef]
      },
      { expectedHeadSeq: headSeq, author: 'reviewer' }
    );
    headSeq = decisionAppend.newHeadSeq;
    service.store.addRef(
      decisionContentId,
      decision.decisionId,
      targetRef,
      decisionAppend.event.seq
    );
    service.store.append(
      branchId,
      'decision_recorded',
      {
        decisionId: decision.decisionId,
        decisionKind: decision.decisionKind,
        target: targetRef,
        accepted
      },
      { expectedHeadSeq: headSeq, author: 'reviewer' }
    );
    return {
      headSeq: service.store.getBranch(branchId).headBranchSeq,
      decisionRef: {
        entityId: decision.decisionId,
        kind: 'decision',
        version: 1,
        contentId: decisionContentId
      },
      candidateStatus: newStatus
    };
  });
}

/** 撤销：不删除历史，追加一条把候选恢复成 proposed 的新版本。 */
export function undoDecision(
  service: TiltService,
  branchId: string,
  candidateId: string,
  expectedHeadSeq: number
): DecisionResult {
  return service.store.transaction(() => {
    const { record, version } = latestCandidate(service, branchId, candidateId);
    const candidate = record.body as RegistrationCandidate;
    const restored: RegistrationCandidate = { ...candidate, status: 'proposed' };
    const newVersion = version + 1;
    const contentIdValue = contentId('registration_candidate', restored);
    const targetRef: VersionRef = {
      entityId: candidateId,
      kind: 'registration_candidate',
      version: newVersion,
      contentId: contentIdValue
    };
    const result = service.store.append(
      branchId,
      'entity_recorded',
      {
        entityId: candidateId,
        kind: 'registration_candidate',
        version: newVersion,
        contentId: contentIdValue,
        body: restored,
        refs: restored.basedOnRefs
      },
      { expectedHeadSeq, author: 'reviewer' }
    );
    for (const ref of restored.basedOnRefs) {
      service.store.addRef(contentIdValue, candidateId, ref, result.event.seq);
    }
    service.store.append(
      branchId,
      'decision_undone',
      {
        decisionId: `undo_${candidateId}`,
        restoredRef: targetRef
      },
      { expectedHeadSeq: result.newHeadSeq, author: 'reviewer' }
    );
    return {
      headSeq: service.store.getBranch(branchId).headBranchSeq,
      decisionRef: targetRef,
      candidateStatus: 'proposed'
    };
  });
}

/**
 * 锁定一版配准供重建引用。
 * 句柄钉住 (entityId, version, contentId)；读回永远解析到该版，不退回最新。
 */
export function lockForReconstruction(
  service: TiltService,
  branchId: string,
  candidateId: string,
  expectedHeadSeq: number,
  handle?: string
): { handle: string; ref: VersionRef; headSeq: number } {
  return service.store.transaction(() => {
    const { record, version } = latestCandidate(service, branchId, candidateId);
    const candidate = record.body as RegistrationCandidate;
    if (candidate.status !== 'accepted') {
      throw new Error('只有已接受的候选才能锁定供重建引用');
    }
    const ref: VersionRef = {
      entityId: candidateId,
      kind: 'registration_candidate',
      version,
      contentId: record.contentId
    };
    const reconstructionHandle =
      handle ?? `recon_${candidateId}_v${version}`;
    service.store.putLock(reconstructionHandle, ref, 'reviewer');
    const result = service.store.append(
      branchId,
      'locked_for_reconstruction',
      { reconstructionHandle, candidateRef: ref },
      { expectedHeadSeq, author: 'reviewer' }
    );
    return {
      handle: reconstructionHandle,
      ref,
      headSeq: result.newHeadSeq
    };
  });
}

/**
 * 参数修订或参考版本变化：只失效依赖范围内候选，绝不全局替换旧结论。
 * 追加 candidate_invalidated 事件，旧版本仍可读。
 */
export function invalidateDependents(
  service: TiltService,
  branchId: string,
  changedContentIds: string[],
  note: string,
  expectedHeadSeq: number
): { invalidatedCandidateIds: string[]; headSeq: number } {
  return service.store.transaction(() => {
    const affected = service.store.dependentsOf(changedContentIds);
    const state = service.state(branchId);
    const invalidatedCandidateIds: string[] = [];
    let headSeq = expectedHeadSeq;
    for (const contentIdValue of affected) {
      const record = state.byContentId.get(contentIdValue);
      if (!record || record.kind !== 'registration_candidate') continue;
      const candidate = record.body as RegistrationCandidate;
      const version = state.headVersionByEntity.get(candidate.candidateId)!;
      const current = state.entities
        .get(candidate.candidateId)!
        .get(version)!;
      const body = current.body as RegistrationCandidate;
      if (body.status === 'invalidated') continue;
      const updated: RegistrationCandidate = { ...body, status: 'invalidated' };
      const newVersion = version + 1;
      const updatedContentId = contentId('registration_candidate', updated);
      const append = service.store.append(
        branchId,
        'entity_recorded',
        {
          entityId: candidate.candidateId,
          kind: 'registration_candidate',
          version: newVersion,
          contentId: updatedContentId,
          body: updated,
          refs: updated.basedOnRefs
        },
        { expectedHeadSeq: headSeq, author: 'system' }
      );
      headSeq = append.newHeadSeq;
      const refs: VersionRef[] = changedContentIds.map((cid) => ({
        entityId: state.byContentId.get(cid)?.entityId ?? cid,
        kind: (state.byContentId.get(cid)?.kind ?? 'raw_frame') as never,
        version:
          state.byContentId.get(cid)?.version ?? 1,
        contentId: cid
      }));
      service.store.append(
        branchId,
        'candidate_invalidated',
        {
          candidateId: candidate.candidateId,
          invalidatedBy: refs,
          affectedScope: [candidate.candidateId],
          note
        },
        { expectedHeadSeq: headSeq, author: 'system' }
      );
      headSeq = service.store.getBranch(branchId).headBranchSeq;
      invalidatedCandidateIds.push(candidate.candidateId);
    }
    return {
      invalidatedCandidateIds,
      headSeq: service.store.getBranch(branchId).headBranchSeq
    };
  });
}
