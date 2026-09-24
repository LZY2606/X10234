/**
 * 数据契约：直接使用领域词汇，不压成 name/value。
 * 输入实体（全部版本化）：原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口、手工排除原因。
 * 决定实体：倾转轴、fiducial 轨迹（可断裂、可身份交换）、候选配准（相同有效点集比较）。
 * 复核实体：帧叠影、倾转轴、轨迹断点、每帧残差、候选差分、锁定版本。
 */
import type { Quantity, Diagnostic } from "./quantities";

export type EntityKind =
  // 输入实体（来源层，全部版本化）
  | "tilt-series"
  | "raw-frame"
  | "tilt-angle"
  | "pixel-size"
  | "dose"
  | "fiducial-point"
  | "fiducial-track"
  | "tracking-gap"
  | "exclusion-reason"
  // 决定实体（解释层）
  | "alignment-params"
  | "tilt-axis"
  | "alignment-candidate"
  // 复核实体
  | "alignment-lock"
  | "review-decision";

export interface EntityRef {
  entityId: string;
  versionNo: number;
}

/** 原始帧：图像字节存 blob，这里只放元数据 */
export interface RawFrame {
  kind: "raw-frame";
  frameIndex: number;
  imageBlob: string;          // blob id，原始字节不可变
  widthPx: number;
  heightPx: number;
  tiltAngle: EntityRef;       // 倾角实体引用（版本化）
  dose: EntityRef;            // 剂量实体引用（版本化）
}

export interface TiltSeries {
  kind: "tilt-series";
  seriesId: string;
  frames: EntityRef[];        // 原始帧引用，顺序即倾转序列顺序
  pixelSize: EntityRef;       // 像素尺度引用
}

export interface TiltAngleValue { kind: "tilt-angle"; angle: Quantity; }
export interface PixelSizeValue { kind: "pixel-size"; pixelSize: Quantity; }
export interface DoseValue { kind: "dose"; dose: Quantity; }

export interface FiducialPoint {
  kind: "fiducial-point";
  trackId: string;
  frameIndex: number;
  position: Quantity;         // px，basis=image-top-left
  positionY: Quantity;
}

/** 跟踪缺口：轨迹在某帧区间断裂 */
export interface TrackingGap {
  kind: "tracking-gap";
  trackId: string;
  fromFrame: number;
  toFrame: number;
  reason: string;
}

/** 手工排除原因 */
export interface ExclusionReason {
  kind: "exclusion-reason";
  frameIndex: number;
  reason: string;
  decidedBy: string;
}

/** fiducial 轨迹：可断裂（segments）、可身份交换（possibleSwaps） */
export interface FiducialTrack {
  kind: "fiducial-track";
  trackId: string;
  segments: { fromFrame: number; toFrame: number }[];
  possibleSwaps: { atFrame: number; withTrackId: string; note: string }[];
}

/** 倾转轴：不能被默认固定在图像中心 */
export interface TiltAxis {
  kind: "tilt-axis";
  /** null 表示“必须估计”，绝不在导入时默认为中心 */
  offsetFromCenter: Quantity | null;  // nm
  axisAngle: Quantity | null;         // deg
  estimated: boolean;
}

export interface AlignmentParams {
  kind: "alignment-params";
  label: string;
  axis: TiltAxis;
  allowLocalDeform: boolean;
  excludeFrameIndexes: number[];
}

export interface FrameResidual {
  frameIndex: number;
  residualNm: number;
  usedPoints: number;
}

/** 配准候选：刚体 / 局部形变 / 排除坏帧；比较时必须使用相同有效点集 */
export interface AlignmentCandidate {
  kind: "alignment-candidate";
  strategy: "rigid" | "local-deform" | "exclude-bad-frames";
  branchId: string;
  /** 有效点集：fiducial-point 实体 id 列表，候选间比较必须一致 */
  effectivePointSet: string[];
  perFrameResiduals: FrameResidual[];
  axis: TiltAxis;
  /** 多解：无法唯一决定时保留全部合法候选 */
  solutions: { label: string; score: number }[];
  diagnostics: Diagnostic[];
}

export interface AlignmentLock {
  kind: "alignment-lock";
  candidate: EntityRef;
  lockedBy: string;
  note: string;
}

export interface ReviewDecision {
  kind: "review-decision";
  action: "accept" | "reject" | "adjust";
  candidate: EntityRef;
  rationale: string;
  decidedBy: string;
}

/** 机器可读取事件：判断依据（三条规则）与所有状态变化 */
export type RuleId =
  | "axis-not-fixed-at-center"
  | "tracks-may-break-and-swap"
  | "compare-on-same-effective-point-set";

export interface DomainEvent {
  id: number;
  branchId: string;
  kind:
    | "import" | "reinterpret" | "param-revision" | "source-change"
    | "decision" | "decision-undo" | "lock" | "conflict"
    | "invalidation" | "rule" | "scenario";
  ruleId?: RuleId;
  payload: Record<string, unknown>;
  refs: { entityId: string; versionNo: number; digest: string }[];
  createdAt: string;
}
