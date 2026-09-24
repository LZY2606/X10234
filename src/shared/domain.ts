/**
 * 数据契约：电子断层 / 倾转序列 / 配准审阅。
 * 直接使用领域词汇建模，不把领域量压成 name/value。
 */

// ---------- 带单位 / 坐标基准的领域量 ----------

export interface Quantity<U extends string> {
  value: number;
  unit: U;
}
export type AngleDeg = Quantity<'deg'>;
export type LengthNm = Quantity<'nm'>;
export type PixelLength = Quantity<'px'>;
export type DosePerArea = Quantity<'e-/A2'>;

/** 坐标基准：所有坐标都必须声明自己的基准，不允许裸数字。 */
export type CoordinateRef =
  | { frame: 'specimen' }                                   // 样品坐标系
  | { frame: 'detector'; origin: 'image-center' }           // 探测器，原点=图像中心
  | { frame: 'detector'; origin: 'corner' }                 // 探测器，原点=左上角
  | { frame: 'tilt-axis' };                                 // 沿倾转轴分解 (u 垂直轴, v 沿轴)

export interface Point2 {
  x: number;
  y: number;
  ref: CoordinateRef;
}

/**
 * 导入时保留原始表示；派生层才做规范化。
 * 无法转换的值留在原位置并附诊断，不能为了画图丢掉。
 */
export interface RawQuantity {
  rawText: string;          // 原始文本表示，如 "1.37", "60.0", "45 e-/A^2"
  rawUnit: string;          // 原始单位字符串，如 "nm/px" | "Ang/px" | "e-/A2"
  normalized?: number;      // 派生层规范化后的数值（规范单位）
  normalizedUnit?: string;  // 规范单位
  diagnostic?: string;      // 无法转换时的诊断；此时 normalized 缺省
}

// ---------- 输入实体（全部版本化） ----------

export interface RawFrame {
  kind: 'RawFrame';
  frameIndex: number;
  imageHash: string;              // 指向不可变内容库（blob）的摘要
  widthPx: number;
  heightPx: number;
  acquiredAt: string;             // ISO 时间
}

export interface TiltAngle {
  kind: 'TiltAngle';
  frameIndex: number;
  angle: RawQuantity;             // 规范化为 deg
}

export interface PixelSize {
  kind: 'PixelSize';
  specimenPixel: RawQuantity;     // 规范化为 nm/px
}

export interface Dose {
  kind: 'Dose';
  frameIndex: number;
  dose: RawQuantity;              // 规范化为 e-/A2
}

export interface FiducialObservation {
  frameIndex: number;
  position: Point2;               // 探测器坐标
}

export interface FiducialTrack {
  kind: 'FiducialTrack';
  fiducialId: string;             // 标记点身份，如 "fid-03"
  observations: FiducialObservation[];  // 跟踪缺口 = 缺失的 frameIndex
}

export interface TrackingGap {
  kind: 'TrackingGap';
  fiducialId: string;
  fromFrame: number;
  toFrame: number;
  reason: string;
}

export interface ManualExclusion {
  kind: 'ManualExclusion';
  frameIndex: number;
  reason: string;                 // 手工排除原因，如 "drift", "ice-contamination"
  decidedBy: string;
}

/** 倾转序列：把一版输入实体聚合在一起。 */
export interface TiltSeries {
  kind: 'TiltSeries';
  title: string;
  frames: RawFrame[];
  tiltAngles: TiltAngle[];
  pixelSize: PixelSize;
  doses: Dose[];
  tracks: FiducialTrack[];
  trackingGaps: TrackingGap[];
  manualExclusions: ManualExclusion[];
}

// ---------- 决定实体 ----------

export type AlignmentModel = 'rigid' | 'local-deformation' | 'exclude-bad-frames';

/**
 * 倾转轴估计：绝不允许默认固定在图像中心。
 * offset 是轴线相对图像中心的位移（探测器坐标，原点=图像中心）。
 */
export interface TiltAxisEstimate {
  angle: AngleDeg;                // 轴线在图像平面内的方位角
  offset: Point2;                 // 轴线不过图像中心时的位移
  fixedAtImageCenter: false;      // 契约级禁止
}

export interface PerFrameResidual {
  frameIndex: number;
  rmsPx: number;
  pointCount: number;             // 该帧参与残差的有效点数
}

/** 轨迹断点 / 身份交换，都属于轨迹层面的显式结构。 */
export interface TrackBreakpoint {
  fiducialId: string;
  afterFrame: number;
  type: 'gap' | 'identity-swap';
  swappedWith?: string;
}

export interface AlignmentCandidate {
  kind: 'AlignmentCandidate';
  model: AlignmentModel;
  parameterVersion: string;       // 参数版本（规则版本）引用
  seriesRef: VersionRef;          // 解释的倾转序列版本
  tiltAxis: TiltAxisEstimate;
  effectivePointSet: string[];    // 有效点集 "fid-03@12" —— 候选间比较必须用同一集合
  excludedFrames: number[];
  perFrameResiduals: PerFrameResidual[];
  breakpoints: TrackBreakpoint[];
  fittedRmsPx: number;            // 各自拟合集上的残差（不可跨候选直接比）
  comparisonRmsPx: number;        // 共同有效点集上的残差（唯一合法比较口径）
  status: 'proposed' | 'accepted' | 'rejected' | 'locked';
  diagnostics: string[];
}

export interface Adjudication {
  kind: 'Adjudication';
  candidateRef: VersionRef;
  verdict: 'accept' | 'reject';
  rationale: string;              // 机器可读取的判断依据由事件承载，这里是人写的话
  decidedBy: string;
  undoes?: string;                // 撤销：指向被撤销的裁定事件 id
}

/** 锁定一版配准供重建引用。 */
export interface LockedAlignment {
  kind: 'LockedAlignment';
  candidateRef: VersionRef;
  lockedBy: string;
  purpose: 'tomogram-reconstruction';
}

// ---------- 复核实体 ----------

export interface ReviewAnnotation {
  kind: 'ReviewAnnotation';
  targetRef: VersionRef;
  view: 'frame-overlay' | 'tilt-axis' | 'track-breaks' | 'residuals' | 'candidate-diff';
  note: string;
  author: string;
}

// ---------- 版本与来源 ----------

export interface VersionRef {
  entityId: string;               // 稳定身份，如 "series/tilt-frame-assembly-room"
  version: number;
}

export interface ProvenanceLink {
  role: 'interprets' | 'derived-from' | 'adjudicates' | 'locks' | 'revises' | 'excludes';
  from: VersionRef;
  to: VersionRef;
}

/** 机器可读取事件：判断依据、失效范围、并发冲突都落成事件。 */
export interface DomainEvent {
  eventId: string;
  seq: number;                    // 全局顺序，重放与导出后必须保持
  type:
    | 'series-imported'
    | 'series-revised'
    | 'parameter-revised'
    | 'candidate-computed'
    | 'candidates-compared'        // 依据：同一有效点集，不用少帧换低残差
    | 'axis-eccentricity-detected' // 依据：倾转轴不能默认固定在图像中心
    | 'track-identity-swap-detected' // 依据：轨迹可断裂且可能身份交换
    | 'high-tilt-gap-detected'
    | 'bad-frame-excluded'
    | 'overfit-detected'
    | 'multiple-solutions-kept'
    | 'adjudicated'
    | 'adjudication-undone'
    | 'alignment-locked'
    | 'invalidation-computed'      // 依赖失效范围
    | 'save-conflict'              // 并发冻结：后提交者看到冲突
    | 'diagnostic';                // 无法转换的值等
  at: string;
  actor: string;
  refs: VersionRef[];
  payload: Record<string, unknown>;
}

export type AnyEntity =
  | TiltSeries
  | AlignmentCandidate
  | Adjudication
  | LockedAlignment
  | ReviewAnnotation;

export const CONTRACT_RULES = [
  'axis-not-fixed-at-image-center',
  'tracks-may-break-and-swap-identity',
  'compare-candidates-on-same-effective-point-set',
  'no-fewer-frames-for-lower-residual',
] as const;
export type ContractRule = (typeof CONTRACT_RULES)[number];
