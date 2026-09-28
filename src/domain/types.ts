/**
 * 领域数据契约（domain vocabulary）。
 *
 * 禁止把一切压成 name/value。输入实体使用电子断层自己的词汇：
 * raw frame / tilt angle / pixel scale / dose / fiducial observation /
 * tracking gap / manual exclusion reason，全部版本化。
 *
 * 所有领域量携带单位或坐标基准（Quantity + unit/basis）。
 * 导入保留原始表示 raw，派生层才规范化 normalized；
 * 无法转换的值留在原位置并附 diagnostics，绝不为了画图而丢弃。
 */

export const ENTITY_KINDS = [
  'tilt_series',
  'tilt_frame',
  'tilt_angle',
  'pixel_scale',
  'dose',
  'fiducial_observation',
  'tracking_gap',
  'manual_exclusion',
  'tilt_axis_hint',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** 带单位 / 坐标基准的领域量；raw 保留导入时的原始表示，normalized 是派生规范化结果。 */
export interface Quantity {
  raw: string;
  unit: string;
  basis?: string;
  normalized?: number;
  convertible: boolean;
}

export interface FrameSize {
  widthPx: number;
  heightPx: number;
}

/** 像素坐标，基准恒为图像左上为原点、x 向右、y 向下。 */
export interface PixelPoint {
  x: number;
  y: number;
  basis: 'image-toplevel-px';
}

export interface TiltSeriesContent {
  label: string;
  frameSize: FrameSize;
  angleConvention: string;
  acquisitionOrder?: number[];
  note?: string;
}

export interface TiltFrameContent {
  seriesId: string;
  sequence: number;
  rawBlobId: string | null;
  rawMediaType: string;
  exposureDoseQuantity?: Quantity;
  note?: string;
}

export interface TiltAngleContent {
  seriesId: string;
  frameSequence: number;
  angle: Quantity; // deg
  acquisitionIndex: number;
}

export interface PixelScaleContent {
  seriesId: string;
  scale: Quantity; // nm per px
  scope?: string;
}

export interface DoseContent {
  seriesId: string;
  frameSequence: number | null; // null = series-level total
  dose: Quantity; // e-/A^2
}

export interface FiducialObservationContent {
  seriesId: string;
  trackId: string;
  frameSequence: number;
  position: PixelPoint;
  /** 该点是否来自被交换/重接的轨迹解释；identity 交换在 tracking_gap 中记录。 */
  confidence: 'auto' | 'manual' | 'inferred';
}

export interface TrackingGapContent {
  seriesId: string;
  trackId: string;
  fromSequence: number;
  toSequence: number;
  kind: 'occlusion' | 'out-of-field' | 'identity-swap' | 'untracked';
  /** identity-swap 时，断裂另一侧接续的轨迹身份（可能不同）。 */
  reconnectedTrackId?: string;
  reason?: string;
}

export interface ManualExclusionContent {
  seriesId: string;
  frameSequence: number;
  reasonCode: 'motion-blur' | 'too-much-drift' | 'high-tilt-unusable' | 'beam-blocked' | 'other';
  reason: string;
  decidedBy: string;
}

export interface TiltAxisHintContent {
  seriesId: string;
  /** 轴线在基准帧图像中的位置与方向；pivot 不允许默认填成图像中心。 */
  pivot: PixelPoint | null;
  angleDeg: number | null;
  /** isDefaultCenter=true 表示“尚未测量、只给了图像中心占位”，规则不允许直接当事实使用。 */
  isDefaultCenter: boolean;
  source: 'measured' | 'prior' | 'default-center-placeholder';
}

export type EntityContent =
  | { kind: 'tilt_series'; value: TiltSeriesContent }
  | { kind: 'tilt_frame'; value: TiltFrameContent }
  | { kind: 'tilt_angle'; value: TiltAngleContent }
  | { kind: 'pixel_scale'; value: PixelScaleContent }
  | { kind: 'dose'; value: DoseContent }
  | { kind: 'fiducial_observation'; value: FiducialObservationContent }
  | { kind: 'tracking_gap'; value: TrackingGapContent }
  | { kind: 'manual_exclusion'; value: ManualExclusionContent }
  | { kind: 'tilt_axis_hint'; value: TiltAxisHintContent };

/** 反例情形（counterexample scenario）。 */
export const SCENARIOS = [
  'axis-eccentricity',
  'track-identity-swap',
  'missing-high-tilt',
  'bad-frame-exclusion',
  'local-warp-overfit',
  'multi-solution',
  'concurrency-freeze',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type RegistrationMethod = 'rigid' | 'local-warp' | 'excluding-bad-frames';

export type CandidateStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded';

export interface PerFrameResidual {
  frameSequence: number;
  valid: boolean;
  residualNm: number;
  nPoints: number;
}

export interface RegistrationCandidateContent {
  seriesId: string;
  method: RegistrationMethod;
  /** 有效帧序列（被排除帧不进入点集）。不同候选必须用相同有效点集比较。 */
  validFrameSequences: number[];
  excludedFrameSequences: number[];
  /** 该候选使用的 fid 观测实体版本集合（相同有效点集比较的依据）。 */
  usedObservationVersionIds: string[];
  axisPivot: PixelPoint;
  axisAngleDeg: number;
  perFrameResidual: PerFrameResidual[];
  rmsNm: number;
  maxNm: number;
  dof: number;
  nConstraints: number;
  /** 多解：无法唯一决定时保留全部合法候选；degreesOfFreedomUnresolved>0 即多解。 */
  degreesOfFreedomUnresolved: number;
  alternativeCount: number;
  warnings: string[];
  scenario?: Scenario;
}

export type EventType =
  | 'import-batch-committed'
  | 'import-batch-rolled-back'
  | 'entity-version-created'
  | 'interpretation-branch-created'
  | 'parameter-revision'
  | 'source-data-change-local'
  | 'candidate-proposed'
  | 'decision-accepted'
  | 'decision-rejected'
  | 'decision-undone'
  | 'registration-locked'
  | 'conflict-detected'
  | 'rule-violation'
  | 'invalidations-computed'
  | 'archive-exported'
  | 'archive-imported'
  | 'corruption-reported'
  | 'scenario-replayed';

export interface EventPayload {
  [key: string]: unknown;
}

export interface EventRecord {
  eventId: string;
  seq: number;
  branchId: string;
  type: EventType;
  atIso: string;
  actor: string;
  payload: EventPayload;
  parentHash: string;
  hash: string;
}

export interface EntityVersionView {
  entityId: string;
  kind: EntityKind;
  versionId: string;
  versionNumber: number;
  branchId: string;
  parentVersionId: string | null;
  status: 'active' | 'superseded';
  content: EntityContent;
  contentDigest: string;
  createdAt: string;
}

export interface CandidateView {
  candidateId: string;
  branchId: string;
  status: CandidateStatus;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  content: RegistrationCandidateContent;
  contentDigest: string;
}

export interface LockView {
  seriesId: string;
  candidateId: string;
  branchId: string;
  lockedAt: string;
  lockedBy: string;
  note: string;
}

export interface InvalidationView {
  id: string;
  branchId: string;
  triggerVersionId: string;
  scopeKind: 'local-only' | 'branch-wide';
  affectedEntityIds: string[];
  affectedCandidateIds: string[];
  reason: string;
  atIso: string;
}
