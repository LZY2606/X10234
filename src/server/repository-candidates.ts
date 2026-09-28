import type { DatabaseSync } from "node:sqlite";
import { sha256Hex, stableId, canonicalJson } from "../core/hashing.ts";
import type {
  AlignmentCandidate,
  DecisionRecord,
  LockedAlignment,
} from "../core/types.ts";
import { CorruptArchiveError } from "./repository.ts";

export class CandidateRepository {
  constructor(private db: DatabaseSync) {}

  saveCandidate(c: AlignmentCandidate): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO candidates(candidate_id, branch_id, commit_id, label, transform_kind, status,
          effective_point_key, effective_frame_ids_json, effective_track_ids_json, excluded_frame_ids_json,
          transforms_json, per_frame_residual_json, mean_residual, max_residual, overfit_ratio,
          free_parameter_count, observation_count, ambiguity_family_id, diagnostics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.candidateId,
        c.branchId,
        c.commitId,
        c.label,
        c.transformKind,
        c.status,
        c.effectivePointKey,
        JSON.stringify(c.effectiveFrameIds),
        JSON.stringify(c.effectiveTrackIds),
        JSON.stringify(c.excludedFrameIds),
        JSON.stringify(c.transforms),
        JSON.stringify(c.perFrameResidual),
        c.meanResidual,
        c.maxResidual,
        c.overfitRatio,
        c.freeParameterCount,
        c.observationCount,
        c.ambiguityFamilyId,
        JSON.stringify(c.diagnostics),
      );
  }

  candidatesAtCommit(commitId: string): AlignmentCandidate[] {
    const rows = this.db
      .prepare("SELECT * FROM candidates WHERE commit_id = ? ORDER BY transform_kind, label")
      .all(commitId) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  candidate(candidateId: string): AlignmentCandidate {
    const row = this.db.prepare("SELECT * FROM candidates WHERE candidate_id = ?").get(candidateId) as
      | CandidateRow
      | undefined;
    if (!row) throw new CorruptArchiveError(`missing-reference: candidate ${candidateId}`);
    return rowToCandidate(row);
  }

  // 候选必须引用当前档案中存在的提交；缺少引用即损坏
  assertCandidatesIntact(commitIds: string[]): void {
    for (const id of commitIds) {
      const row = this.db.prepare("SELECT 1 FROM commits WHERE commit_id = ?").get(id);
      if (!row) throw new CorruptArchiveError(`missing-reference: commit ${id}`);
    }
  }

  saveDecision(d: DecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO decisions(decision_id, branch_id, commit_id, candidate_id, kind, rationale,
           reverted_decision_id, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.decisionId,
        d.branchId,
        d.commitId,
        d.candidateId,
        d.kind,
        d.rationale,
        d.revertedDecisionId,
        1,
        d.createdAt,
      );
  }

  revertDecision(decisionId: string): DecisionRecord | null {
    const row = this.db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(decisionId) as
      | DecisionRow
      | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE decisions SET active = 0 WHERE decision_id = ?").run(decisionId);
    return {
      decisionId: row.decision_id,
      branchId: row.branch_id,
      commitId: row.commit_id,
      candidateId: row.candidate_id,
      kind: row.kind as DecisionRecord["kind"],
      rationale: row.rationale,
      revertedDecisionId: row.reverted_decision_id,
      createdAt: row.created_at,
    };
  }

  listDecisions(branchId: string): (DecisionRecord & { active: boolean })[] {
    const rows = this.db
      .prepare("SELECT * FROM decisions WHERE branch_id = ? ORDER BY created_at, rowid")
      .all(branchId) as DecisionRow[];
    return rows.map((r) => ({
      decisionId: r.decision_id,
      branchId: r.branch_id,
      commitId: r.commit_id,
      candidateId: r.candidate_id,
      kind: r.kind as DecisionRecord["kind"],
      rationale: r.rationale,
      revertedDecisionId: r.reverted_decision_id,
      createdAt: r.created_at,
      active: r.active === 1,
    }));
  }

  saveLock(lock: LockedAlignment): void {
    this.db
      .prepare("UPDATE locked_alignments SET active = 0 WHERE branch_id = ? AND active = 1")
      .run(lock.branchId);
    this.db
      .prepare(
        `INSERT INTO locked_alignments(lock_id, branch_id, candidate_id, commit_id, reconstruction_ref, active, locked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lock.lockId,
        lock.branchId,
        lock.candidateId,
        lock.commitId,
        lock.reconstructionRef,
        lock.active ? 1 : 0,
        lock.lockedAt,
      );
  }

  activeLock(branchId: string): (LockedAlignment & { active: boolean }) | null {
    const row = this.db
      .prepare("SELECT * FROM locked_alignments WHERE branch_id = ? AND active = 1 LIMIT 1")
      .get(branchId) as LockRow | undefined;
    if (!row) return null;
    return {
      lockId: row.lock_id,
      branchId: row.branch_id,
      candidateId: row.candidate_id,
      commitId: row.commit_id,
      reconstructionRef: row.reconstruction_ref,
      active: row.active === 1,
      lockedAt: row.locked_at,
    };
  }
}

interface CandidateRow {
  candidate_id: string;
  branch_id: string;
  commit_id: string;
  label: string;
  transform_kind: AlignmentCandidate["transformKind"];
  status: AlignmentCandidate["status"];
  effective_point_key: string;
  effective_frame_ids_json: string;
  effective_track_ids_json: string;
  excluded_frame_ids_json: string;
  transforms_json: string;
  per_frame_residual_json: string;
  mean_residual: number;
  max_residual: number;
  overfit_ratio: number | null;
  free_parameter_count: number;
  observation_count: number;
  ambiguity_family_id: string | null;
  diagnostics_json: string;
}

function rowToCandidate(r: CandidateRow): AlignmentCandidate {
  return {
    candidateId: r.candidate_id,
    branchId: r.branch_id,
    commitId: r.commit_id,
    label: r.label,
    transformKind: r.transform_kind,
    effectiveFrameIds: JSON.parse(r.effect_frame_ids_json),
    effectiveTrackIds: JSON.parse(r.effective_track_ids_json),
    effectivePointKey: r.effective_point,
    transforms: JSON.parse(r.transforms_json),
    perFrameResidual: JSON.parse(r.per_frame_residual_json),
    meanResidual: r.mean_residual,
    maxResidual: r.max_residual,
    excludedFrameIds: JSON.parse(r.excluded_frame_ids_json),
    status: r.status,
    diagnostics: JSON.parse(r.diagnostics_json),
    ambiguityFamilyId: r.ambiguity_family_id,
    overfitRatio: r.overfit_ratio,
    freeParameterCount: r.free_parameter_count,
    observationCount: r.observation_count,
  };
}

interface DecisionRow {
  decision_id: string;
  branch_id: string;
  commit_id: string;
  candidate_id: string | null;
  kind: string;
  rationale: string;
  reverted_decision_id: string | null;
  active: number;
  created_at: string;
}
interface LockRow {
  lock_id: string;
  branch_id: string;
  candidate_id: string;
  commit_id: string;
  reconstruction_ref: string;
  active: number;
  locked_at: string;
}
