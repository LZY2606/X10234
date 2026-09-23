// 领域数据契约：直接使用电子断层的领域词汇，而非 name/value 杂烩。
// 三层：原始来源(Source) -> 解释(Interpretation) -> 派生/裁定(Derived)。
// 所有量携带单位或坐标基准；无法转换的值留在原位置并附诊断。

export type AngleUnit = 'deg' | 'rad';
export type LengthUnit = 'nm' | 'um' | 'pixel' | 'A';
export type DoseUnit = 'e/A^2' | 'e/nm^2';
export type CoordinateBasis = 'pixel-index' | 'binned-pixel' | 'stage';

/** 保留原始表示的有量数值；canonical 是派生层规范化结果，缺失则不可用于画图/计算。 */
export interface MeasuredValue {
  value: number | string;          // 原始表示（导入时保留）
  rawText: string;                 // 原始文本
  unit: string;                    // 原始单位
  canonical?: number;              // 规范化数值（派生层）
  canonicalUnit?: string;          // 规范化单位
  diagnostic?: string;             // 无法转换时留在原位置的诊断
}

export type BlobKind = 'frame-grayscale-f32';

export interface ContentBlobRef {
  blobId: string;                  // 内容寻址 sha256
  mediaType: BlobKind | string;
  byteLength: number;
  sha256: string;
}

// ---------------- 输入实体（全部版本化） ----------------

export interface TiltSeries {
  kind: 'TiltSeries';
  uid: string;
  label: string;
  frameIds: string[];
  binning: number;
  imageSize: [number, number];
  createdAt: string;
}

export interface Frame {
  kind: 'Frame';
  uid: string;
  seriesId: string;
  index: number;                   // 采集顺序（稳定）
  blob: ContentBlobRef;
  exposureOrder: number;
}

export interface TiltAngleRecord {
  kind: 'TiltAngle';
  uid: string;
  seriesId: string;
  frameId: string;
  angle: MeasuredValue;            // canonicalUnit=deg
}

export interface PixelScaleRecord {
  kind: 'PixelScale';
  uid: string;
  seriesId: string;
  scale: MeasuredValue;            // canonicalUnit=nm/pixel
}

export interface DoseRecord {
  kind: 'Dose';
  uid: string;
  seriesId: string;
  frameId: string;
  dose: MeasuredValue;             // canonicalUnit=e/A^2
}

export interface MarkerObservation {
  kind: 'MarkerObservation';
  uid: string;
  trackId: string;
  frameId: string;
  x: MeasuredValue;                // canonicalUnit=pixel
  y: MeasuredValue;
  basis: CoordinateBasis;
}

/** fiducial 轨迹可断裂、且可能身份交换：用片段(segment)表达断裂，用身份事件表达交换。 */
export interface FiducialTrack {
  kind: 'FiducialTrack';
  uid: string;
  seriesId: string;
  trackCode: string;               // 人类可读稳定代号 T1..
  segmentIds: string[];            // 断裂后的片段，有序
}

export interface TrackSegment {
  kind: 'TrackSegment';
  uid: string;
  trackId: string;
  sequence: number;
  observationIds: string[];        // 连续可见的标记点观测
}

export interface TrackingGap {
  kind: 'TrackingGap';
  uid: string;
  seriesId: string;
  trackId: string;
  betweenFrameIds: [string, string];
  reason: 'occlusion' | 'out-of-field' | 'low-dose' | 'untracked';
  note?: string;
}

/** 身份交换：同一物理金粒在两段被赋予不同轨迹代号（或反之）。 */
export interface IdentitySwap {
  kind: 'IdentitySwap';
  uid: string;
  seriesId: string;
  segmentAId: string;
  segmentBId: string;
  betweenFrameIds: [string, string];
}

export interface ExclusionReason {
  kind: 'ExclusionReason';
  uid: string;
  seriesId: string;
  frameId?: string;
  observationId?: string;
  reason: 'bad-frame' | 'motion-blur' | 'high-tilt-missing' | 'manual';
  note: string;
  author: string;
}

// ---------------- 决定实体（解释层） ----------------

/** 倾转轴：绝不能默认固定在图像中心。 */
export interface TiltAxisModel {
  kind: 'TiltAxisModel';
  uid: string;
  seriesId: string;
  /** 轴线在零倾角图像坐标下的经过点（pixel），显式偏心。 */
  originX: number;
  originY: number;
  /** 轴线方向角（deg，相对图像 x 轴）。 */
  angleDeg: number;
  assumedCenter: boolean;          // true 表示错误地假设为图像中心
  ruleVersion: string;
}

export type CandidateStrategy =
  | 'rigid-body'
  | 'local-warp'
  | 'rigid-drop-badframes'
  | 'axis-eccentric-rigid';

export type CandidateStatus = 'proposed' | 'accepted' | 'rejected' | 'locked' | 'ambiguous';

export interface PerFrameResidual {
  frameId: string;
  meanPx: number;
  maxPx: number;
  used: boolean;
}

export interface RegistrationCandidate {
  kind: 'RegistrationCandidate';
  uid: string;
  seriesId: string;
  strategy: CandidateStrategy;
  /** 有效点集的内容哈希；不同候选必须用相同有效点集才能比较。 */
  effectiveSetHash: string;
  effectiveFrameIds: string[];
  effectiveObservationIds: string[];
  droppedFrameIds: string[];
  axisModelId: string;
  rmsPx: number;
  maxPx: number;
  perFrame: PerFrameResidual[];
  /** 局部形变专用：训练误差 vs 交叉验证误差，用于识别过拟合。 */
  trainRmsPx?: number;
  crossValidationRmsPx?: number;
  degreesOfFreedom: number;
  status: CandidateStatus;
  ruleVersion: string;
  ambiguityNote?: string;
}

export interface Adjudication {
  kind: 'Adjudication';
  uid: string;
  seriesId: string;
  candidateId: string;
  decision: 'accept' | 'reject' | 'lock' | 'undo';
  author: string;
  note: string;
  /** 被撤销/恢复的前一裁定事件 id。 */
  supersedesEventId?: string;
}

/** 机器可读的判断依据事件。 */
export interface RationaleEvent {
  kind: 'Rationale';
  uid: string;
  seriesId: string;
  code:
    | 'axis-must-not-default-center'
    | 'tracks-may-break-and-swap'
    | 'compare-on-same-effective-set'
    | 'no-fewer-frames-for-lower-residual'
    | 'keep-all-valid-solutions'
    | 'concurrent-failure-is-rejected';
  subjectRefs: string[];           // 稳定身份
  detail: Record<string, unknown>;
}

export type Entity =
  | TiltSeries | Frame | TiltAngleRecord | PixelScaleRecord | DoseRecord
  | MarkerObservation | FiducialTrack | TrackSegment | TrackingGap | IdentitySwap
  | ExclusionReason | TiltAxisModel | RegistrationCandidate | Adjudication | RationaleEvent;

// ---------------- 事件溯源 ----------------

export type EventType =
  | 'bundle.imported'
  | 'interpretation.created'
  | 'rule.revised'
  | 'candidate.proposed'
  | 'adjudication.made'
  | 'scenario.registered';

export interface EventRecord {
  eventId: string;                 // 内容寻址，导入导出稳定
  branchId: string;
  seq: number;
  parentEventId: string | null;
  type: EventType;
  at: string;
  author: string;
  payload: Record<string, unknown>;
  /** 该事件写入/失效的实体 uid -> 内容摘要。 */
  upserts: Record<string, string>;
  /** 该事件直接引用的来源（事件 id 或 blob id）。 */
  sources: string[];
}

export interface Branch {
  branchId: string;
  label: string;
  parentBranchId: string | null;
  forkFromEventId: string | null;
  headEventId: string | null;
  headSeq: number;
  createdAt: string;
  scenarioCode?: ScenarioCode;
}

export type ScenarioCode =
  | 'axis-eccentricity'
  | 'track-identity-swap'
  | 'missing-high-tilt'
  | 'bad-frame-exclusion'
  | 'local-warp-overfit'
  | 'multiple-solutions'
  | 'concurrent-freeze';

export interface ScenarioManifest {
  code: ScenarioCode;
  title: string;
  minimalInputRef: string;         // bundle blob id（最小输入）
  combinedInputRef: string;        // bundle blob id（组合输入）
}

export interface ExportBundle {
  format: 'tilt-assembly-room/archive';
  version: 1;
  exportedAt: string;
  branches: Branch[];
  events: EventRecord[];
  blobs: Record<string, { mediaType: string; byteLength: number; sha256: string }>;
  /** blob 字节以 base64 分开存储，避免巨大 JSON */
  blobDataBase64: Record<string, string>;
}
