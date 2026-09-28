// 领域词汇表：电子断层 / 倾转序列 / fiducial 配准审阅
// 不把领域概念压成 name/value；所有量携带单位或坐标基准。

export const UNITS = {
  angleDeg: 'deg',
  pixelScale: 'nm/pixel',
  dose: 'e-/Å^2',
  lengthNm: 'nm',
  pixel: 'pixel',
  coordinateFrame: 'image-pixel(origin=top-left,x=right,y=down)'
} as const;

export type Unit = string;

export interface DomainQuantity<T = number> {
  value: T;
  unit: Unit;
  representation?: string; // 导入时的原始表示（字符串），派生层才规范化
  diagnostic?: string; // 无法转换时留在原位置的诊断
}

export type EntityKind =
  | 'tiltSeries'
  | 'rawFrame'
  | 'tiltAngle'
  | 'pixelScale'
  | 'exposureDose'
  | 'fiducialMarker'
  | 'markerObservation'
  | 'trackGap'
  | 'manualExclusion'
  | 'interpretation'
  | 'alignmentRule'
  | 'effectivePointSet'
  | 'alignmentCandidate'
  | 'candidateDiagnostic'
  | 'reviewDecision'
  | 'alignmentLock'
  | 'tiltAxis'
  | 'frameOverlay'
  | 'perFrameResidual'
  | 'candidateDifference'
  | 'archive';

export type ScenarioCode =
  | 'axisOffset' // 轴线偏心：倾转轴不能默认固定在图像中心
  | 'identitySwap' // 轨迹身份交换
  | 'missingHighTilt' // 缺失高倾角帧
  | 'badFrameExclusion' // 坏帧排除
  | 'localOverfit' // 局部形变过拟合
  | 'multipleSolutions' // 多解
  | 'concurrentFreeze'; // 并发冻结（保存冲突）

export interface RawFrameInput {
  frameId: string; // 稳定身份，如 f-001
  sequenceIndex: number; // 顺序在档案中保持
  acquisitionIndex: number; // 原始采集顺序（可能与倾转排序不同）
  tiltAngle: DomainQuantity;
  pixelScale: DomainQuantity;
  dose: DomainQuantity;
  width: number;
  height: number;
  blobId: string; // 不可变原始字节内容地址
  blobDigest: string;
}

export interface MarkerObservationInput {
  markerId: string;
  frameId: string;
  x: DomainQuantity; // 坐标基准：image-pixel
  y: DomainQuantity;
  present: boolean;
  swappedFrom?: string; // 该帧起此身份观测实际来自另一物理标记
  note?: string;
}

export interface TrackGapInput {
  gapId: string;
  markerId: string;
  fromFrameId: string;
  toFrameId: string;
  reason: string;
}

export interface ManualExclusionInput {
  exclusionId: string;
  frameId: string;
  reason: string;
  author: string;
}

export type AlignmentMethod = 'rigid' | 'localDeformation' | 'badFrameExcluded';

export interface FramePose {
  frameId: string;
  tx: number; // pixel
  ty: number; // pixel
  rotationDeg: number;
}

export interface TiltAxisEstimate {
  // 轴线以 ax + by + c = 0 表示，坐标基准 image-pixel；不强制过图像中心
  a: number;
  b: number;
  c: number;
  passesCenter: boolean;
  centerOffsetPx: number; // 轴线到图像中心距离
  angleDeg: number; // 轴线方向角
}

export interface PerFrameResidual {
  frameId: string;
  residualPx: number;
  used: boolean;
  excluded?: boolean;
}

export type DiagnosticCode =
  | 'AXIS_NOT_CENTERED'
  | 'TRACK_BROKEN'
  | 'IDENTITY_SWAP_SUSPECTED'
  | 'HIGH_TILT_MISSING'
  | 'BAD_FRAME_EXCLUDED'
  | 'LOCAL_OVERFIT'
  | 'AMBIGUOUS_MULTIPLE_SOLUTIONS'
  | 'POINT_SET_MISMATCH'
  | 'FEWER_FRAMES_NOT_ALLOWED'
  | 'CONFLICT'
  | 'UNCONVERTIBLE_VALUE_PRESERVED';

export interface CandidateDiagnostic {
  code: DiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  scenario?: ScenarioCode;
}

export interface AlignmentCandidateInput {
  candidateId: string;
  label: string;
  method: AlignmentMethod;
  effectivePointSetId: string; // 不同候选必须用相同有效点集比较
  axis: TiltAxisEstimate;
  poses: FramePose[];
  residuals: PerFrameResidual[];
  rmsResidualPx: number;
  equivalentAlternativeIds: string[]; // 多解：全部合法候选
  diagnostics: CandidateDiagnostic[];
  overfit?: boolean;
  compareGroupId: string; // 同组候选可比较
}

export type EventType =
  | 'MATERIAL_VERSIONED'
  | 'INTERPRETATION_BRANCHED'
  | 'RULE_PARAM_REVISED'
  | 'SOURCE_FRAGMENT_CHANGED'
  | 'CANDIDATE_COMPUTED'
  | 'CANDIDATE_INVALIDATED'
  | 'REVIEW_ACCEPTED'
  | 'REVIEW_REJECTED'
  | 'REVIEW_UNDECIDABLE'
  | 'DECISION_REVERTED'
  | 'ALIGNMENT_LOCKED'
  | 'LOCK_REVOKED'
  | 'CONFLICT_DETECTED'
  | 'SCENARIO_REPLAYED'
  | 'ARCHIVE_IMPORTED'
  | 'ARCHIVE_EXPORTED'
  | 'CORRUPTION_REPORTED';

export interface JudgmentBasis {
  ruleId: string;
  ruleVersion: number;
  statement: string; // 机器可读判断依据文本（领域规则）
}

export interface ProvenanceRef {
  entityId: string;
  kind: EntityKind;
  version: number; // 引用必须钉住具体版本；缺引用或找不到版本 => 损坏
  digest: string;
}

export interface DomainEventInput {
  eventId: string;
  type: EventType;
  branchId: string;
  scenario?: ScenarioCode;
  at: string; // ISO 时间，案例中可为确定性逻辑时钟
  actor: string;
  summary: string;
  basis?: JudgmentBasis[];
  subjects: ProvenanceRef[]; // 受影响对象（钉版本）
  payload?: Record<string, unknown>;
}

export interface BranchInput {
  branchId: string;
  parentBranchId?: string;
  name: string;
  note: string;
}

export interface RuleParams {
  assumeAxisAtCenter: boolean; // 必须为 false
  requireSharedEffectivePointSet: boolean; // true：不同候选用相同有效点集
  forbidFewerFramesForLowerResidual: boolean; // true
  keepAllAmbiguousSolutions: boolean; // true
  overfitResidualImprovementFloor: number; // 局部形变相对刚体残差改善低于此 => 过拟合嫌疑
  overfitExtraDofPerFrame: number;
  minFramesForAxisFit: number;
}

export const DEFAULT_RULE_PARAMS: RuleParams = {
  assumeAxisAtCenter: false,
  requireSharedEffectivePointSet: true,
  forbidFewerFramesForLowerResidual: true,
  keepAllAmbiguousSolutions: true,
  overfitResidualImprovementFloor: 0.05,
  overfitExtraDofPerFrame: 4,
  minFramesForAxisFit: 4
};

export interface EntityRef {
  id: string;
  version: number;
}

export interface EntitySummary {
  id: string;
  kind: EntityKind;
  version: number;
  digest: string;
  createdAt: string;
  refs: EntityRef[]; // 它引用的版本号
  content: unknown;
}

export interface ScenarioReplayResult {
  scenario: ScenarioCode;
  branchId: string;
  status: 'contained' | 'leaked' | 'conflict';
  invalidatedCandidateIds: string[];
  retainedCandidateIds: string[];
  events: string[];
}

export const RULE_STATEMENTS = {
  axisNotCentered: 'tilt-axis 必须由 fiducial 观测估计，不得默认固定在图像中心；axis.centerOffsetPx 需显式记录',
  tracksBreakAndSwap: 'fiducial 轨迹可断裂（trackGap）且可能身份交换（identitySwap）；禁止跨断裂/交换直接连点',
  samePointSet: '不同候选必须在相同 effectivePointSet 上比较残差',
  noFewerFramesTradeoff: '禁止用排除更多帧（更少有效帧）换取更低残差；有效帧数不同则不可比较并标记 FEWER_FRAMES_NOT_ALLOWED',
  keepAmbiguous: '无法唯一决定时保留全部等价合法候选，不得静默挑选一个',
  noIrreversibleCleaning: '导入时禁止不可逆清洗；不可转换值保留原值与诊断，派生层才规范化',
  scopedInvalidation: '参数或参考版本变化后按依赖关系限定失效范围，禁止全局替换旧结论',
  pinnedRefs: '任一实体引用必须钉住版本号与摘要；缺引用或版本缺失报 CORRUPTION，不允许回退最新版'
} as const;
