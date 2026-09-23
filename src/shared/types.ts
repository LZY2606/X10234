/**
 * 倾转帧拼合室领域词汇。
 * 所有领域量携带单位或坐标基准；原始表示在导入层保留，派生层才做规范化。
 */

export type AngleUnit = 'degree' | 'radian';
export type LengthUnit = 'nm' | 'um' | 'pixel';
export type ScaleUnit = 'nm_per_pixel' | 'um_per_pixel';
export type DoseUnit = 'e_per_angstrom2' | 'e_per_nm2' | 'counts';

export interface RawRepresentation {
  /** 原始文件中的字面表示，规范化失败时也保留 */
  rawText: string;
  /** 来源文件的逻辑路径（案例包内相对路径） */
  sourcePath: string;
  /** 来源行号（1 起） */
  sourceLine: number;
}

export interface UnitValue<V = number, U extends string = string> {
  value: V;
  unit: U;
}

/** 原始帧（图像字节不可变，按 sha256 去重） */
export interface FrameEntity {
  frameId: string;
  blobSha256: string;
  encoding: 'gsbfrm1' | 'png_ext_ref';
  widthPx: number;
  heightPx: number;
  /** 采集序号（倾转序列中的顺序，从 0 起） */
  acquisitionIndex: number;
  acquisitionLabel: string;
  raw: RawRepresentation;
}

/** 倾角 */
export interface TiltAngleEntity {
  tiltId: string;
  frameId: string;
  angle: UnitValue<number, AngleUnit>;
  /** 无法转换时 value 为 null，诊断保留在原位置 */
  convertible: boolean;
  raw: RawRepresentation;
}

/** 像素尺度（坐标基准：像平面 x/y） */
export interface PixelScaleEntity {
  scaleId: string;
  frameId: string | null;
  x: UnitValue<number, ScaleUnit>;
  y: UnitValue<number, ScaleUnit>;
  referenceBasis: 'image_plane_pixel';
  convertible: boolean;
  raw: RawRepresentation;
}

/** 曝光剂量 */
export interface DoseEntity {
  doseId: string;
  frameId: string;
  dose: UnitValue<number, DoseUnit>;
  convertible: boolean;
  raw: RawRepresentation;
}

/** fiducial 标记点在某帧上的观测；轨迹可断裂、可身份交换 */
export interface FiducialObservationEntity {
  observationId: string;
  trackId: string;
  frameId: string;
  x: UnitValue<number, 'pixel'>;
  y: UnitValue<number, 'pixel'>;
  coordinateBasis: 'image_top_left_xy';
  raw: RawRepresentation;
}

/** 跟踪缺口：某轨迹在某帧缺失（不是坏帧，缺口本身是事实） */
export interface TrackGapEntity {
  gapId: string;
  trackId: string;
  frameId: string;
  gapKind: 'occlusion' | 'out_of_field' | 'untracked';
  note: string;
  raw: RawRepresentation;
}

/** 手工排除原因：不删除原始帧，只登记排除 */
export interface ExclusionEntity {
  exclusionId: string;
  frameId: string;
  reasonCode: 'drift_jump' | 'too_large_tilt_gap' | 'exposure_fault' | 'manual';
  reason: string;
  author: string;
  raw: RawRepresentation;
}

/** 规则参数（可修订，旧候选仍引用旧规则版本） */
export interface RuleParamsEntity {
  ruleParamsId: string;
  /** 倾角搜索半宽（度） */
  angleSearchHalfWidthDeg: number;
  /** 局部形变阶数上限 */
  localWarpMaxOrder: number;
  /** 过拟合判定：每有效观测参数数超过该比例 */
  overfitParamPerObsRatio: number;
  /** 多解判定：候选间归一化残差差小于该阈值 */
  ambiguityResidualEpsilon: number;
  note: string;
}

export type MaterialKind =
  | 'frame'
  | 'tilt'
  | 'pixel_scale'
  | 'dose'
  | 'fiducial'
  | 'gap'
  | 'exclusion'
  | 'rule_params';

export type DomainEntity =
  | FrameEntity
  | TiltAngleEntity
  | PixelScaleEntity
  | DoseEntity
  | FiducialObservationEntity
  | TrackGapEntity
  | ExclusionEntity
  | RuleParamsEntity;

export type RegistrationKind = 'rigid' | 'local_warp' | 'exclusion';

export interface PerFrameResidual {
  frameId: string;
  rmsPx: number;
  maxPx: number;
  observationCount: number;
  excluded: boolean;
}

export interface RegistrationParams {
  /** 有效倾角零位（度），倾转轴不必经过图像中心 */
  tauDeg: number;
  /** 轴在像平面内的方向角（度） */
  phiDeg: number;
  /** 轴线截距（px，沿垂直于轴方向），显式允许非零 => 轴线偏心 */
  axisInterceptPx: number;
  /** 每条轨迹的三维标记坐标 {x,y,z}（基准：轴坐标系） */
  perTrack: Record<string, { xPx: number; yPx: number; zPx: number }>;
  /** 每帧二维平移（px） */
  perFrameShift: Record<string, { dxPx: number; dyPx: number }>;
  /** 局部形变（仅 local_warp）：每帧低阶系数 */
  localWarpCoeffs?: Record<string, number[]>;
}

export type CandidateStatus = 'proposed' | 'accepted' | 'rejected' | 'invalidated' | 'superseded';

export interface RegistrationCandidate {
  candidateId: string;
  kind: RegistrationKind;
  branchId: string;
  ruleVersionId: string;
  /** 有效帧集合（被排除帧 excludedFrames 不在其中） */
  effectiveFrames: string[];
  /** 公平比较用：相同有效点集的稳定指纹 */
  effectivePointSetHash: string;
  excludedFrames: string[];
  params: RegistrationParams;
  residualPerFrame: PerFrameResidual[];
  rmsePx: number;
  /** 自由度调整后残差（防止用少帧换低残差） */
  adjustedRmsePx: number;
  parameterCount: number;
  observationCount: number;
  ambiguousWith: string[];
  overfit: boolean;
  diagnostics: Diagnostic[];
  status: CandidateStatus;
  /** 输入物料版本引用，查询时必须解析得到 */
  inputMaterialVersions: Record<MaterialKind, string | null>;
  createdAtEventSeq: number;
}

export type DiagnosticCode =
  | 'AXIS_OFF_CENTER'
  | 'IDENTITY_SWAP_SUSPECTED'
  | 'MISSING_HIGH_TILT_FRAME'
  | 'BAD_FRAME_EXCLUDED'
  | 'LOCAL_WARP_OVERFIT'
  | 'MULTIPLE_SOLUTIONS'
  | 'CONCURRENT_FROZEN'
  | 'UNCONVERTIBLE_VALUE_KEPT'
  | 'UNFAIR_POINT_SET'
  | 'RANK_DEFICIENT';

export interface Diagnostic {
  diagnosticId: string;
  code: DiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  affectedObjectIds: string[];
}

export type EventType =
  | 'CASE_IMPORTED'
  | 'MATERIAL_VERSION_COMMITTED'
  | 'RULE_PARAMS_REVISED'
  | 'BRANCH_FORKED'
  | 'CANDIDATES_PROPOSED'
  | 'CANDIDATE_ACCEPTED'
  | 'CANDIDATE_REJECTED'
  | 'DECISION_REVOKED'
  | 'REGISTRATION_LOCKED'
  | 'LOCK_REVOKED'
  | 'DEPENDENCIES_INVALIDATED'
  | 'IDENTITY_SWAP_REINTERPRETED'
  | 'CONFLICT_DETECTED'
  | 'SESSION_FROZEN'
  | 'ARCHIVE_EXPORTED'
  | 'ARCHIVE_IMPORTED';

export interface ChamberEvent<
  T extends EventType = EventType,
  P extends Record<string, unknown> = Record<string, unknown>
> {
  eventId: string;
  seq: number;
  branchId: string;
  type: T;
  actor: string;
  at: string;
  payload: P;
  /** 来源链：该事件依赖的事件/版本，审阅者可逐级反查 */
  provenance: {
    parentEventIds: string[];
    materialVersionIds: string[];
    ruleVersionId: string | null;
  };
}

export interface Branch {
  branchId: string;
  label: string;
  parentBranchId: string | null;
  forkedFromSeq: number | null;
  headSeq: number;
}

export interface Decision {
  decisionId: string;
  branchId: string;
  candidateId: string;
  action: 'accepted' | 'rejected';
  reason: string;
  eventSeq: number;
  revokedAtEventSeq: number | null;
  supersedesDecisionId: string | null;
}

export interface RegistrationLock {
  lockId: string;
  branchId: string;
  candidateId: string;
  decisionId: string;
  active: boolean;
  revokedAtEventSeq: number | null;
  reconstructionRef: string;
}

export interface FrozenSession {
  sessionId: string;
  branchId: string;
  frozenAtSeq: number;
  label: string;
  createdAt: string;
}

/** 查询任一实体的返回：稳定身份 + 引用版本号 + 内容摘要；缺引用 => CORRUPT */
export interface EntityEnvelope<T = unknown> {
  id: string;
  kind: string;
  versionId: string | null;
  versionSeq: number | null;
  contentSummary: string;
  references: { kind: string; id: string; versionId: string }[];
  entity: T;
}

export interface CorruptionError {
  code: 'CORRUPT_REFERENCE';
  message: string;
  missing: { kind: string; id: string; versionId: string | null };
}

export interface ReviewState {
  seriesId: string;
  branchId: string;
  headSeq: number;
  viewingSeq: number;
  frames: FrameEntity[];
  tilts: TiltAngleEntity[];
  scales: PixelScaleEntity[];
  doses: DoseEntity[];
  observations: FiducialObservationEntity[];
  gaps: TrackGapEntity[];
  exclusions: ExclusionEntity[];
  ruleParams: RuleParamsEntity | null;
  candidates: RegistrationCandidate[];
  events: ChamberEvent[];
  branches: Branch[];
  decisions: Decision[];
  lock: RegistrationLock | null;
  diagnostics: Diagnostic[];
  sessions: FrozenSession[];
}
