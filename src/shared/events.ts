/**
 * 机器可读取事件：材料(import/revise)、规则评估(rule.eval)、候选(generated)、
 * 人工裁定(adjudicated)、锁定(locked)、失效(stale)、冲突(conflict) 全部是事件。
 * 事件链 prevHash -> hash，提供防篡改审计；任意事件处可恢复当时的依赖版本与可见结论。
 */
import { createHash } from 'node:crypto';
import type { ScenarioTag, ValueDiagnostic } from './domain.ts';

export const RULES = {
  AXIS_NOT_CENTER: {
    id: 'R-AXIS-01',
    statement: '倾转轴不能被默认固定在图像中心；必须由元数据、拟合或人工参数显式给出。',
  },
  TRACK_BREAK_SWAP: {
    id: 'R-TRACK-02',
    statement: 'fiducial 轨迹可断裂（跟踪缺口），且断裂两侧可能发生身份交换。',
  },
  SAME_VALID_SET: {
    id: 'R-CMP-03',
    statement: '不同候选用相同有效点集比较；不允许用少帧换低残差。',
  },
  NO_IRREVERSIBLE_CLEAN: {
    id: 'R-IMPORT-04',
    statement: '导入禁止不可逆清洗；无法转换的值留在原位并附诊断。',
  },
  MULTI_SOLUTION: {
    id: 'R-SOLVE-05',
    statement: '无法唯一决定时保留全部合法候选，不得静默选择其中一个。',
  },
  LOCAL_DEP_INVALIDATION: {
    id: 'R-DEP-06',
    statement: '参数或参考版本变化按依赖关系计算失效范围，禁止全局悄悄替换旧结论。',
  },
  CONCURRENT_FREEZE: {
    id: 'R-CONC-07',
    statement: '并发裁定基于期望父事件；后提交者得到版本冲突及双方差异，历史不被覆盖。',
  },
} as const;

export type EventType =
  | 'import'
  | 'source-revision'
  | 'rule.eval'
  | 'candidate.generated'
  | 'adjudicated'
  | 'adjudication-undo'
  | 'candidate.stale'
  | 'lock.created'
  | 'conflict.detected'
  | 'export'
  | 'reimport'
  | 'corrupt.ref';

export interface EventRef {
  entityId: string;
  version: number;
  contentSha?: string;
}

export interface EventPayloadMap {
  import: {
    caseCode: string;
    scope: 'minimal' | 'combined';
    scenarioTags: ScenarioTag[];
    added: EventRef[];
    blobs: string[];
    diagnostics: ValueDiagnostic[];
  };
  'source-revision': {
    changed: EventRef;
    dependsOn: EventRef[];
    kind: 'parameter-revision' | 'local-source-change' | 'conflicting-decision';
    note: string;
  };
  'rule.eval': {
    ruleId: string;
    outcome: 'pass' | 'fail' | 'warn';
    evidence: Record<string, unknown>;
  };
  'candidate.generated': {
    comparisonId: string;
    candidateId: string;
    method: 'rigid' | 'local-warp' | 'rigid-drop-frames';
    inputs: EventRef[];
    validSetSize: number;
    commonSetSize: number;
    commonRms: number;
    droppedFrames: string[];
    tiedWith: string[];
    diagnostics: ValueDiagnostic[];
  };
  adjudicated: {
    comparisonId: string;
    candidateId: string;
    decision: 'accepted' | 'rejected';
    decidedBy: string;
    reason: string;
  };
  'adjudication-undo': {
    undoneEventId: string;
    restoredBranchEventId: string;
    decidedBy: string;
  };
  'candidate.stale': {
    candidateIds: string[];
    dueTo: EventRef;
    scope: 'local' | 'global';
  };
  'lock.created': {
    lockId: string;
    comparisonId: string;
    candidateId: string;
    snapshotEventId: string;
    reconstructionRef: string;
  };
  'conflict.detected': {
    expectedParent: string;
    actualParent: string;
    submittedBy: string;
    diff: Record<string, unknown>;
  };
  export: { blobSha: string; includedEvents: number };
  reimport: { verifiedEvents: number; entities: number };
  'corrupt.ref': { missing: EventRef; message: string };
}

export type Event<T extends EventType = EventType> = {
  id: string;
  seq: number;
  branch: string;
  parentId: string | null;
  type: T;
  actor: string;
  at: string;
  payload: EventPayloadMap[T];
};

export type HashedEvent = Event & { hash: string; prevHash: string | null };

export function eventDigest(e: Omit<HashedEvent, 'hash'>): string {
  const material = JSON.stringify({
    id: e.id,
    seq: e.seq,
    branch: e.branch,
    parentId: e.parentId,
    type: e.type,
    actor: e.actor,
    at: e.at,
    payload: e.payload,
    prevHash: e.prevHash,
  });
  return createHash('sha256').update(material).digest('hex');
}

export function sealEvent(
  e: Omit<Event, never>,
  prevHash: string | null,
): HashedEvent {
  const withPrev = { ...e, prevHash };
  return { ...withPrev, hash: eventDigest(withPrev) };
}
