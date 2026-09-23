/**
 * 领域数据契约 —— 电子断层倾转序列 (electron tomography tilt series) 专用词汇。
 *
 * 设计原则：
 *  1. 所有领域量都携带单位或坐标基准 (Unit / ReferenceFrame)。
 *  2. 导入层保留原始表示 (raw) 与来源；派生层才做规范化 (normalized)。
 *  3. 无法转换的值留在原位并附诊断，绝不为了画图而丢弃。
 *  4. 实体显式区分“来源 (source)”与“解释 (interpretation/derivation)”。
 *
 * 这里不使用通用 name/value 键值表：每个实体都有领域语义化的字段。
 */

// ---------------------------------------------------------------------------
// 单位与坐标基准
// ---------------------------------------------------------------------------

/** 角度单位：倾转角只接受 degree / radian，导入时保留原始表示 */
export type AngleUnit = "degree" | "radian";

/** 长度/剂量单位（封闭集合，未知单位进入 raw + 诊断，不静默转换） */
export type LengthUnit = "nm" | "um" | "pixel";
export type DoseUnit = "e-/A^2" | "e-/nm^2";

/** 点坐标的坐标基准：像素坐标 (像素原点=左上, 单位 pixel) */
export interface PixelCoordinate {
  basis: "pixel";
  /** 列方向（沿图像宽度，像素） */
  x: number;
  /** 行方向（沿图像高度，像素） */
  y: number;
  /** 亚像素精度时的标准不确定度（像素），未知为 null */
  uncertaintyPx: number | null;
}

/**
 * 带单位的角度测量值。保留原始表示：
 *  rawValue/rawUnit 是文件里的原样内容，normalizedDeg 是派生层换算结果。
 *  无法解析时 normalizedDeg=null 并产生诊断，值仍保留在原位。
 */
export interface AngleMeasure {
  rawValue: number;
  rawUnit: AngleUnit;
  normalizedDeg: number | null;
}

export interface LengthMeasure {
  rawValue: number;
  rawUnit: LengthUnit;
  /** 规范化为 nm/pixel；无法换算（例如单位 pixel 且无像素尺度）时为 null */
  normalizedNmPerPx: number | null;
}

export interface DoseMeasure {
  rawValue: number;
  rawUnit: DoseUnit;
  /** 规范化为 e-/A^2；无法换算时为 null */
  normalizedEPerA2: number | null;
}

/** 规范化诊断：无法转换/越界/可疑值留档 */
export interface ValueDiagnostic {
  code:
    | "UNIT_UNKNOWN"
    | "ANGLE_UNORDERED"
    | "DOSE_NONPOSITIVE"
    | "PIXELSCALE_UNRESOLVABLE"
    | "VALUE_MISSING"
    | "VALUE_OUT_OF_RANGE";
  severity: "error" | "warning";
  message: string;
  /** 定位：帧序号 / 点身份等 */
  at: string;
}

// ---------------------------------------------------------------------------
// 来源实体（原始事实，全部版本化、不可变）
// ---------------------------------------------------------------------------

/**
 * 原始帧 RawTiltFrame。
 * 帧像素本身以内容寻址不可变字节保存，表里只留内容哈希与尺寸。
 */
export interface RawTiltFrame {
  frameId: string;
  /** 采集顺序序号（0 基），决定时间/剂量顺序 */
  acquisitionIndex: number;
  /** 倾转角（带单位，保留原始表示） */
  tiltAngle: AngleMeasure;
  /** 该帧曝光剂量 */
  exposureDose: DoseMeasure;
  /** 原始像素字节的内容哈希（共享片段只存一份不可变内容） */
  pixelBlobSha256: string;
  widthPx: number;
  heightPx: number;
  /** 原始表示来源，如 tsv 行号 / mdoc 段名 */
  originLocator: string;
}

/** 像素尺度（显微镜放大倍率对应的像元尺寸），版本化 */
export interface PixelScale {
  scaleId: string;
  measure: LengthMeasure;
  /** 生效的采集序号区间（含端点） */
  appliesFromIndex: number;
  appliesToIndex: number;
  originLocator: string;
}

/**
 * Fiducial 标记点观测：某标记在某帧的坐标。
 * trackId 是“观测分组”，不等同于物理身份——轨迹可断裂、可身份交换。
 */
export interface FiducialObservation {
  observationId: string;
  /** 观测分组（单条连续轨迹段） */
  trackId: string;
  frameId: string;
  acquisitionIndex: number;
  coordinate: PixelCoordinate;
  originLocator: string;
}

/**
 * 跟踪缺口 TrackGap：轨迹在此帧区间没有观测（遮挡 / 出视野 / 跟踪失败）。
 */
export interface TrackGap {
  gapId: string;
  trackId: string;
  /** 缺口起始/结束采集序号（含） */
  fromIndex: number;
  toIndex: number;
  reason: "occluded" | "out_of_field" | "tracker_lost" | "unknown";
  originLocator: string;
}

/**
 * 手工排除原因 ManualExclusion：审阅者把某帧标记为不可用于配准。
 * 这是“人工决定”，与原始事实分离、版本化、可撤销。
 */
export interface ManualExclusion {
  exclusionId: string;
  frameId: string;
  acquisitionIndex: number;
  reasonCode:
    | "motion_blur"
    | "beam_damage"
    | "too_large_shift"
    | "high_tilt_missing"
    | "other";
  note: string;
  originLocator: string;
}

/** 一次完整导入的来源数据包（原始事实的聚合根） */
export interface TiltSeriesSourceBundle {
  seriesId: string;
  /** 人类可读名称（领域命名，不是通用 name 键） */
  seriesLabel: string;
  microscopeNote: string;
  frames: RawTiltFrame[];
  pixelScales: PixelScale[];
  observations: FiducialObservation[];
  gaps: TrackGap[];
  exclusions: ManualExclusion[];
  diagnostics: ValueDiagnostic[];
}

// ---------------------------------------------------------------------------
// 解释实体（派生结论，引用来源版本；轴线不默认在图像中心）
// ---------------------------------------------------------------------------

/**
 * 倾转轴 TiltAxis：角度-像移拟合出的旋转轴。
 *
 * 关键领域规则：axisCenterX 必须被显式估计，不能默认 = width/2。
 * angleDeg 是轴线在图像平面内的方向角；centerX 是轴线通过点的列坐标。
 */
export interface TiltAxisModel {
  /** 轴线方向角（degree，图像坐标系） */
  angleDeg: number;
  /** 轴线穿过点的列坐标（像素）——显式偏心，不允许默认 width/2 */
  centerX: number;
  centerY: number;
  /** 是否“被假定居中”。合法值只能为 false（用于断言禁止默认居中） */
  assumedCentered: false;
  /** 拟合残差（像素，RMS） */
  fitRmsPx: number;
  /** 拟合所用观测点身份集合（不同候选必须用同一有效点集比较） */
  fittedObservationIds: string[];
}

/**
 * 轨迹身份映射：trackId（观测分组） -> 物理标记身份 physicalId。
 * 轨迹可能断裂：同一 physicalId 可对应多个 trackId。
 * 轨迹可能身份交换：相邻 trackId 的 physicalId 可能在某序号处交换。
 */
export interface TrackIdentityLink {
  trackId: string;
  physicalId: string;
  /** 该映射生效的采集序号区间 */
  validFromIndex: number;
  validToIndex: number;
}

export interface TrackIdentitySwap {
  kind: "identity_swap";
  index: number;
  trackA: string;
  trackB: string;
}

export interface TrackInterpretation {
  links: TrackIdentityLink[];
  /** 检出的身份交换点（可多个，也可为空表示无歧义） */
  swaps: TrackIdentitySwap[];
  /** 无法唯一决定身份时，保留全部合法候选解释（多解） */
  ambiguous: boolean;
}

/** 配准方案类型：刚体 / 局部形变 / 排除坏帧 */
export type RegistrationKind = "rigid" | "local_deformation" | "bad_frame_excluded";

/** 每帧残差（像素），审阅页逐帧展示 */
export interface PerFrameResidual {
  frameId: string;
  acquisitionIndex: number;
  residualPx: number;
  /** 该帧是否参与拟合（被排除帧 excluded=true 仍要显示残差，但不计入 RMS） */
  usedInFit: boolean;
  excludedReason: string | null;
}

/** 单帧刚体变换（平移；旋转并入全局轴线模型） */
export interface FrameTransform {
  frameId: string;
  shiftXPx: number;
  shiftYPx: number;
  rotationDeg: number;
}

/**
 * 配准候选 RegistrationCandidate。
 * 多候选显式保存，禁止在导入时做不可逆清洗。
 */
export interface RegistrationCandidate {
  candidateId: string;
  kind: RegistrationKind;
  label: string;
  axis: TiltAxisModel;
  track: TrackInterpretation;
  transforms: FrameTransform[];
  perFrame: PerFrameResidual[];
  /** 有效点集：所有参与比较的候选必须共享同一集合 */
  effectiveObservationIds: string[];
  /** 有效帧集合（被手工/自动排除的帧不计入，但残差仍报告） */
  effectiveFrameIds: string[];
  /** 汇总残差（仅对有效点/帧） */
  rmsResidualPx: number;
  /**
   * 过拟合诊断：局部形变自由度相对有效点数过多。
   * 局部候选若以明显更少的有效帧换取低 RMS，则 fairComparison=false。
   */
  degreesOfFreedom: number;
  overfitFlag: boolean;
  overfitDiagnostic: string | null;
  /**
   * 公平比较标记：RMS 必须在相同有效点集、相同有效帧集合上计算。
   * “不用少帧换低残差”：usedFrameCount 少于公平面板时直接判负。
   */
  fairComparison: boolean;
  fairnessNote: string | null;
  /** 多解：同一输入存在多个同残差合法候选时 nonUnique=true */
  nonUnique: boolean;
  alternateCandidateIds: string[];
}

/** 裁定结果 */
export type DecisionVerdict = "accepted" | "rejected";

export interface Adjudication {
  decisionId: string;
  candidateId: string;
  verdict: DecisionVerdict;
  note: string;
  /** 乐观并发：该裁定基于的分支版本 */
  baseVersion: number;
}

/**
 * 锁定的配准版本：供重建（reconstruction）引用。
 * 锁定后不可变；撤销锁定回到前一分支而非覆盖历史。
 */
export interface LockedRegistration {
  candidateId: string;
  decisionId: string;
  lockedAtEventSeq: number;
}

// ---------------------------------------------------------------------------
// 事件（机器可读取的判断依据）
// ---------------------------------------------------------------------------

export type EventType =
  | "source.imported"
  | "source.import_failed_rollback"
  | "parameter.revised"
  | "source.local_patch"
  | "decision.conflicted"
  | "axis.off_center_detected"
  | "track.identity_swap_detected"
  | "track.gap_recorded"
  | "frame.high_tilt_missing"
  | "frame.excluded"
  | "registration.overfit_detected"
  | "registration.non_unique_solutions"
  | "registration.concurrent_freeze"
  | "candidate.computed"
  | "candidate.adjudicated"
  | "registration.locked"
  | "registration.unlocked";

export interface ProvenanceEvent {
  seq: number;
  type: EventType;
  /** 事件时间戳（ISO，含时区） */
  at: string;
  /** 触发者：importer / reviewer:<id> / rule-engine */
  actor: string;
  /** 机器可读判断依据（封闭 schema 的结构化载荷） */
  payload: Record<string, unknown>;
  /** 该事件引用的来源版本号；缺引用即损坏 */
  sourceVersion: number;
  /** 该事件引用的规则/参数版本号 */
  ruleVersion: number;
  /** 受影响对象（稳定身份），用于失效范围计算 */
  affectedIds: string[];
}

// ---------------------------------------------------------------------------
// 稳定身份与查询
// ---------------------------------------------------------------------------

/**
 * 每个显示值都带稳定身份。
 * query 任一实体返回它引用的版本号 + 内容摘要；缺引用报 DAMAGED，不退最新版。
 */
export interface EntityRef {
  kind: string;
  id: string;
  version: number;
}

export interface ProvenanceInfo {
  sourceVersion: number;
  ruleVersion: number;
  producingEventSeq: number;
  contentSha256: string;
}

export type QueryIntegrity = "ok" | "damaged_missing_reference" | "ok_ambiguous";

export interface EntityQueryResult<T> {
  integrity: QueryIntegrity;
  entity: T | null;
  provenance: ProvenanceInfo | null;
  /** 内容摘要（用于导出/再导入后比对） */
  contentSummary: string | null;
  damageReason: string | null;
}
