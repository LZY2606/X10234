import type { DomainEvent, EventType, JudgmentRule, MachineBasis } from "./types.ts";
import { newId } from "./ids.ts";

export function machineBasis(rule: JudgmentRule, evidenceRefs: string[], decision: string): MachineBasis {
  return { rule, evidenceRefs, decision };
}

export function createEvent<P>(
  fields: {
    archiveId: string;
    branchId: string;
    seq: number;
    type: EventType;
    actor?: DomainEvent["actor"];
    basis: string;
    machineBasis: MachineBasis;
    refs?: string[];
    createdAt: string;
    payload: P;
  }
): DomainEvent<P> {
  return {
    eventId: newId("event"),
    archiveId: fields.archiveId,
    branchId: fields.seq === 0 ? "ROOT" : fields.branchId,
    seq: fields.seq,
    type: fields.type,
    actor: fields.actor ?? "reviewer",
    basis: fields.basis,
    machineBasis: fields.machineBasis,
    refs: fields.refs ?? [],
    createdAt: fields.createdAt,
    payload: fields.payload
  };
}

export interface InvalidationImpact {
  changedDirectSource: string | null;
  changedRules: boolean;
  staleCandidateIds: string[];
  unaffectedCandidateIds: string[];
  staleRevisionIds: string[];
  scope: "local" | "global";
  reason: string;
}

/**
 * 依赖关系计算失效范围：
 * - 单个直接来源（如倾角 / 像素尺度 / 剂量 / 标记点坐标 ...）改动，只失效依赖该来源的候选；
 * - 规则版本变化，只失效用旧规则算的候选，但不删除旧事件；
 * - 绝不允许全局悄悄替换旧结论。
 */
export function computeInvalidation(args: {
  candidates: { candidateId: string; revisionId: string; rulesVersion: string; dependsOnSources: string[] }[];
  revisions: { revisionId: string; directSource: string | null }[];
  changedRevisionId: string | null;
  currentRulesVersion: string;
}): InvalidationImpact {
  const changedRevision = args.revisions.find((r) => r.revisionId === args.changedRevisionId) ?? null;
  const stale: string[] = [];
  const fresh: string[] = [];
  for (const cand of args.candidates) {
    const sourceStale = cand.revisionId === args.changedRevisionId;
    const rulesStale = cand.rulesVersion !== args.currentRulesVersion;
    if (sourceStale || rulesStale) stale.push(cand.candidateId);
    else fresh.push(cand.candidateId);
  }
  return {
    changedDirectSource: changedRevision?.directSource ?? null,
    changedRules: !changedRevision,
    staleCandidateIds: stale,
    unaffectedCandidateIds: fresh,
    staleRevisionIds: args.changedRevisionId ? [args.changedRevisionId] : [],
    scope: "local",
    reason: changedRevision
      ? `直接来源 ${changedRevision.directSource} 仅在 revision ${args.changedRevisionId} 变更，失效范围限制在引用该 revision 的候选`
      : `规则版本变化仅失效旧规则候选，历史事件保留可读`
  };
}
