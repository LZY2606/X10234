/**
 * 领域数据契约 —— 直接采用电子断层的领域词汇，绝不压成 name/value。
 *
 * 三大实体族：
 *  1) 输入实体（source facts）：原始帧、倾角、像素尺度、剂量、标记点坐标、
 *     跟踪缺口、手工排除原因，全部版本化；来源与解释拆开保存。
 *  2) 决定实体（interpretations）：倾转轴（可偏心）、fiducial 轨迹（可断裂/换身份）、
 *     配准候选（刚体/局部形变/排除坏帧）、有效点集、裁定。
 *  3) 复核实体（review views）：叠影、轴线叠加、轨迹断点、每帧残差、候选差分、锁定。
 */
import type { Quantified, CoordinateFrame } from "./units";

export type EntityKind =
  | "TiltSeries"
  | "RawFrame"
  | "TiltAngle"
  | "PixelScale"
  | "DoseMeasurement"
  | "FiducialObservation"
  | "TrackGap"
  | "ManualExclusion"
  | "TiltAxisModel"
  | "FiducialTrack"
  | "RegistrationCandidate"
  | "EffectivePointSet"
  | "Adjudication"
  | "RegistrationLock"
  | "Diagnostic"
  | "ReviewSnapshot";

/** 输入实体：来自仪器/人工，保留原始表示。 */
export interface TiltSeries {
  kind: "TiltSeries";
  stableId: string;
  label: string;
  /** 帧序列顺序（稳定 id 列表），顺序本身被保留。 */
  frameOrder: string[];
  /** 角度方案范围，例如 -60..60。 */
  tiltScheme: string;
}

export interface RawFrame {
  kind: "RawFrame";
  stableId: string;
  seriesId: string;
  /** 该帧在倾转序列中的序号（0 基），顺序稳定身份。 */
  index: number;
  width: number;
  height: number;
  /** 不可变原始像素内容的内容寻址 id。 */
  blobId: string;
  /** 合成/采集生成参数（可复现），原始帧的来源。 */
  generator: { seed: number; kind: string };
}

export interface TiltAngle {
  kind: "TiltAngle";
  stableId: string;
  frameId: string;
  angle: Quantified; // kind=angle
}

export interface PixelScale {
  kind: "PixelScale";
  stableId: string;
  frameId: string;
  /** 每像素物理尺度。 */
  pixelSize: Quantified; // kind=length, unit nm/px 等
}

export interface DoseMeasurement {
  kind: "DoseMeasurement";
  stableId: string;
  frameId: string;
  dose: Quantified; // kind=dose
  cumulative: Quantified;
}

export interface FiducialObservation {
  kind: "FiducialObservation";
  stableId: string;
  frameId: string;
  /** 观测到的标记点编号（采集侧标签，可能在换身份时与轨迹 id 不同）。 */
  observedLabel: string;
  x: Quantified; // pixel
  y: Quantified; // pixel
  frame: CoordinateFrame;
}

export interface TrackGap {
  kind: "TrackGap";
  stableId: string;
  trackId: string;
  /** 缺口覆盖的帧序号区间（含端点）。 */
  fromFrameIndex: number;
  toFrameIndex: number;
  reason: string;
}

export interface ManualExclusion {
  kind: "ManualExclusion";
  stableId: string;
  frameId: string;
  reason: string;
  reviewer: string;
}

/** 决定实体：解释层，可多分支、可版本化。 */
export interface TiltAxisModel {
  kind: "TiltAxisModel";
  stableId: string;
  seriesId: string;
  /** 轴线方向角（图像坐标系，度）。 */
  axisAngleDeg: number;
  /**
   * 轴线穿过点。默认固定图像中心是被明确禁止的：
   * 该点是被拟合/裁定的偏心量，assumeCenter 必须显式记录。
   */
  offsetX: number;
  offsetY: number;
  /** 是否（错误地）假定了图像中心；反例档案中用于检验。 */
  assumeCenter: boolean;
  uncertaintyPx: number;
}

export interface FiducialTrack {
  kind: "FiducialTrack";
  stableId: string;
  seriesId: string;
  /**
   * 每帧的观测身份：frameId -> FiducialObservation.stableId。
   * 轨迹可断裂（缺帧），且同一物理轨迹在不同片段可能引用交换过的观测身份。
   */
  members: Record<string, string>;
  /** 连续片段（按帧序号），断点由片段之间的空隙表达。 */
  segments: Array<{ fromIndex: number; toIndex: number }>;
  /** 记录身份交换：在 frameId 处此轨迹改用了另一观测标签。 */
  identitySwaps: Array<{ frameId: string; fromObservation: string; toObservation: string }>;
}

export type TransformModel =
  | { type: "rigid"; translations: Record<string, { tx: number; ty: number }>; inPlaneRotationDeg: number }
  | {
      type: "local";
      translations: Record<string, { tx: number; ty: number }>;
      inPlaneRotationDeg: number;
      /** 每帧每控制点的局部位移（自由度高，易过拟合）。 */
      localWarp: Record<string, Array<{ cx: number; cy: number; dx: number; dy: number }>>;
    };

export interface RegistrationCandidate {
  kind: "RegistrationCandidate";
  stableId: string;
  seriesId: string;
  label: string;
  family: "rigid" | "local" | "exclude-bad-frames";
  /** 所基于的输入事实版本（pin，不允许退回最新）。 */
  basedOn: {
    tiltAxisId: string;
    trackIds: string[];
    parameterVersion: string;
  };
  /** 被排除帧（坏帧策略）；刚体/局部也可为空。 */
  excludedFrameIds: string[];
  /** 参与比较的有效点集 id —— 不同候选必须用同一有效点集比较。 */
  effectivePointSetId: string;
  model: TransformModel;
  /** 每帧残差（px）。 */
  perFrameResidual: Record<string, number>;
  /** 用相同有效点集得到的总体指标。 */
  metrics: {
    rmsePx: number;
    maxResidualPx: number;
    /** 有效帧数：防止“用少帧换低残差”。 */
    effectiveFrameCount: number;
    totalFrameCount: number;
    /** 交叉验证残差，用于识别局部形变过拟合。 */
    crossValidatedRmsePx: number;
    overfit: boolean;
    degreesOfFreedom: number;
  };
  /** 求解诊断：例如多解、奇异性。 */
  diagnostics: string[];
}

export interface EffectivePointSet {
  kind: "EffectivePointSet";
  stableId: string;
  seriesId: string;
  /** 规范有效点：frameId -> 参与比较的观测 id 列表（候选间必须一致）。 */
  points: Record<string, string[]>;
  excludedFrameIds: string[];
  pointCount: number;
}

export type AdjudicationAction = "accept" | "reject" | "parameter-revision";

export interface Adjudication {
  kind: "Adjudication";
  stableId: string;
  seriesId: string;
  candidateId: string;
  action: AdjudicationAction;
  reviewer: string;
  rationale: string;
  /** 撤销目标：被本裁定推翻的前一裁定 id（可撤销并恢复前一分支）。 */
  supersedes?: string;
  /** 多解时保留的全部合法候选 id。 */
  legalCandidateIds: string[];
}

export interface RegistrationLock {
  kind: "RegistrationLock";
  stableId: string;
  seriesId: string;
  candidateId: string;
  /** 供重建读回的引用句柄；解析时必须命中被锁定版本。 */
  reconstructionRef: string;
}

export interface Diagnostic {
  kind: "Diagnostic";
  stableId: string;
  scope: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

/** 复核实体：审阅页可见值的稳定快照，每个显示值带稳定身份。 */
export interface ReviewSnapshot {
  kind: "ReviewSnapshot";
  stableId: string;
  seriesId: string;
  frameOverlay: { blobIds: string[]; transformHash: string };
  tiltAxisOverlay: { axisId: string };
  trackBreakpoints: Array<{ trackId: string; fromIndex: number; toIndex: number }>;
  perFrameResidualRows: Array<{ frameId: string; residual: number; stableRowId: string }>;
  candidateDiff: { leftCandidateId: string; rightCandidateId: string; deltaHash: string };
}

export type DomainEntity =
  | TiltSeries
  | RawFrame
  | TiltAngle
  | PixelScale
  | DoseMeasurement
  | FiducialObservation
  | TrackGap
  | ManualExclusion
  | TiltAxisModel
  | FiducialTrack
  | RegistrationCandidate
  | EffectivePointSet
  | Adjudication
  | RegistrationLock
  | Diagnostic
  | ReviewSnapshot;
