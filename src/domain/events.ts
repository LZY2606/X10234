import type { EntityKind, EntityBody, MaterialSetRevision, ScenarioKey, VersionRef } from './types';

/**
 * 事件流：append-only。每个分支一条可分叉的链。
 * 判断依据（例如“轴线不能默认在中心”“不同候选必须相同有效点集”）以
 * 机器可读的规则事件落盘，而不是只写在文档里。
 */

export type RuleCode =
  | 'RULE_AXIS_NOT_ASSUMED_CENTER'
  | 'RULE_TRACKS_CAN_BREAK_AND_SWAP'
  | 'RULE_SAME_EFFECTIVE_POINT_SET'
  | 'RULE_NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL'
  | 'RULE_WARP_DEGREES_OF_FREEDOM_CAP'
  | 'RULE_KEEP_ALL_EQUIVOCAL_CANDIDATES'
  | 'RULE_LOCK_PIN_VERSION'
  | 'RULE_IMPORT_NO_IRREVERSIBLE_CLEANUP'
  | 'RULE_MISSING_REF_IS_CORRUPTION'
  | 'RULE_DEPENDENCY_INVALIDATION_SCOPED';

export type EventType =
  | 'branch_created'
  | 'material_set_committed'
  | 'entity_recorded'
  | 'rule_asserted'
  | 'rule_outcome_recorded'
  | 'candidate_proposed'
  | 'candidate_invalidated'
  | 'decision_recorded'
  | 'decision_undone'
  | 'locked_for_reconstruction'
  | 'case_annotation'
  | 'scenario_boundary_recorded';

export interface RuleAssertion {
  rule: RuleCode;
  statement: string;
  parameter: number | string | boolean;
}

export interface RuleOutcome {
  rule: RuleCode;
  scenario: ScenarioKey;
  passed: boolean;
  severity: 'info' | 'warning' | 'violation' | 'blocked';
  affectedEntityIds: string[];
  evidence: Record<string, unknown>;
  message: string;
}

export interface ScenarioBoundary {
  scenario: ScenarioKey;
  phase: 'minimum_input' | 'combined_input' | 'diagnosis' | 'human_decision';
  sharedBlobIds: string[];
  affectedRange: string[];
}

export interface EventPayloads {
  branch_created: { parentBranchId?: string; reason: string };
  material_set_committed: { revision: MaterialSetRevision };
  entity_recorded: {
    entityId: string;
    kind: EntityKind;
    version: number;
    contentId: string;
    body: EntityBody;
    refs: VersionRef[];
  };
  rule_asserted: { assertion: RuleAssertion };
  rule_outcome_recorded: { outcome: RuleOutcome };
  candidate_proposed: { candidateId: string; ambiguityGroup?: string };
  candidate_invalidated: {
    candidateId: string;
    invalidatedBy: VersionRef[];
    affectedScope: string[];
    note: string;
  };
  decision_recorded: {
    decisionId: string;
    decisionKind: string;
    target: VersionRef;
    accepted: boolean;
    undoes?: VersionRef;
  };
  decision_undone: { decisionId: string; restoredRef: VersionRef };
  locked_for_reconstruction: {
    reconstructionHandle: string;
    candidateRef: VersionRef;
  };
  case_annotation: {
    scenario: ScenarioKey;
    title: string;
    narrative: string;
  };
  scenario_boundary_recorded: { boundary: ScenarioBoundary };
}

export interface RecordedEvent<T extends EventType = EventType> {
  eventId: string;
  branchId: string;
  seq: number;
  type: T;
  payload: EventPayloads[T];
  createdAt: string;
  author: string;
}

export const RULE_LIBRARY: RuleAssertion[] = [
  {
    rule: 'RULE_AXIS_NOT_ASSUMED_CENTER',
    statement:
      '倾转轴不能被默认固定在图像中心；必须显式估计轴线位置并报告偏心量。',
    parameter: 'axis_estimated'
  },
  {
    rule: 'RULE_TRACKS_CAN_BREAK_AND_SWAP',
    statement:
      'fiducial 轨迹可以断裂（track_gap），且跟踪身份可能交换；身份问题未决时不得静默合并。',
    parameter: 'breakable_swapable'
  },
  {
    rule: 'RULE_SAME_EFFECTIVE_POINT_SET',
    statement: '不同候选必须使用相同有效点集才允许直接比较残差。',
    parameter: 'fingerprint_match'
  },
  {
    rule: 'RULE_NO_FEWER_FRAMES_FOR_LOWER_RESIDUAL',
    statement: '不允许靠丢弃帧/点来换取更低残差而取胜；排除必须有依据并单独标注。',
    parameter: 'frame_count_match_or_flagged'
  },
  {
    rule: 'RULE_WARP_DEGREES_OF_FREEDOM_CAP',
    statement:
      '局部形变自由度不得超过有效点数支撑；自由度/点数比超阈即判过拟合。',
    parameter: 0.5
  },
  {
    rule: 'RULE_KEEP_ALL_EQUIVOCAL_CANDIDATES',
    statement: '无法唯一决定时必须保留全部合法候选，等待人工裁定。',
    parameter: 'keep_all'
  },
  {
    rule: 'RULE_LOCK_PIN_VERSION',
    statement:
      '锁定供重建引用的配准必须钉住具体版本号与内容摘要；读回不得退回最新版。',
    parameter: 'pinned_version'
  },
  {
    rule: 'RULE_IMPORT_NO_IRREVERSIBLE_CLEANUP',
    statement: '导入时禁止不可逆清洗；无法转换的值留在原位置并附诊断。',
    parameter: 'diagnose_in_place'
  },
  {
    rule: 'RULE_MISSING_REF_IS_CORRUPTION',
    statement: '查询实体时缺少被引用版本必须报损坏，禁止回退到当前最新版。',
    parameter: 'corruption_error'
  },
  {
    rule: 'RULE_DEPENDENCY_INVALIDATION_SCOPED',
    statement: '参数或参考版本变化后，只失效依赖范围内的结论，不全局替换旧结论。',
    parameter: 'scoped_invalidation'
  }
];
