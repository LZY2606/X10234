import type { ArchiveStore } from "./db/store";
import type { DecisionEvent, ProvenanceResult } from "../shared/types";

/**
 * 查询任一实体：返回它引用的版本号与内容摘要。
 * 缺少引用必须报损坏（CORRUPT_REFERENCE），不能退回当前最新版。
 */
export function describeEntity(store: ArchiveStore, entityId: string): ProvenanceResult {
  const result: ProvenanceResult = {
    entityId,
    referencedVersions: [],
    chain: [],
    corruption: null,
  };
  const envelope = store.getObject(entityId);
  const event = store.getEvent(entityId);
  const referenced = new Set<string>();

  if (envelope) {
    for (const ref of Object.values(envelope.refs)) {
      for (const id of Array.isArray(ref) ? ref : [ref]) referenced.add(id);
    }
  } else if (event) {
    for (const value of Object.values(event.refs)) {
      for (const ref of Array.isArray(value) ? value : [value]) referenced.add(ref);
    }
    for (const ref of Object.keys(event.dependencySnapshot)) referenced.add(ref);
    if (event.prevEventId) referenced.add(event.prevEventId);
  } else {
    // 也许是分支/规则/commit/候选/锁
    const branch = store.getBranch(entityId);
    if (branch) {
      referenced.add(branch.commitId);
      referenced.add(branch.ruleVersionId);
      if (branch.headEventId) referenced.add(branch.headEventId);
    }
    const rule = store.getRuleVersion(entityId);
    if (rule) {
      // 规则版本是自包含的
    }
    const candidate = store.getCandidate(entityId);
    if (candidate) {
      referenced.add(candidate.branchId);
      referenced.add(candidate.ruleVersionId);
    }
    if (!branch && !rule && !candidate) {
      result.corruption = {
        code: "ENTITY_NOT_FOUND",
        message: `实体 ${entityId} 在档案中不存在；不允许静默回退到当前最新版`,
        missingRef: entityId,
      };
      return result;
    }
  }

  for (const ref of referenced) {
    const digest = store.digestOf(ref);
    if (!digest) {
      result.corruption = {
        code: "CORRUPT_REFERENCE",
        message: `${entityId} 引用的 ${ref} 缺失，档案已损坏；不能退回当前最新版`,
        missingRef: ref,
      };
      return result;
    }
    result.referencedVersions.push({ ref, versionDigest: digest });
  }

  // 事件链回溯
  const branchId = event?.branchId ?? store.getCandidate(entityId)?.branchId ?? store.getBranch(entityId)?.id;
  if (branchId) {
    const events = store.listEvents(branchId);
    const touches = (e: DecisionEvent) =>
      e.id === entityId ||
      JSON.stringify(e.refs).includes(entityId) ||
      Object.keys(e.dependencySnapshot).includes(entityId);
    result.chain = events
      .filter(touches)
      .map((e) => ({ eventId: e.id, kind: e.kind, at: e.at, summary: e.summary }));
  }
  return result;
}

/** 校验分支事件链：从任一旧事件重放时，依赖版本必须与当时快照一致。 */
export function verifyEventAt(
  store: ArchiveStore,
  event: DecisionEvent,
): { ok: true } | { ok: false; code: string; message: string } {
  for (const [id, expectedDigest] of Object.entries(event.dependencySnapshot)) {
    const current = store.digestOf(id);
    if (!current) {
      return { ok: false, code: "CORRUPT_REFERENCE", message: `事件 ${event.id} 依赖的 ${id} 缺失` };
    }
    if (current !== expectedDigest) {
      return {
        ok: false,
        code: "DEPENDENCY_DRIFT",
        message: `事件 ${event.id} 是在旧版本 ${expectedDigest.slice(0, 8)} 上做出的，当前 ${id}=${current.slice(0, 8)}；历史视图不得被最新结果覆盖`,
      };
    }
  }
  return { ok: true };
}
