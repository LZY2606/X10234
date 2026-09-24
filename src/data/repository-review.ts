import type { Database } from './db';
import { queryAll, queryOne } from './db';
import { stableId, nowIso } from '../domain/ids';
import { appendEvent } from './repository-import';
import { advanceHead } from './repository-branch';
import type { RegistrationCandidate, Decision, LockedRegistration, EffectivePointSet, ID } from '../domain/types';

export function savePointSet(db: Database, ps: EffectivePointSet): void {
  if (queryOne(db, `SELECT 1 FROM point_sets WHERE point_set_id=$id`, { $id: ps.pointSetId })) return;
  db.run(
    `INSERT INTO point_sets(point_set_id,branch_id,pairs_json,frame_seqs_json,excluded_frame_seqs_json)
     VALUES($id,$b,$p,$f,$x)`,
    { $id: ps.pointSetId, $b: ps.branchId, $p: JSON.stringify(ps.pairs),
      $f: JSON.stringify(ps.frameSeqs), $x: JSON.stringify(ps.excludedFrameSeqs) }
  );
}

export function getPointSet(db: Database, pointSetId: string): EffectivePointSet | null {
  const r = queryOne(db, `SELECT * FROM point_sets WHERE point_set_id=$id`, { $id: pointSetId });
  if (!r) return null;
  return {
    pointSetId: String(r.point_set_id), branchId: String(r.branch_id),
    pairs: JSON.parse(String(r.pairs_json)), frameSeqs: JSON.parse(String(r.frame_seqs_json)),
    excludedFrameSeqs: JSON.parse(String(r.excluded_frame_seqs_json))
  };
}

export function saveCandidate(db: Database, c: RegistrationCandidate): string {
  const evt = appendEvent(db, {
    code: 'register.candidate', branchId: c.branchId, atIso: c.createdAtIso, author: 'pipeline',
    refs: [{ ref: c.candidateId, version: 1, kind: 'candidate',
             summary: `${c.kind} rms=${c.rmsResidualPx.toFixed(3)}px pairs=${c.effectivePairCount}` },
           { ref: c.pointSetId, version: 1, kind: 'point-set',
             summary: `common pairs=${c.effectivePairCount}` }],
    rationaleCodes: ['SAME_EFFECTIVE_POINT_SET', 'NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL'],
    payload: { kind: c.kind, rms: c.rmsResidualPx, pairCount: c.effectivePairCount,
               overfit: c.overfit, ambiguousWith: c.ambiguousWith ?? [],
               coverageNote: (c as RegistrationCandidate & { coverageNote?: string }).coverageNote ?? null }
  });
  if (!queryOne(db, `SELECT 1 FROM candidates WHERE candidate_id=$id`, { $id: c.candidateId })) {
    db.run(
      `INSERT INTO candidates(candidate_id,branch_id,point_set_id,kind,params_json,residuals_json,rms_px,max_px,pair_count,overfit,overfit_diagnostic,ambiguous_with_json,status,provenance_event_ids_json,coverage_note,created_at_iso)
       VALUES($id,$b,$ps,$k,$pa,$rs,$rms,$mx,$n,$of,$od,$am,$st,$pr,$cv,$at)`,
      { $id: c.candidateId, $b: c.branchId, $ps: c.pointSetId, $k: c.kind,
        $pa: JSON.stringify(c.params), $rs: JSON.stringify(c.residualsByFrame),
        $rms: c.rmsResidualPx, $mx: c.maxResidualPx, $n: c.effectivePairCount,
        $of: c.overfit ? 1 : 0, $od: c.overfitDiagnostic ?? null,
        $am: JSON.stringify(c.ambiguousWith ?? []), $st: c.status,
        $pr: JSON.stringify([evt.eventId]), $cv: (c as RegistrationCandidate & { coverageNote?: string }).coverageNote ?? null,
        $at: c.createdAtIso }
    );
  }
  advanceHead(db, c.branchId, evt.eventId);
  return evt.eventId;
}

export function getCandidate(db: Database, candidateId: string): RegistrationCandidate | null {
  const r = queryOne(db, `SELECT * FROM candidates WHERE candidate_id=$id`, { $id: candidateId });
  if (!r) return null;
  return {
    candidateId: String(r.candidate_id), branchId: String(r.branch_id),
    pointSetId: String(r.point_set_id), kind: JSON.parse(String(r.params_json)).kind,
    params: JSON.parse(String(r.params_json)), residualsByFrame: JSON.parse(String(r.residuals_json)),
    rmsResidualPx: Number(r.rms_px), maxResidualPx: Number(r.max_px),
    effectivePairCount: Number(r.pair_count), overfit: !!r.overfit,
    overfitDiagnostic: r.overfit_diagnostic ? String(r.overfit_diagnostic) : undefined,
    ambiguousWith: JSON.parse(String(r.ambiguous_with_json)),
    status: JSON.parse(JSON.stringify(String(r.status))) as RegistrationCandidate['status'],
    provenanceEventIds: JSON.parse(String(r.provenance_event_ids_json)),
    createdAtIso: String(r.created_at_iso),
    ...(r.coverage_note ? { coverageNote: String(r.coverage_note) } : {})
  } as RegistrationCandidate;
}

export function listCandidates(db: Database, branchId: string): RegistrationCandidate[] {
  return queryAll(db, `SELECT candidate_id FROM candidates WHERE branch_id=$b ORDER BY created_at_iso, candidate_id`,
    { $b: branchId }).map((r) => getCandidate(db, String(r.candidate_id))!);
}

export function setCandidateStatus(db: Database, candidateId: string, status: RegistrationCandidate['status']): void {
  db.run(`UPDATE candidates SET status=$s WHERE candidate_id=$id`, { $s: status, $id: candidateId });
}

/** 接受/否定都生成新事件且不改原数据；可撤销并恢复前一分支状态。 */
export function decide(
  db: Database,
  args: {
    branchId: ID; kind: Decision['kind']; candidateId?: ID; reason: string;
    author?: string; revertsDecisionId?: ID; expectedRevision?: number;
  }
): Decision {
  const at = nowIso();
  const evt = appendEvent(db, {
    code: args.kind === 'accept-candidate' ? 'decision.accept'
      : args.kind === 'reject-candidate' ? 'decision.reject'
      : args.kind === 'revert' ? 'decision.revert' : 'decision.revise',
    branchId: args.branchId, atIso: at, author: args.author ?? 'reviewer',
    refs: [{ ref: args.branchId, version: 1, kind: 'branch', summary: args.kind },
           ...(args.candidateId ? [{ ref: args.candidateId, version: 1, kind: 'candidate', summary: args.reason }] : [])],
    rationaleCodes: args.kind === 'revert' ? ['CONFLICT_REQUIRES_REBASE'] : [],
    payload: { kind: args.kind, candidateId: args.candidateId ?? null, reason: args.reason,
               revertsDecisionId: args.revertsDecisionId ?? null }
  });
  const decisionId = stableId('dec', args.branchId, evt.seq);
  db.run(
    `INSERT INTO decisions(decision_id,branch_id,event_id,kind,candidate_id,reason,author,at_iso,reverts_decision_id,superseded_by)
     VALUES($id,$b,$e,$k,$c,$r,$a,$at,$rv,NULL)`,
    { $id: decisionId, $b: args.branchId, $e: evt.eventId, $k: args.kind,
      $c: args.candidateId ?? null, $r: args.reason, $a: args.author ?? 'reviewer', $at,
      $rv: args.revertsDecisionId ?? null }
  );
  if (args.revertsDecisionId) {
    db.run(`UPDATE decisions SET superseded_by=$new WHERE decision_id=$old`,
      { $new: decisionId, $old: args.revertsDecisionId });
    // 撤销接受/否定：恢复候选状态
    if (args.candidateId) setCandidateStatus(db, args.candidateId, 'proposed');
  } else if (args.kind === 'accept-candidate' && args.candidateId) {
    // 同点集的其它候选标记 superseded（仍保留），被接受候选 accepted
    const c = getCandidate(db, args.candidateId)!;
    for (const other of listCandidates(db, args.branchId)) {
      if (other.pointSetId === c.pointSetId && other.candidateId !== c.candidateId) {
        setCandidateStatus(db, other.candidateId, 'superseded');
      }
    }
    setCandidateStatus(db, c.candidateId, 'accepted');
  } else if (args.kind === 'reject-candidate' && args.candidateId) {
    setCandidateStatus(db, args.candidateId, 'rejected');
  }
  advanceHead(db, args.branchId, evt.eventId, args.expectedRevision);
  return {
    decisionId, branchId: args.branchId, kind: args.kind, candidateId: args.candidateId,
    reason: args.reason, author: args.author ?? 'reviewer', atIso: at,
    revertsDecisionId: args.revertsDecisionId, eventId: evt.eventId
  };
}

export function listDecisions(db: Database, branchId: ID): Decision[] {
  return queryAll(db, `SELECT * FROM decisions WHERE branch_id=$b ORDER BY event_id`, { $b: branchId })
    .map((r) => ({
      decisionId: String(r.decision_id), branchId: String(r.branch_id),
      kind: String(r.kind) as Decision['kind'], candidateId: r.candidate_id ? String(r.candidate_id) : undefined,
      reason: String(r.reason), author: String(r.author), atIso: String(r.at_iso),
      revertsDecisionId: r.reverts_decision_id ? String(r.reverts_decision_id) : undefined,
      supersededBy: r.superseded_by ? String(r.superseded_by) : undefined, eventId: String(r.event_id)
    }));
}

export function lockRegistration(
  db: Database, args: { branchId: ID; candidateId: ID; expectedRevision?: number }
): LockedRegistration {
  const c = getCandidate(db, args.candidateId);
  if (!c) throw new Error(`unknown candidate ${args.candidateId}`);
  if (c.status !== 'accepted') throw new Error('only an accepted candidate can be locked for reconstruction');
  const lockId = stableId('lock', args.branchId, args.candidateId);
  db.run(`DELETE FROM locked_registrations WHERE branch_id=$b`, { $b: args.branchId });
  const revision = (args.expectedRevision ?? 0) || requireRevision(db, args.branchId);
  const at = nowIso();
  const reconstructionRef = stableId('recon-ref', args.branchId, args.candidateId, revision);
  const evt = appendEvent(db, {
    code: 'registration.lock', branchId: args.branchId, atIso: at, author: 'reviewer',
    refs: [{ ref: args.candidateId, version: 1, kind: 'candidate', summary: 'locked for reconstruction' },
           { ref: c.pointSetId, version: 1, kind: 'point-set', summary: 'effective point set' }],
    rationaleCodes: ['SAME_EFFECTIVE_POINT_SET'],
    payload: { lockId, reconstructionRef, revision, candidateId: args.candidateId }
  });
  db.run(
    `INSERT INTO locked_registrations(lock_id,branch_id,candidate_id,point_set_id,revision,locked_at_iso,reconstruction_ref)
     VALUES($id,$b,$c,$ps,$rev,$at,$ref)`,
    { $id: lockId, $b: args.branchId, $c: args.candidateId, $ps: c.pointSetId, $rev: revision, $at, $ref: reconstructionRef }
  );
  advanceHead(db, args.branchId, evt.eventId, args.expectedRevision);
  return { lockId, branchId: args.branchId, candidateId: args.candidateId,
           pointSetId: c.pointSetId, revision, lockedAtIso: at, reconstructionRef };
}

function requireRevision(db: Database, branchId: string): number {
  return Number(queryOne<{ revision: number }>(db, `SELECT revision FROM branches WHERE branch_id=$b`,
    { $b: branchId })!.revision);
}

export function getLock(db: Database, branchId: ID): LockedRegistration | null {
  const r = queryOne(db, `SELECT * FROM locked_registrations WHERE branch_id=$b`, { $b: branchId });
  if (!r) return null;
  return {
    lockId: String(r.lock_id), branchId: String(r.branch_id), candidateId: String(r.candidate_id),
    pointSetId: String(r.point_set_id), revision: Number(r.revision),
    lockedAtIso: String(r.locked_at_iso), reconstructionRef: String(r.reconstruction_ref)
  };
}

/** 参数/参考版本变化：显式记录失效范围，绝不全局悄悄替换旧结论。 */
export function recordInvalidation(
  db: Database, args: { branchId: ID; triggerEventId?: ID; affectedEntityIds: ID[];
                        affectedKinds: string[]; reason: string; expectedRevision?: number }
): string {
  const evt = appendEvent(db, {
    code: 'invalidation.scope', branchId: args.branchId, atIso: nowIso(), author: 'system',
    refs: args.affectedEntityIds.map((id) => ({ ref: id, version: 1, kind: 'derived', summary: 'invalidated' })),
    rationaleCodes: ['DEPENDENCY_INVALIDATION_NOT_GLOBAL_REPLACE'],
    payload: { reason: args.reason, affectedKinds: args.affectedKinds, affectedEntityIds: args.affectedEntityIds }
  });
  const scopeId = stableId('scope', args.branchId, evt.seq);
  db.run(
    `INSERT INTO invalidation_scopes(scope_id,trigger_event_id,branch_id,affected_entity_ids_json,affected_kinds_json,reason)
     VALUES($id,$t,$b,$e,$k,$r)`,
    { $id: scopeId, $t: evt.eventId, $b: args.branchId, $e: JSON.stringify(args.affectedEntityIds),
      $k: JSON.stringify(args.affectedKinds), $r: args.reason }
  );
  advanceHead(db, args.branchId, evt.eventId, args.expectedRevision);
  return scopeId;
}
