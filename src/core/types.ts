/**
 * 倾转帧拼合室 —— 领域词汇与数据契约
 *
 * 所有键名使用电子断层领域自身的词汇（原始帧/倾角/像素尺度/剂量/fiducial 标记/
 * 跟踪缺口/手工排除/分支/候选/裁定/锁定）。禁止把异质量压成 name/value。
 */

/** 带单位或坐标基准的量；导入时保留 raw，派生层才规范化，无法转换留在原位并附诊断 */
export interface QuantifiedValue {
  raw: string;
  value: number | null;
  unit: string;
  targetUnit?: string;
  diagnostic?: string;
}

/** 稳定坐标基准：像素坐标必须声明帧与归一化/像素约定，物理坐标必须声明参考系 */
export interface CoordinateBasis {
  frame: "fractional" | "pixel";
  origin: "top-left" | "tilt-axis";
  referenceFrameId?: string;
}

export type TiltDirection = "untilted" | "positive" | "negative";

/** 原始帧（内容寻址，不可变；合成像素数据另存 blob） */
export interface TiltFrameSource {
  kind: "TiltFrame";
  frameId: string;
  ordinal: number;
  exposureIndex: number;
  width: number;
  height: number;
  blobSha256: string;
  mediaType: string;
  acquiredNote?: string;
}

/** 倾角（原始表示 + 规范化弧度/度） */
export interface TiltAngleSource {
  kind: "TiltAngle";
  frameId: string;
  angle: QuantifiedValue;
  direction: TiltDirection;
}

/** 像素尺度（每像素纳米，保留原始单位） */
export interface PixelScaleSource {
  kind: "PixelScale";
  frameId: string;
  nmPerPixel: QuantifiedValue;
}

/** 曝光剂量（e−/Å²） */
export interface ExposureDoseSource {
  kind: "ExposureDose";
  frameId: string;
  electronsPerSquareAngstrom: QuantifiedValue;
}

/** fiducial 标记点坐标：身份是轨迹身份，轨迹可断裂、可发生身份交换 */
export interface MarkerObservationSource {
  kind: "MarkerObservation";
  frameId: string;
  trackId: string;
  segmentId: string;
  x: QuantifiedValue;
  y: QuantifiedValue;
  basis: CoordinateBasis;
  confidence: number;
}

/** 跟踪缺口：该轨迹在 [fromFrameId, toFrameId] 之间断裂 */
export interface TrackingGapSource {
  kind: "TrackingGap";
  gapId: string;
  trackId: string;
  fromFrameId: string;
  toFrameId: string;
  reason: string;
}

/** 手工排除原因（可撤销，保留版本） */
export interface ManualExclusionSource {
  kind: "ManualExclusion";
  frameId: string;
  reasonCode: string;
  reason: string;
}

export type SourceEntity =
  | TiltFrameSource
  | TiltAngleSource
  | PixelScaleSource
  | ExposureDoseSource
  | MarkerObservationSource
  | TrackingGapSource
  | ManualExclusionSource;

export type SourceKind = SourceEntity["kind"];

/** 一次导入的来源批次（原子；失败整体回滚） */
export interface SourceBatch {
  batchId: string;
  importedAt: string;
  label: string;
  entities: SourceEntity[];
  blobs?: { sha256: string; bytes: Uint8Array }[];
}

/** 对同一材料的重新解释：新建分支，旧分支/裁定/字节仍可读 */
export interface BranchRecord {
  branchId: string;
  parentBranchId: string | null;
  label: string;
  createdAt: string;
  basisRuleSetVersion: string;
  note: string;
}

export type CommitKind =
  | "import"
  | "parameter-revision"
  | "source-revision-local"
  | "candidate-generated"
  | "decision"
  | "decision-reverted"
  | "lock"
  | "unlock"
  | "conflict"
  | "diagnostic";

export interface CommitRecord {
  commitId: string;
  branchId: string;
  parentCommitId: string | null;
  kind: CommitKind;
  createdAt: string;
  author: string;
  message: string;
  /** 该提交采用的规则集版本 */
  ruleSetVersion: string;
  /** 乐观锁：分支当前头提交 */
  expectedParentCommitId: string | null;
}

export type TransformKind = "rigid" | "local-warp" | "bad-frame-exclusion";

/** 每帧刚体参数（绕轴线点的 2D 相似变换） */
export interface FrameTransform {
  frameId: string;
  /** 轴线在该帧的位置 —— 绝不默认图像中心 */
  axisX: number;
  axisY: number;
  /** 轴线倾角（图像坐标系内，弧度） */
  axisAngle: number;
  tx: number;
  ty: number;
  rotation: number;
  scale: number;
  /** 局部形变时的附加位移场（稀疏控制点），刚体为空 */
  warpControlPoints?: { x: number; y: number; dx: number; dy: number }[];
}

export type CandidateStatus =
  | "legal"
  | "ambiguous"
  | "overfit-rejected"
  | "invalid-point-set";

/** 配准候选：不同候选必须用相同有效点集比较，禁止用少帧换低残差 */
export interface AlignmentCandidate {
  candidateId: string;
  branchId: string;
  commitId: string;
  label: string;
  transformKind: TransformKind;
  effectiveFrameIds: string[];
  effectiveTrackIds: string[];
  effectivePointKey: string;
  transforms: FrameTransform[];
  perFrameResidual: Record<string, number>;
  meanResidual: number;
  maxResidual: number;
  excludedFrameIds: string[];
  status: CandidateStatus;
  diagnostics: string[];
  /** 多解：同一有效点集下并列合法候选时非空 */
  ambiguityFamilyId: string | null;
  overfitRatio: number | null;
  freeParameterCount: number;
  observationCount: number;
}

export type DecisionKind = "accept" | "reject" | "parameter-adjust";

export interface DecisionRecord {
  decisionId: string;
  branchId: string;
  commitId: string;
  candidateId: string | null;
  kind: DecisionKind;
  rationale: string;
  revertedDecisionId: string | null;
  createdAt: string;
}

export interface LockedAlignment {
  lockId: string;
  branchId: string;
  candidateId: string;
  commitId: string;
  lockedAt: string;
  reconstructionRef: string;
  active: boolean;
}

/** 机器可读事件：判断依据写成事件而非注释 */
export interface LedgerEvent {
  eventId: string;
  branchId: string;
  commitId: string;
  semanticKind:
    | "import.batched"
    | "import.rolled-back"
    | "interpretation.branched"
    | "rule.axis-not-centered"
    | "rule.track-break-allowed"
    | "rule.identity-swap-hypothesis"
    | "rule.common-effective-point-set"
    | "rule.no-fewer-frames-lower-residual"
    | "rule.ambiguous-all-candidates-retained"
    | "rule.overfit-rejected"
    | "rule.bad-frame-exclusion"
    | "rule.missing-high-tilt"
    | "axis.eccentric-fit"
    | "track.identity-swapped"
    | "frame.missing-high-tilt"
    | "frame.excluded-bad"
    | "warp.overfit"
    | "candidate.ambiguous"
    | "candidate.generated"
    | "decision.accepted"
    | "decision.rejected"
    | "decision.reverted"
    | "decision.parameter-adjusted"
    | "alignment.locked"
    | "alignment.unlocked"
    | "concurrency.conflict"
    | "dependency.invalidated-scope"
    | "integrity.dangling-reference"
    | "diagnostic.unconvertible-value";
  subjectId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ScenarioFixture {
  scenario:
    | "axis-eccentricity"
    | "identity-swap"
    | "missing-high-tilt"
    | "bad-frame-exclusion"
    | "local-warp-overfit"
    | "multi-solution"
    | "concurrent-freeze";
  variant: "minimal" | "combined";
}
