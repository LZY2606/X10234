// 领域词汇与事件契约：电子断层 / 倾转序列 / fiducial 配准
// 直接使用领域实体：raw_frame / tilt_angle / pixel_scale / exposure_dose /
// fiducial_observation / track_gap / manual_exclusion / tilt_axis /
// registration_candidate / review_overlay / locked_registration。

export type SourceKind =
  | 'raw_frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'exposure_dose'
  | 'fiducial_observation'
  | 'track_gap'
  | 'manual_exclusion';

export const SOURCE_KINDS: SourceKind[] = [
  'raw_frame',
  'tilt_angle',
  'pixel_scale',
  'exposure_dose',
  'fiducial_observation',
  'track_gap',
  'manual_exclusion',
];

// 带单位 / 坐标基准的领域量。导入时保留原始表示，派生层才规范化。
export interface DomainQuantity {
  value: number | number[] | null;
  unit: string;                 // degree / angstrom/pixel / e-/A^2 / pixel ...
  coordBasis?: string;          // image_origin_top_left@frame:<id> 等
  repr: string;                 // 原始表示，永不丢弃
  normalized?: number | number[]; // 派生层规范化结果
  unconvertible?: { reason: string };
}

export interface PointXY { x: number; y: number; }

// 版本化来源实体（原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、手工排除原因）
export interface SourceEntity {
  id: string;                  // 稳定身份
  kind: SourceKind;
  frameId?: string;            // 该来源所属帧（适用时）
  trackId?: string;            // 该来源所属轨迹（fiducial / gap 时）
  label: string;
  currentVersion: number;
}

export interface SourceVersion {
  id: string;                  // entityId#v<n>
  entityId: string;
  version: number;
  quantity: DomainQuantity;
  blobId?: string;             // 原始字节（帧）内容寻址
  branchId: string;
  eventId: string;
  createdAt: string;
}

// fiducial 观测的结构化坐标（仍是来源层，未做规范化）
export interface FiducialObservationPayload {
  frameId: string;
  trackId: string;
  coord: DomainQuantity;       // unit=pixel
  present: boolean;
}

export interface TrackGapPayload {
  trackId: string;
  fromFrameId: string;
  toFrameId: string;
  reason: string;
}

export interface ManualExclusionPayload {
  frameId: string;
  reason: string;
  reviewer: string;
}

// 倾转轴：禁止默认固定在图像中心
export interface TiltAxisModel {
  axisAngleDeg: number;        // 轴方向角
  offsetPx: number;            // 轴线相对图像中心的有符号偏心（沿法向）
  centerRef: string;           // 坐标基准，必须显式给出，不允许 'assumed-center'
  fixedAtCenter: false;        // 类型层禁止默认居中
}

export type CandidateMethod = 'rigid' | 'local_warp' | 'rigid_excluded_frames';
export type CandidateStatus =
  | 'valid'
  | 'stale'
  | 'rejected'
  | 'adopted'
  | 'locked';

export interface PerFrameResidual {
  frameId: string;
  rmsePx: number;
  nPoints: number;
  excluded: boolean;
}

export interface RegistrationCandidate {
  id: string;
  branchId: string;
  method: CandidateMethod;
  basisRuleVersion: string;    // rules@vN
  axis: TiltAxisModel;
  frameTransforms: Record<string, { tx: number; ty: number }>;
  perFrame: PerFrameResidual[];
  effectiveFrameIds: string[];      // 比较必须使用相同有效点集
  effectivePointKey: string;        // 有效点集指纹
  rmsePx: number;
  holdoutRmsePx?: number;
  dof: number;
  diagnoses: DiagnosisCode[];
  status: CandidateStatus;
  ambiguityGroupId?: string;
  createdAt: string;
}

export type DiagnosisCode =
  | 'AXIS_OFF_CENTER'
  | 'TRACK_IDENTITY_SWAP_SUSPECTED'
  | 'MISSING_HIGH_TILT_FRAMES'
  | 'BAD_FRAME_EXCLUDED'
  | 'LOCAL_WARP_OVERFIT'
  | 'NON_UNIQUE_SOLUTION'
  | 'FEW_FRAMES_RESIDUAL_GAMBIT'
  | 'UNCONVERTIBLE_QUANTITY'
  | 'CORRUPTED_REFERENCE';

export interface Diagnosis {
  code: DiagnosisCode;
  severity: 'info' | 'warning' | 'error';
  detail: string;
  refs: string[];
}

// 机器可读取事件
export type EventType =
  | 'case.imported'
  | 'source.versioned'
  | 'branch.created'
  | 'parameter.revised'
  | 'source.reinterpreted'
  | 'candidate.computed'
  | 'candidate.compared'
  | 'review.decided'
  | 'registration.locked'
  | 'decision.undone'
  | 'dependency.invalidated'
  | 'conflict.detected'
  | 'archive.sealed';

export interface DomainEvent {
  eventId: string;
  seq: number;
  type: EventType;
  branchId: string;
  parentEventId?: string;
  basisVersion: string;            // rules@vN
  payload: unknown;
  createdAt: string;
  createdBy: string;
}

export interface Branch {
  id: string;
  name: string;
  parentBranchId?: string;
  revision: number;
  headSeq: number;
  createdAt: string;
}

export interface DependencyRef {
  refKind: 'source_version' | 'parameter' | 'rule' | 'candidate' | 'blob';
  refId: string;
  refVersion: string;
}

export interface ReviewDecision {
  id: string;
  branchId: string;
  candidateId: string;
  action: 'accept' | 'reject' | 'parameter_adjust';
  note: string;
  reviewer: string;
  eventId: string;
  active: boolean;
  undoneByEventId?: string;
  createdAt: string;
}

export interface LockedRegistration {
  id: string;
  branchId: string;
  candidateId: string;
  eventId: string;
  active: boolean;
  createdAt: string;
}

// 反例档案条目：每个情形保存最小输入 + 组合输入
export type ArchiveCaseKind = 'minimal' | 'composite';
export interface ArchiveCase {
  key: DiagnosisCode;
  kind: ArchiveCaseKind;
  title: string;
  adopted: boolean;
  branchId: string;
  sharedBlobIds: string[];         // 最小/组合共享的不可变原始片段只存一份
  summary: string;
}

export interface EntityRef {
  kind: string;
  id: string;
  version: string;
  contentDigest: string;
}

export interface EntityQueryResult {
  id: string;
  kind: string;
  version: string;
  summary: string;
  refs: EntityRef[];
}

export const CORRUPTION_ERROR = 'CORRUPTED_REFERENCE';
