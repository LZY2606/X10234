/**
 * 领域数据契约：直接采用电子断层 / tilt-series 词汇，
 * 不把领域量压成 name/value。
 *
 * 所有领域量都携带单位或坐标基准；导入层保留原始表示（raw + rawUnit），
 * 规范化只发生在派生层（normalized）。无法转换的值留在原位置并附诊断。
 */

/** 有单位的领域量：原始表示 + 派生层规范化结果。无法转换时 normalized 为 null 并附诊断。 */
export interface DomainQuantity {
  /** 导入时的原始数值（未转换）。 */
  raw: number | null;
  /** 原始表示使用的单位/基准，逐字保留。 */
  rawUnit: string;
  /** 派生层规范化后的数值；无法转换时为 null。 */
  normalized: number | null;
  /** 规范化目标单位。 */
  normalizedUnit: string;
  /** 无法转换等诊断；空数组表示正常。 */
  diagnostics: string[];
}

/** 带坐标基准的二维点（fiducial 标记点坐标）。 */
export interface FiducialCoordinate {
  /** 帧内横坐标原始值。 */
  x: DomainQuantity;
  /** 帧内纵坐标原始值。 */
  y: DomainQuantity;
  /** 坐标基准：pixel_index（0 基像素列/行）、pixel_center、micron 等。 */
  frame: string;
  /** 观察质量：可见 / 遮挡 / 外推；外推点不进入有效点集。 */
  quality: 'observed' | 'occluded' | 'inferred';
  /** 观察者给出的置信度 0..1（可为 null）。 */
  confidence: number | null;
}

/** 倾转序列中的一帧原始帧引用（字节内容寻址）。 */
export interface RawFrame {
  frameId: string;
  /** 帧序号（导入顺序，稳定）。 */
  sequenceIndex: number;
  /** 原始字节内容哈希（blake3 风格 key，此处用 sha256 hex）。 */
  blobHash: string;
  byteLength: number;
  mediaType: string;
  width: number;
  height: number;
  /** 像素字节布局描述（案例包自有格式，见 cases/README）。 */
  pixelEncoding: string;
}

export type FrameNodeKind =
  | 'raw_frame'
  | 'tilt_angle'
  | 'pixel_scale'
  | 'exposure_dose'
  | 'fiducial_coordinate'
  | 'tracking_gap'
  | 'manual_exclusion';

/** 跟踪缺口：某轨迹在一个连续帧区间不可用，可断裂。 */
export interface TrackingGap {
  trackId: string;
  /** 缺口起始帧（含）。 */
  fromFrame: string;
  /** 缺口结束帧（含）。 */
  toFrame: string;
  reason: 'out_of_field' | 'occluded' | 'low_contrast' | 'unlinked';
  note: string;
}

/** 手工排除原因（评审人对单帧/单点的排除意见，进入来源层版本化）。 */
export interface ManualExclusion {
  targetFrame: string | null;
  targetTrack: string | null;
  reason: string;
  decidedBy: string;
}

/** 倾转轴描述：明确不默认固定在图像中心。 */
export interface TiltAxisSpec {
  /** 轴线在帧坐标系中的基准点 x（像素，可为 null 表示未测定）。 */
  x0: number | null;
  /** 轴线基准点 y（像素）。 */
  y0: number | null;
  /** 轴线相对图像 y 轴的方向角（度）。 */
  angleDeg: number | null;
  /** 坐标基准，例如 pixel_index@frame。 */
  coordinateBasis: string;
  /** x0/y0 是否由拟合自由确定；false 表示外部假定（如默认中心，须被规则否决）。 */
  freeOrigin: boolean;
  /** 来源事件 id。 */
  sourceEventId: string | null;
}

/** 候选配准方案。 */
export interface RegistrationCandidate {
  candidateId: string;
  branchId: string;
  label: string;
  method: 'rigid' | 'local_warp' | 'rigid_drop_frames';
  /** 该候选实际使用的有效帧 id 集合（排序后比较）。 */
  effectiveFrameIds: string[];
  /** 有效 (frame,track) 点集合的稳定哈希——不同候选必须用相同有效点集比较。 */
  effectivePointSetHash: string;
  /** 每帧残差（像素，规范化基准）。 */
  perFrameResidual: Record<string, number>;
  /** 加权 RMS 残差（像素）。 */
  rmsResidual: number;
  /** 有效观测点数。 */
  pointCount: number;
  /** 轴线是否自由拟合（偏心检验）。 */
  axisFree: boolean;
  /** 局部形变方案的自由度 / 控制点数量；刚体为 0。 */
  warpDof: number;
  /** 过拟合诊断：留一交叉验证 RMS 与训练 RMS 之比；null 表示不适用。 */
  overfitRatio: number | null;
  /** 候选诊断（过拟合、少帧换低残差、多解等）。 */
  diagnostics: CandidateDiagnostic[];
  /** 是否为合法可裁定候选。 */
  admissible: boolean;
  /** 不可采纳原因代码。 */
  rejectionCodes: string[];
  /** 多解家族：同一有效点集出现等价解时共享 familyId。 */
  ambiguityFamilyId: string | null;
}

export interface CandidateDiagnostic {
  code:
    | 'axis_assumed_center'
    | 'track_identity_swap'
    | 'missing_high_tilt_frames'
    | 'dropped_frame'
    | 'local_warp_overfit'
    | 'unequal_point_set'
    | 'fewer_frames_lower_residual'
    | 'ambiguous_solution'
    | 'unconvertible_quantity'
    | 'dangling_reference';
  severity: 'info' | 'warning' | 'error';
  message: string;
  frames: string[];
  tracks: string[];
}

/** 裁定（接受 / 否定 / 参数调整都生成新事件，可撤销恢复前一分支）。 */
export interface Adjudication {
  decisionId: string;
  candidateId: string;
  verdict: 'accepted' | 'rejected' | 'parameter_change';
  decidedBy: string;
  rationale: string;
  baseVersion: number;
  /** 撤销时指向被恢复的前一分支。 */
  undone: boolean;
  /** 参数调整时的新参数快照（方法无关的解释版本引用）。 */
  parameterPatch: Record<string, unknown> | null;
}

/** 事件（机器可读判断依据）。查询任一实体都返回其引用的版本与内容摘要。 */
export interface LabEvent {
  eventId: string;
  seq: number;
  kind: EventKind;
  at: string;
  actor: string;
  branchId: string;
  payload: Record<string, unknown>;
  /** 该事件写入时引用的全部 (nodeKind,nodeId,version)。 */
  refs: EventRef[];
  /** 内容摘要（规范化 JSON 的 sha256 前 16 位），用于稳定身份。 */
  digest: string;
}

export interface EventRef {
  kind: string;
  id: string;
  version: number;
  /** 引用点内容摘要。 */
  digest: string;
}

export type EventKind =
  | 'source_imported'
  | 'source_reinterpreted'
  | 'parameter_revision'
  | 'source_local_change'
  | 'axis_origin_checked'
  | 'track_gap_recorded'
  | 'track_swap_detected'
  | 'missing_high_tilt_detected'
  | 'frame_excluded'
  | 'local_warp_overfit_flagged'
  | 'candidate_compared'
  | 'ambiguity_frozen'
  | 'adjudication'
  | 'adjudication_undone'
  | 'registration_locked'
  | 'lock_revoked'
  | 'conflict_detected'
  | 'dependency_invalidated'
  | 'corruption_detected'
  | 'rollback'
  | 'case_replayed'
  | 'bundle_exported'
  | 'bundle_imported';

/** 实体视图：查询任一实体时返回它引用的版本号与内容摘要；缺引用即损坏。 */
export interface EntityView {
  kind: string;
  id: string;
  version: number;
  digest: string;
  createdAt: string;
  content: unknown;
  /** 该版本引用的版本号与内容摘要。 */
  references: EventRef[];
  /** 损坏原因（悬空引用等）；非空时调用方必须拒绝把它当最新版使用。 */
  corruption: string[];
}

export interface ScenarioResult {
  scenarioId: string;
  title: string;
  status: 'expected' | 'regression';
  /** 该情形直接触碰的对象 id（失效范围应被限制于此闭包）。 */
  affectedObjectIds: string[];
  /** 期望失效/影响范围（对象 id）。 */
  expectedInvalidation: string[];
  /** 实际计算出的失效范围。 */
  actualInvalidation: string[];
  /** 期望结论代码。 */
  expectedCodes: string[];
  /** 实际诊断代码。 */
  actualCodes: string[];
  /** 是否采纳该情形下产生的候选。 */
  adopted: boolean;
  eventIds: string[];
}
