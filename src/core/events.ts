import type {
  Adjudication,
  CandidateKind,
  DependencyEdge,
  Diagnostic,
  FrameProvenance,
  RawFrame,
  RegistrationCandidate,
  TiltAxisParams,
  TrackSegment,
  Uid,
  EffectivePointSet,
  SemVer,
} from './domain.js';

export type EventId = number;

export type RuleFindingCode =
  | 'AXIS_NOT_CENTERED'
  | 'TRACK_SWAP_DETECTED'
  | 'TRACK_GAP_PRESERVED'
  | 'MISSING_HIGH_TILT_FRAME'
  | 'BAD_FRAME_EXCLUDED'
  | 'LOCAL_WARP_OVERFIT'
  | 'AMBIGUOUS_MULTI_SOLUTION'
  | 'CONCURRENT_FREEZE'
  | 'UNFAIR_FEWER_FRAMES'
  | 'UNCONVERTIBLE_QUANTITY';

/** 机器可读取的判断依据事件 */
export interface RuleFinding {
  code: RuleFindingCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence: Record<string, unknown>;
  /** 失效范围：哪些实体版本受影响 */
  affects: Array<{ entity: string; version: EventId; scope: 'local' | 'global' }>;
}

export type ScenarioCode =
  | 'axis-eccentricity'
  | 'track-identity-swap'
  | 'missing-high-tilt'
  | 'bad-frame-exclusion'
  | 'local-warp-overfit'
  | 'multi-solution'
  | 'concurrent-freeze';

export type EventPayload =
  | {
      type: 'series.created';
      seriesId: Uid;
      name: string;
      frameCount: number;
      width: number;
      height: number;
      scenarios: ScenarioCode[];
    }
  | {
      type: 'frames.imported';
      seriesId: Uid;
      frames: Array<RawFrame & { provenance: FrameProvenance }>;
      /** 导入批次号：失败整体回滚，不产生任何事件 */
      batchId: Uid;
    }
  | {
      type: 'tracks.imported';
      seriesId: Uid;
      segments: TrackSegment[];
      batchId: Uid;
    }
  | { type: 'parameter.revised'; seriesId: Uid; parameter: string; before: unknown; after: unknown; reason: string }
  | {
      type: 'source.amended';
      seriesId: Uid;
      entityKind: string;
      entityStableId: Uid;
      scope: 'local' | 'global';
      reason: string;
    }
  | {
      type: 'candidate.proposed';
      seriesId: Uid;
      branchId: Uid;
      candidate: RegistrationCandidate;
      pointSet: EffectivePointSet;
      findings: RuleFinding[];
    }
  | {
      type: 'branch.created';
      seriesId: Uid;
      branchId: Uid;
      parentBranchId: Uid | null;
      reason: string;
      ruleVersion: SemVer;
    }
  | {
      type: 'adjudication.made';
      seriesId: Uid;
      branchId: Uid;
      adjudication: Adjudication;
    }
  | {
      type: 'adjudication.undone';
      seriesId: Uid;
      branchId: Uid;
      adjudicationId: Uid;
      restoredHeadEventId: EventId;
    }
  | {
      type: 'reconstruction.locked';
      seriesId: Uid;
      branchId: Uid;
      candidateId: Uid;
      reconstructionRef: string;
    }
  | {
      type: 'conflict.reported';
      seriesId: Uid;
      branchId: Uid;
      baseHeadEventId: EventId;
      rivalHeadEventId: EventId;
      sessionId: Uid;
      diff: ConflictDiff;
    }
  | {
      type: 'rule.findings.recorded';
      seriesId: Uid;
      branchId: Uid;
      findings: RuleFinding[];
    }
  | { type: 'diagnostic.recorded'; seriesId: Uid; diagnostic: Diagnostic };

export interface ConflictDiff {
  baseEventId: EventId;
  rivalEventId: EventId;
  leftSummary: string;
  rightSummary: string;
  changedEntities: Array<{ stableId: Uid; leftVersion: EventId | null; rightVersion: EventId | null }>;
}

export interface ArchiveEvent {
  id: EventId;
  seriesId: Uid;
  branchId: Uid | null;
  payload: EventPayload;
  /** 内容寻址：canonical JSON + 前一提交摘要 */
  commitDigest: string;
  parentCommitDigest: string | null;
  authorSessionId: Uid;
  createdAt: string;
  /** 显式引用的 (实体, 版本, 摘要)；查询时缺引用即损坏 */
  refs: Array<{ entity: string; version: EventId; digest: string }>;
  dependencies: DependencyEdge[];
}

export interface StoredContent {
  digest: string;
  bytes: Uint8Array;
  mediaType: string;
  /** 原始片段在最小输入与组合输入间共享：同一 digest 只存一份不可变内容 */
  sharedWith: Uid[];
}

export interface ReducedBranchState {
  branchId: Uid;
  headEventId: EventId;
  /** 候选映射（含被采纳与未被采纳的全部候选） */
  candidates: Record<Uid, RegistrationCandidate>;
  candidateOrder: Uid[];
  adjudications: Record<Uid, Adjudication>;
  lockedCandidateId: Uid | null;
  ruleVersion: SemVer;
  ruleFindings: RuleFinding[];
}
