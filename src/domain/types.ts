// 领域词汇：直接采用电子断层/倾转序列的领域概念，禁止压成 name/value。
// 所有领域量携带单位或坐标基准；导入层保留原始表示，派生层才规范化。

export type EntityKind =
  | 'rawFrame'        // 原始帧（不可变像素字节 + 元信息）
  | 'tiltAngle'       // 倾角（带单位 degree，带倾角方案正负号约定）
  | 'pixelScale'      // 像素尺度（带单位 nm/pixel，含基准）
  | 'dose'            // 曝光剂量（带单位 e-/A^2）
  | 'fiducialMark'    // 标记点在某帧上的坐标（像素坐标基准 + 可选物理坐标）
  | 'trackingGap'     // 跟踪缺口：fiducial 轨迹可断裂
  | 'manualExclusion';// 手工排除原因（坏帧人工决定，版本化）

export type CoordinateBasis = 'image-pixel-top-left' | 'specimen-nm';

export interface WithUnit {
  value: number;
  unit: string; // 例如 'degree'、'nm/pixel'、'e-/A^2'
  /** 原始表示，导入时保留（字符串），例如 "+60.0 deg" */
  rawRepresentation: string;
}

export interface RawFrameSource {
  frameIndex: number;                 // 导入顺序（稳定）
  width: number;
  height: number;
  blobRef: string;                    // 不可变内容寻址 blob 摘要
  acquiredAt?: string;
}

export interface TiltAngleSource {
  frameIndex: number;
  angle: WithUnit;                    // degree
  signConvention: string;             // 例如 'increasing CCW about y, untilted=0'
}

export interface PixelScaleSource {
  scale: WithUnit;                    // nm/pixel
  basis: CoordinateBasis;
  calibratedAtTilt?: number;
}

export interface DoseSource {
  frameIndex: number;
  accumulated: WithUnit;              // 累积剂量 e-/A^2
  perExposure?: WithUnit;
}

export interface FiducialMarkSource {
  trackId: string;                    // 轨迹身份（导入方声明；可能错误→身份交换）
  frameIndex: number;
  x: number;                          // 像素坐标
  y: number;
  basis: CoordinateBasis;
  detectedBy: 'auto' | 'manual';
}

export interface TrackingGapSource {
  trackId: string;
  fromFrameIndex: number;             // 缺口区间（含）
  toFrameIndex: number;
  reason: 'occlusion' | 'out-of-field' | 'detection-failure' | 'untracked';
}

export interface ManualExclusionSource {
  frameIndex: number;
  reason: string;                     // 自由文本，但作为具名领域实体保存
  decidedBy: string;
}

export type SourceBody =
  | { kind: 'rawFrame'; data: RawFrameSource }
  | { kind: 'tiltAngle'; data: TiltAngleSource }
  | { kind: 'pixelScale'; data: PixelScaleSource }
  | { kind: 'dose'; data: DoseSource }
  | { kind: 'fiducialMark'; data: FiducialMarkSource }
  | { kind: 'trackingGap'; data: TrackingGapSource }
  | { kind: 'manualExclusion'; data: ManualExclusionSource };

export interface ImportBundle {
  seriesId: string;
  capturedAt: string;
  sources: SourceBody[];
}

// ---- 稳定身份 ----
// 身份在导出/删除/再导入后保持：身份来自内容与来源，而非行号（行号只决定顺序）。
export interface VersionedEntity {
  entityId: string;      // 稳定实体身份
  kind: EntityKind;
  seriesId: string;
  version: number;       // 同一实体的解释版本，从 1 开始
  predecessorVersion?: number;
  sourceBlob: string;    // 来源原始字节摘要（不可变）
  body: unknown;
  createdAt: string;
  contentDigest: string;
}

// ---- 候选配准（决定实体）----
export type AlignmentModel =
  | 'axis-centered-rigid'      // 轴线默认在图像中心（故意朴素基线，便于反例）
  | 'fitted-axis-rigid'        // 拟合轴线：轴线可偏心
  | 'local-deformable';        // 局部形变（可能过拟合）

export interface AlignmentCandidate {
  candidateId: string;
  parentCandidateId?: string;
  model: AlignmentModel;
  axisX: number;               // 倾转轴在图像中的 x（像素）。不允许静默固定为 width/2
  axisAssumedCenter: boolean;  // true 表示被默认固定在中心（反例诊断用）
  excludedFrames: number[];    // 坏帧排除
  perFrameTransforms: PerFrameTransform[];
  perFrameResidual: Record<number, number>;
  effectiveFrameSet: number[]; // 参与比较的有效点集（候选间必须相同）
  rmsResidual: number;
  degreesOfFreedom: number;
  dataPoints: number;
  overfit: boolean;            // 局部形变自由度 >= 每点约束等启发式诊断
  ambiguity: boolean;          // 是否多解（无法唯一决定）
  ambiguityGroup?: string;     // 同一多解组的候选共享
  diagnostics: string[];
  identitySwaps: IdentitySwap[];
  trackBreaks: TrackBreakView[];
}

export interface PerFrameTransform {
  frameIndex: number;
  // 相对 untilted 帧的 2x3 仿射（图像像素基准）
  a: number; b: number; tx: number;
  c: number; d: number; ty: number;
}

export interface IdentitySwap {
  trackIdA: string;
  trackIdB: string;
  frameRange: [number, number];
  evidence: string;
}

export interface TrackBreakView {
  trackId: string;
  frameRange: [number, number];
  reason: string;
}

export type DecisionKind = 'accept' | 'reject' | 'parameter-revision' | 'conflict';

export interface Adjudication {
  adjudicationId: string;
  candidateId: string;
  branchId: string;
  kind: DecisionKind;
  note: string;
  decidedBy: string;
  createdAt: string;
  /** 乐观并发：基于分支修订号；后提交者冲突 */
  baseRevision: number;
  supersededBy?: string;
}

export interface LockedAlignment {
  candidateId: string;
  branchId: string;
  adjudicationId: string;
  lockedAt: string;
  reconstructionRef: string; // 供重建引用的稳定句柄
}
