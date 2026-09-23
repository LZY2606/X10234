import type { DomainEvent, EventType } from '../core/types.ts';
import { canonicalJson, eventId } from '../core/identity.ts';

let counter = 0;
function clockIso(seq: number): string {
  // 确定性时间戳基准 + seq，保证顺序可重放
  const base = Date.UTC(2026, 8, 24, 0, 0, 0);
  return new Date(base + seq * 1000 + counter++).toISOString();
}

export interface EventInput {
  seq: number;
  type: EventType;
  branch: string;
  payload: unknown;
  author: string;
  dependencyRefs: Record<string, string>;
  invalidationScope: string[];
  provenance: {
    directSourceEventIds: string[];
    importBatchId?: string;
    note?: string;
  };
  probeId?: string;
}

export function makeEvent(input: EventInput): DomainEvent {
  const atIso = clockIso(input.seq);
  const preHash = {
    type: input.type, branch: input.branch, payload: input.payload,
    dependencyRefs: input.dependencyRefs, invalidationScope: input.invalidationScope,
    provenance: input.provenance, atIso
  };
  return {
    eventId: eventId(input.seq, preHash),
    seq: input.seq,
    type: input.type,
    branch: input.branch,
    dependencyRefs: input.dependencyRefs,
    invalidationScope: input.invalidationScope,
    payload: input.payload,
    author: input.author,
    atIso,
    probeId: input.probeId,
    provenance: input.provenance
  };
}

/** 事件摘要（导出再导入顺序与身份保持） */
export function eventDigest(event: DomainEvent): string {
  return canonicalJson({
    eventId: event.eventId, seq: event.seq, type: event.type,
    branch: event.branch, payload: event.payload
  });
}
