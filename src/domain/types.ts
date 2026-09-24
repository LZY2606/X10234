/**
 * 领域数据契约 —— 直接采用电子断层/倾转序列词汇，
 * 不把实体压成 name/value。所有领域量携带单位或坐标基准。
 */

export type ID = string;

/** 带单位/坐标基准的领域量。原始表示在导入时保留，规范化只发生在派生层。 */
export interface Quantity {
  /** 规范化后的数值（无法转换时为 null，值留在 raw 并附诊断） */
  value: number | null;
  /** 规范化单位（SI 倾向的内部单位），无法转换时为 null */
  unit: string | null;
  /** 坐标/物理基准，例如 px@originTopLeft、nm@specimen */
  basis?: string;
  /** 导入时的原始表示（字符串，逐字保留） */
  raw: string;
  /** 无法转换到规范化单位时为 true，值留在原位且不丢弃 */
  unconvertible?: boolean;
  diagnostic?: string;
}

export interface FrameRef {
  frameId: ID;
  /** 采集顺序（从 0 开始），不等于倾角排序 */
  frameSeq: number;
}

/** 原始帧（版本化的源实体） */
export interface RawFrame extends FrameRef {
  tiltSeriesId: ID;
  /** 指向不可变内容存储（sha256） */
  blobSha: string;
  byteLength: number;
  widthPx: number;
  heightPx: number;
  encoding: 'uint8-raw-mono' | string;
  /** 帧级曝光剂量 */
  dosePerFrame: Quantity;
  sourceVersion: number;
}

/** 倾角（度，显式符号约定） */
export interface TiltAngle {
  tiltSeriesId: ID;
  frameSeq: number;
  angle: Quantity; // unit: deg
  /** 符号约定，例如 +tilt = stage rotated toward +X */
  signConvention: string;
  sourceVersion: number;
}

/** 像素尺度，nm/px，显式基准 */
export interface PixelScale {
  tiltSeriesId: ID;
  scale: Quantity; // nm per px
  magnificationLabel?: string;
  sourceVersion: number;
}

/** 剂量：每帧与累计，单位 e-/Å^2 */
export interface DoseRecord {
  tiltSeriesId: ID;
  frameSeq: number;
  perFrame: Quantity;
  cumulative: Quantity;
  sourceVersion: number;
}

/** fiducial 标记点在某帧上的坐标（px） */
export interface MarkerObservation {
  markerId: ID;
  frameSeq: number;
  xPx: number;
  yPx: number;
  /** 该观测是否在一次跟踪缺口内（缺口处缺失，不产生观测） */
  observed: boolean;
  sourceVersion: number;
}

/** 跟踪缺口：一条轨迹在连续帧区间内断裂 */
export interface TrackGap {
  gapId: ID;
  markerId: ID;
  fromFrameSeq: number;
  toFrameSeq: number;
  reason: string;
  sourceVersion: number;
}

/** 手工排除帧的原因（版本化） */
export interface ManualExclusion {
  exclusionId: ID;
  frameSeq: number;
  reason: string;
  author: string;
  atIso: string;
  /** 是否撤销（撤销保留记录，不删除） */
  revoked?: boolean;
  sourceVersion: number;
}

/**
 * 倾转轴。绝不能被默认固定在图像中心：
 * 截距 a 与方向 theta 都必须有显式来源；缺失时不得回落到中心假设。
 */
export interface TiltAxis {
  branchId: ID;
  /** 轴方向（度，图像坐标基准） */
  orientationDeg: number | null;
  /** 轴在 x（零倾参考帧列方向）上的截距，px；null=未确定，禁止默认 width/2 */
  interceptXPx: number | null;
  basis: 'fiducial-fit' | 'manual' | 'imported' | 'unresolved';
  originFrameSeq: number;
  /** 支持/反对该轴线的 marker 与帧 */
  evidenceMarkerIds: ID[];
  unresolvedReason?: string;
  eventId?: ID;
}

/** 一条 fiducial 轨迹：身份可断裂为多个片段，也可能发生身份交换 */
export interface FiducialTrack {
  markerId: ID;
  branchId: ID;
  /** 片段化轨迹；多于一个片段表示断裂 */
  segments: Array<{ fromFrameSeq: number; toFrameSeq: number }>;
  /** 若该身份与另一身份发生交换，这里记录交换对 */
  swappedWith: ID | null;
  /** 歧义：可能的合法身份集合（多解时保留全部） */
  possibleIdentities: ID[];
  status: 'single' | 'broken' | 'swapped' | 'ambiguous';
  eventId?: ID;
}

export type CandidateKind = 'rigid' | 'local-warp' | 'excluded-frames';

/** 有效点集：不同候选必须在同一有效点集上比较 */
export interface EffectivePointSet {
  pointSetId: ID;
  branchId: ID;
  /** 参与比较的 (markerId, frameSeq) 对 */
  pairs: Array<{ markerId: ID; frameSeq: number }>;
  /** 有效帧集合（排序） */
  frameSeqs: number[];
  /** 被排除帧 */
  excludedFrameSeqs: number[];
}

export interface CandidateParams {
  kind: CandidateKind;
  /** 刚体：全局截距/方向/每帧 2D 仿射系数 */
  axis?: { orientationDeg: number; interceptXPx: number };
  /** 局部形变：每帧仿射（6 系数） */
  perFrameAffine?: Record<number, number[]>;
  excludedFrameSeqs?: number[];
  degreesOfFreedom: number;
}

export interface RegistrationCandidate {
  candidateId: ID;
  branchId: ID;
  pointSetId: ID;
  kind: CandidateKind;
  params: CandidateParams;
  /** 每帧残差（px），用于审阅页逐帧展示 */
  residualsByFrame: Record<number, number>;
  /** 汇总指标 */
  rmsResidualPx: number;
  maxResidualPx: number;
  /** 用于“不用少帧换低残差”的可比性字段 */
  effectivePairCount: number;
  /** 局部形变过拟合标志：自由度相对有效点数过高 */
  overfit: boolean;
  overfitDiagnostic?: string;
  /** 多解：同一拟合的其它合法候选 */
  ambiguousWith?: ID[];
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  provenanceEventIds: ID[];
  createdAtIso: string;
}

export type DecisionKind = 'accept-candidate' | 'reject-candidate' | 'revise-params' | 'revert';

export interface Decision {
  decisionId: ID;
  branchId: ID;
  kind: DecisionKind;
  candidateId?: ID;
  reason: string;
  author: string;
  atIso: string;
  /** 可逆：指向上一裁定，撤销时恢复前一分支 */
  revertsDecisionId?: ID;
  supersededBy?: ID;
  eventId: ID;
}

/** 锁定供重建引用的一版配准 */
export interface LockedRegistration {
  lockId: ID;
  branchId: ID;
  candidateId: ID;
  pointSetId: ID;
  revision: number;
  lockedAtIso: string;
  /** 重建侧引用句柄（稳定身份） */
  reconstructionRef: string;
}

export interface Branch {
  branchId: ID;
  tiltSeriesId: ID;
  parentBranchId: ID | null;
  name: string;
  /** 从哪个事件 fork 出来 */
  forkEventId: ID | null;
  createdAtIso: string;
  /** 分支当前指向的事件（历史游标） */
  headEventId: ID | null;
  /** 乐观锁修订号 */
  revision: number;
  /** 冻结：并发冲突时保留的只读分支快照 */
  frozen?: boolean;
}

/** 失效范围：参数/参考版本变化后受影响的对象 */
export interface InvalidationScope {
  scopeId: ID;
  triggerEventId: ID;
  branchId: ID;
  affectedEntityIds: ID[];
  affectedKinds: string[];
  reason: string;
}
