/** 机器可读取事件类型与领域判断规则 */

export const EVENT_TYPES = [
  'material.imported',
  'material.source-revised',
  'parameter.revised',
  'axis.estimated',
  'candidate.computed',
  'candidate.invalidated',
  'rule.evaluated',
  'exclusion.recorded',
  'exclusion.revoked',
  'decision.accepted',
  'decision.rejected',
  'decision.locked',
  'decision.reverted',
  'decision.conflict',
  'branch.created',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RULES = {
  RULE_AXIS_NOT_ASSUMED_CENTER:
    '倾转轴不能被默认固定在图像中心；无数据支持的中心假设必须显式标记且不得进入比较',
  RULE_TRACKS_CAN_BREAK_AND_SWAP:
    'fiducial 轨迹可断裂且可能身份交换；断裂与交换必须显式建模，不得静默拼接',
  RULE_SAME_EFFECTIVE_POINT_SET:
    '不同候选用相同有效点集比较；点集不同时比较无效并记录诊断',
  RULE_NO_TRADING_FRAMES_FOR_LOWER_RESIDUAL:
    '不用少帧换低残差；删帧必须同时报告有效帧数与同点集对照残差',
} as const;
export type RuleId = keyof typeof RULES;

export interface AppendEventInput {
  eventId: string;
  branchId: string;
  eventType: EventType;
  actor: string;
  occurredAt: string;
  payload: unknown;
  txId?: string;
  /** 期望的分支状态版本（乐观并发）；缺省不检查 */
  expectedStateVersion?: number;
}

export interface StoredEvent {
  seq: number;
  eventId: string;
  branchId: string;
  eventType: EventType;
  actor: string;
  occurredAt: string;
  parentStateVersion: number;
  payload: unknown;
  contentSha256: string;
  txId: string;
}
