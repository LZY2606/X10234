import type { ID } from './types';

/**
 * 机器可读事件。追加式、不可变；历史回放完全基于事件，
 * 回到任意旧事件即恢复当时依赖版本与可见结论。
 */
export type EventCode =
  | 'import.commit'
  | 'import.rollback'
  | 'branch.fork'
  | 'interpret.tilt-axis'
  | 'interpret.tracks'
  | 'register.candidate'
  | 'register.ambiguity'
  | 'review.select-view'
  | 'review.switch-candidate'
  | 'decision.accept'
  | 'decision.reject'
  | 'decision.revise'
  | 'decision.revert'
  | 'registration.lock'
  | 'registration.unlock'
  | 'invalidation.scope'
  | 'diagnostic.axis-offset'
  | 'diagnostic.identity-swap'
  | 'diagnostic.missing-high-tilt'
  | 'diagnostic.bad-frame-exclusion'
  | 'diagnostic.local-overfit'
  | 'diagnostic.ambiguous'
  | 'diagnostic.concurrent-freeze'
  | 'provenance.dangling';

/** 机器可读的“判断依据”代码 */
export type RationaleCode =
  | 'AXIS_NOT_CENTER_DEFAULT'
  | 'TRACK_CAN_BREAK'
  | 'TRACK_IDENTITY_CAN_SWAP'
  | 'SAME_EFFECTIVE_POINT_SET'
  | 'NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL'
  | 'KEEP_ALL_LEGAL_CANDIDATES'
  | 'NO_IRREVERSIBLE_IMPORT_CLEANING'
  | 'DEPENDENCY_INVALIDATION_NOT_GLOBAL_REPLACE'
  | 'UNCONVERTIBLE_VALUE_KEPT'
  | 'CONFLICT_REQUIRES_REBASE';

export interface DomainEvent {
  eventId: ID;
  seq: number;
  code: EventCode;
  branchId: ID | null;
  atIso: string;
  author: string;
  refs: Array<{ ref: ID; version: number; kind: string; sha?: string; summary: string }>;
  rationaleCodes: RationaleCode[];
  payload: Record<string, unknown>;
  invalidation?: { affectedKinds: string[]; affectedEntityIds: ID[]; reason: string };
}

export interface EventFilter {
  branchId?: ID;
  code?: EventCode;
}
