/**
 * 倾转帧拼合室 —— 领域数据契约。
 *
 * 直接使用电子断层 / tilt-series 领域自身的词汇：
 * 原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、手工排除原因……
 * 禁止把不同概念压成通用 name/value。
 *
 * 所有领域量都携带单位或坐标基准；导入层保留 raw 原始表示，
 * 派生层才做规范化；无法转换的值留在原位置并附 diagnostic，不许丢弃。
 */

export type Digest = string;

/** 内容寻址的不可变原始字节片段（帧像素等），全库只存一份。 */
export interface RawBlob {
  blobId: Digest;
  mediaType: string;
  byteLength: number;
  sha256: Digest;
}

/** 来源材料的领域种类（这就是本领域的“实体词汇表”，不是 name/value）。 */
export type MaterialKind =
  | 'raw-frame'
  | 'tilt-angle'
  | 'pixel-scale'
  | 'exposure-dose'
  | 'fiducial-observation'
  | 'tracking-gap'
  | 'manual-exclusion';

/** 图像坐标基准：原点在左上、X 向右、Y 向下，单位像素。 */
export const IMAGE_PIXEL_UL = 'image-pixel-UL-origin-top-left' as const;

/** 保留原始表示的测量值；value 仅在可规范化时出现，否则 diagnostic 必填。 */
export interface PreservedMeasure {
  /** 导入时逐字保留的原始文本。 */
  raw: string;
  /** 目标规范化单位。 */
  unit: 'degree' | 'nm/px' | 'e-/A^2' | 'pixel' | 'frame-index';
  /** 规范化后的数值；无法转换时为 null。 */
  value: number | null;
  /** 无法转换/可疑时的诊断，留在原位置，绝不静默丢弃。 */
  diagnostic?: string;
}

export interface RawFrameMaterial {
  frameId: string;
  sourceSetId: string;
  /** 该序列中的帧序号（0 起）。 */
  frameIndex: number;
  blobId: Digest;
  widthPx: number;
  heightPx: number;
  /** 像素坐标基准。 */
  coordinateFrame: typeof IMAGE_PIXEL_UL;
  acquiredAt: string;
}

export interface TiltAngleMaterial {
  tiltId: string;
  frameId: string;
  angle: PreservedMeasure;
  /** 角度符号约定（如“机械倾角，逆时针为正”），导入时保留。 */
  signConvention: string;
  referenceLabel: string | null;
}

export interface PixelScaleMaterial {
  scaleId: string;
  scopeFrameId: string | null;
  scale: PreservedMeasure;
  calibrationSource: string;
}

export interface ExposureDoseMaterial {
  doseId: string;
  frameId: string;
  dose: PreservedMeasure;
}

export interface FiducialObservationMaterial {
  observationId: string;
  frameId: string;
  /** 导入文件中的标记标签；它不是轨迹身份，身份由解释层裁定。 */
  label: string;
  x: PreservedMeasure;
  y: PreservedMeasure;
  coordinateFrame: typeof IMAGE_PIXEL_UL;
  uncertaintyPx: number | null;
}

export type GapKind = 'occluded' | 'out-of-field' | 'untracked';

export interface TrackingGapMaterial {
  gapId: string;
  /** 缺口属于哪一条规范轨迹（可在后续解释中被改判）。 */
  canonicalTrackId: string;
  fromFrameIndex: number;
  toFrameIndex: number;
  gapKind: GapKind;
  note: string | null;
}

export type ExclusionReason =
  | 'motion-blur'
  | 'beam-blocked'
  | 'focus-failure'
  | 'dose-too-low'
  | 'cracked-sample'
  | 'other';

export interface ManualExclusionMaterial {
  exclusionId: string;
  frameId: string;
  reason: ExclusionReason;
  note: string;
  author: string;
}

export type MaterialPayload =
  | ({ kind: 'raw-frame' } & RawFrameMaterial)
  | ({ kind: 'tilt-angle' } & TiltAngleMaterial)
  | ({ kind: 'pixel-scale' } & PixelScaleMaterial)
  | ({ kind: 'exposure-dose' } & ExposureDoseMaterial)
  | ({ kind: 'fiducial-observation' } & FiducialObservationMaterial)
  | ({ kind: 'tracking-gap' } & TrackingGapMaterial)
  | ({ kind: 'manual-exclusion' } & ManualExclusionMaterial);

/** 版本化来源材料。同 id 的新版本是对同一材料对象的修订，旧版本永不被覆盖。 */
export interface MaterialVersion {
  id: string;
  kind: MaterialKind;
  sourceSetId: string;
  version: number;
  payload: MaterialPayload;
  contentDigest: Digest;
  createdByEventId: string;
  createdAt: string;
}

/** 解释层：把文件标签映射为规范轨迹身份，并允许身份交换/断裂。 */
export type InterpretationKind =
  | 'identity-assignment'
  | 'track-split'
  | 'track-merge'
  | 'gap-annotation'
  | 'frame-quality'
  | 'axis-prior';

export interface IdentityAssignment {
  interpretationId: string;
  branchId: string;
  version: number;
  kind: 'identity-assignment';
  /** 哪些帧区间内，文件标签 label 属于规范轨迹 canonicalTrackId。 */
  assignments: Array<{
    frameIndexFrom: number;
    frameIndexTo: number;
    label: string;
    canonicalTrackId: string;
    confidence: number;
  }>;
  /** 标记为可疑的标签交换（轨迹身份交换在解释层显式表达）。 */
  suspectedSwaps: Array<{
    frameIndexFrom: number;
    frameIndexTo: number;
    labelA: string;
    labelB: string;
  }>;
  supersededInterpretationId: string | null;
  createdByEventId: string;
  rationale: string;
}

export type Interpretation = IdentityAssignment;

/** 规则版本：轴线策略、同点集比较策略等。规则也是版本化实体。 */
export interface RuleSetVersion {
  ruleId: string;
  version: number;
  body: {
    /** 倾转轴策略：绝不默认固定在图像中心。 */
    tiltAxis: {
      estimateFromTracks: boolean;
      allowAnchorAtImageCenter: boolean;
      eccentricityTolerancePx: number;
    };
    /** 候选比较策略：必须使用相同有效点集，禁止用少帧换低残差。 */
    comparison: {
      requireIdenticalEffectivePointSet: boolean;
      rejectFewerFramesLowerResidual: boolean;
      heldOutTrackIds: string[];
      overfitEvalGainThreshold: number;
    };
    ambiguity: {
      /** 残差差小于该比例视为多解并存。 */
      equivalentResidualRatio: number;
      keepAllEquivalentCandidates: boolean;
    };
  };
  contentDigest: Digest;
  createdByEventId: string;
  note: string;
}

/** 每帧刚体/局部变换结果（像素坐标基准）。 */
export interface FrameTransform {
  frameId: string;
  /** 平移（px）。 */
  shiftXNm: number;
  shiftYNm: number;
  shiftXPx: number;
  shiftYPx: number;
  rotationDeg: number;
  /** 局部形变：相对刚体的残差位移场系数（每个候选参数化不同）。 */
  localCoeffs: number[];
  residualNm: number;
  residualPx: number;
  usedObservations: number;
  excluded: boolean;
}

export type CandidateKind = 'rigid' | 'local-deformation' | 'frame-exclusion';
export type CandidateStatus = 'active' | 'invalidated' | 'superseded' | 'frozen';

export interface RegistrationCandidate {
  candidateId: string;
  branchId: string;
  label: string;
  kind: CandidateKind;
  ruleVersion: number;
  /** 有效帧集合（显式列出，少帧必须能被看出来）。 */
  effectiveFrameIds: string[];
  /** 有效点集指纹：不同候选必须在相同有效点集上比较。 */
  effectivePointSetDigest: Digest;
  pointCount: number;
  /** 拟合轴：永远是估计值 + 偏心量，不允许悄悄等于图像中心。 */
  tiltAxis: {
    angleDeg: number;
    anchorXPx: number;
    anchorYPx: false | number;
    imageCenterXPx: number;
    imageCenterYPx: number;
    eccentricityPx: number;
    anchoredAtImageCenter: boolean;
  };
  transforms: FrameTransform[];
  metrics: {
    trainSseNm2: number;
    evalSseNm2: number;
    trainRmsNm: number;
    evalRmsNm: number;
    totalDoseElectronsPerAngstrom2: number | null;
    angularCoverageDeg: number | null;
    /** 相对刚体基线，留出轨迹上的残差变化；正值=过拟合迹象。 */
    overfitEvalGain: number | null;
  };
  diagnostics: string[];
  equivalentGroupId: string | null;
  status: CandidateStatus;
  createdByEventId: string;
  invalidatedByEventId: string | null;
  invalidationReason: string | null;
}

/** 机器可读事件：判断依据以事件形式落盘，而不是写在自然语言里。 */
export type EventType =
  | 'source-imported'
  | 'source-revised'
  | 'interpretation-branched'
  | 'rule-revised'
  | 'candidate-computed'
  | 'candidate-invalidated'
  | 'candidate-accepted'
  | 'candidate-rejected'
  | 'adjudication-undone'
  | 'registration-locked'
  | 'lock-frozen-rejected'
  | 'parameter-adjusted'
  | 'conflict-detected';

export interface VersionRef {
  kind: MaterialKind | 'rule' | 'interpretation' | 'candidate' | 'event' | 'blob';
  id: string;
  version: number | null;
  contentDigest?: Digest;
}

export interface EventRecord {
  eventId: string;
  branchId: string;
  seq: number;
  type: EventType;
  at: string;
  author: string;
  /** 该事件显式引用的版本；历史重放必须按这些版本，而不是最新版。 */
  refs: VersionRef[];
  payload: unknown;
  prevEventId: string | null;
  /** 链式哈希：prev 哈希 + 规范载荷，保证事件序列可校验。 */
  chainHash: Digest;
}

export interface Branch {
  branchId: string;
  name: string;
  parentBranchId: string | null;
  forkedFromEventId: string | null;
  createdAt: string;
}

export interface LockedRegistration {
  lockId: string;
  branchId: string;
  candidateId: string;
  candidateVersion: number;
  ruleVersion: number;
  lockedAtEventId: string;
  lockedAt: string;
  /** 供重建管线读回的引用句柄。 */
  reconstructionRef: string;
}

/** 查询任一实体时的返回：实体本身 + 它引用的版本号与内容摘要。 */
export interface EntityEnvelope<T> {
  entity: T;
  resolvedAt: string | null;
  references: Array<VersionRef & { resolvedDigest: Digest; missing?: boolean }>;
  corruption: string[];
}

export interface ConflictReport {
  httpStatus: 409;
  code: 'version-conflict' | 'branch-frozen';
  message: string;
  baseHeadEventId: string;
  attemptedHeadEventId: string;
  currentHeadEventId: string;
  /** 双方差异：各自领先的事件。 */
  baseToCurrent: EventRecord[];
  baseToAttempt: EventRecord[];
}
