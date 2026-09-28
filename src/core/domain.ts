// 领域词汇：电子断层 / 倾转序列 / fiducial 轨迹 / 配准分支。
// 所有量都显式携带单位或坐标基准；不使用 name/value 通用表。

export type AngleUnit = 'degree' | 'radian';
export type ScaleUnit = 'nm/pixel' | 'angstrom/pixel' | 'pixel/nm';
export type DoseUnit = 'e-/A^2' | 'e-/nm^2';
// 无法转换的原始单位（例如裸计数，缺少增益因子）原样保留并附诊断。
export type RawDoseUnit = DoseUnit | 'counts';

export interface CoordBasis {
  readonly id: 'image-pixel-top-left';
  readonly origin: 'top-left';
  readonly xAxis: 'right';
  readonly yAxis: 'down';
}
export const IMAGE_PIXEL_BASIS: CoordBasis = {
  id: 'image-pixel-top-left',
  origin: 'top-left',
  xAxis: 'right',
  yAxis: 'down',
};

export type EntityKind =
  | 'raw-frame'
  | 'tilt-angle'
  | 'pixel-scale'
  | 'dose'
  | 'marker-observation'
  | 'track-gap'
  | 'manual-exclusion'
  | 'tilt-axis-model'
  | 'rule-version'
  | 'registration-candidate'
  | 'adjudication'
  | 'reconstruction-lock';

export interface RawFramePayload {
  readonly width: number;
  readonly height: number;
  readonly representation: 'uint8-grayscale-png';
  readonly objectDigest: string; // 不可变原始字节，内容寻址
  readonly byteLength: number;
  readonly originalFilename: string;
}

export interface TiltAnglePayload {
  readonly frameId: string;
  readonly value: number | null; // 规范化值（度）；无法解析时为 null
  readonly unit: AngleUnit;
  readonly originalText: string; // 导入时的原始表示
  readonly uncertaintyDeg?: number;
  readonly parseDiagnostic?: string;
}

export interface PixelScalePayload {
  readonly scope: 'series' | { frameId: string };
  readonly value: number | null;
  readonly unit: ScaleUnit;
  readonly originalText: string;
  readonly conversionDiagnostic?: string;
}

export interface DosePayload {
  readonly frameId: string;
  readonly kind: 'per-frame' | 'cumulative';
  readonly value: number | null; // 规范化到 e-/A^2；无法转换时为 null
  readonly rawValue: number;
  readonly unit: RawDoseUnit;
  readonly originalText: string;
  readonly conversionDiagnostic?: string;
}

export interface MarkerObservationPayload {
  readonly trackId: string;
  readonly segmentId: string; // 同一 track 可因缺口断裂成多个 segment
  readonly frameId: string;
  readonly x: number;
  readonly y: number;
  readonly basis: CoordBasis;
  readonly uncertaintyPx?: number;
  readonly originalText?: string;
}

export type GapReason = 'out-of-field' | 'undetectable' | 'occluded' | 'unknown';

export interface TrackGapPayload {
  readonly trackId: string;
  readonly predecessorSegmentId: string;
  readonly successorSegmentId: string;
  readonly betweenFrameIds: readonly [string, string];
  readonly missingFrameIds: readonly string[];
  readonly reason: GapReason;
}

export interface ManualExclusionPayload {
  readonly frameId: string;
  readonly reason: string;
  readonly author: string;
}

export interface AxisModelPayload {
  // 关键领域判断：轴线是带偏移的直线，centerAssumed=true 仅作为显式标记的对照方案。
  readonly axisAngleDeg: number;
  readonly offset: { readonly x: number; readonly y: number };
  readonly centerAssumed: boolean;
  readonly uncertainty: { readonly angleDeg: number; readonly offsetPx: number };
  readonly evidenceFrameIds: readonly string[];
}

export interface RuleVersionPayload {
  readonly ruleId: 'tomographic-alignment';
  readonly version: number;
  readonly contentDigest: string;
  readonly changelog: string;
  readonly publishedAt: string;
}

export type CandidateStrategy = 'rigid' | 'local-warp' | 'exclude-bad-frames';
export type DiagnosticCode =
  | 'AXIS_CENTER_ASSUMED'
  | 'AXIS_ECCENTRIC'
  | 'TRACK_GAP'
  | 'IDENTITY_SWAP_SUSPECTED'
  | 'MISSING_HIGH_TILT'
  | 'BAD_FRAME_EXCLUDED'
  | 'LOCAL_WARP_OVERFIT'
  | 'MULTIPLE_SOLUTIONS'
  | 'FEWER_FRAMES_LOWER_RESIDUAL'
  | 'UNCONVERTIBLE_VALUE'
  | 'STALE_INPUT'
  | 'BRANCH_FROZEN';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly frameIds?: readonly string[];
  readonly trackIds?: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface FrameTransform {
  // 把观测像素坐标映射回零倾角参考系的 2D 仿射（行主序 3x3 前两行）。
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface PerFrameResidual {
  readonly frameId: string;
  readonly used: boolean;
  readonly residualPx: number;
  readonly excludeReason?: string;
}

export interface AxisSolution {
  readonly axisAngleDeg: number;
  readonly offset: { readonly x: number; readonly y: number };
  readonly rmsPx: number;
}

export interface CandidatePayload {
  readonly strategy: CandidateStrategy;
  readonly ruleVersion: string; // rule-version 实体的 id@version
  readonly solutionCount: number;
  readonly solutionSet: readonly AxisSolution[]; // 无法唯一决定时保留全部合法解
  readonly axis: AxisModelPayload;
  readonly transforms: Readonly<Record<string, FrameTransform>>;
  readonly perFrame: readonly PerFrameResidual[];
  readonly effectiveFrameIds: readonly string[];
  readonly excludedFrameIds: readonly string[];
  readonly parameterCount: number;
  readonly observationCount: number;
  readonly commonSetRmsPx: number; // 在公共有效点集上的 RMS（跨候选比较口径）
  readonly trainingRmsPx: number;
  readonly crossValidationRmsPx: number | null; // 留一帧交叉验证；过拟合检测
  readonly overfit: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export type AdjudicationAction = 'accepted' | 'rejected';

export interface AdjudicationPayload {
  readonly candidateRef: VersionRef;
  readonly action: AdjudicationAction;
  readonly rationale: string;
  readonly author: string;
  readonly supersededEventId?: string; // 撤销时指向被撤销的裁定事件
  readonly rebasedFromEventId?: string; // 冲突后 rebase 记录
}

export interface ReconstructionLockPayload {
  readonly candidateRef: VersionRef;
  readonly reconstructionRef: string; // 供重建管线引用的稳定句柄
  readonly revokedByEventId?: string;
  readonly revokeReason?: string;
}

export type EntityPayload =
  | RawFramePayload
  | TiltAnglePayload
  | PixelScalePayload
  | DosePayload
  | MarkerObservationPayload
  | TrackGapPayload
  | ManualExclusionPayload
  | AxisModelPayload
  | RuleVersionPayload
  | CandidatePayload
  | AdjudicationPayload
  | ReconstructionLockPayload;

// 版本引用：必须精确到版本号。缺少引用 => 档案损坏，不允许退回最新版。
export interface VersionRef {
  readonly entityId: string;
  readonly version: number;
}

export interface EntityReference extends VersionRef {
  readonly kind: EntityKind;
  readonly role: string;
  readonly objectDigest?: string;
}

export type EventKind =
  | 'import-batch'
  | 'rule-published'
  | 'entity-revision'
  | 'branch-forked'
  | 'candidate-computed'
  | 'adjudication'
  | 'adjudication-revoked'
  | 'rebase'
  | 'lock-granted'
  | 'lock-revoked'
  | 'conflict-detected'
  | 'archive-export'
  | 'archive-import'
  | 'rollback-view';

export interface EventRecord {
  readonly id: string;
  readonly seq: number;
  readonly kind: EventKind;
  readonly branch: string;
  readonly author: string;
  readonly comment: string;
  readonly parentEventIds: readonly string[];
  readonly entityId?: string;
  readonly entityVersion?: number;
  readonly payloadDigest: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly conflictWith?: string;
  readonly changeRequestId?: string;
  readonly createdAt: string;
}
