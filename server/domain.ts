// 领域词汇的数据契约：不使用通用 name/value，所有量都带单位或坐标基准。
export type Unit =
  | "deg" | "rad"
  | "angstrom/pixel" | "nm/pixel"
  | "e-/A^2" | "e-/nm^2"
  | "pixel" | "nm" | "angstrom";

export interface Quantity<U extends Unit = Unit> { value: number; unit: U }

export interface Diagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  at?: string; // 原始负载中的位置（JSON 路径），无法转换的值留在原位置
}

export interface FrameImageRef { seed: number; width: number; height: number }

export interface RawFrame {
  frameIndex: number;
  image: FrameImageRef;          // 导入时整体入 blobs，实体里只留 imageHash
  tiltAngle: Quantity;           // 倾角
  dose: Quantity;                // 曝光剂量（原始单位保留）
}

export interface TiltSeries {
  kind: "tilt-series";
  seriesId: string;
  specimen: string;
  pixelScale: Quantity;          // 像素尺度（原始单位保留）
  coordinateFrame: "image-pixel";
  imageSize: { width: number; height: number };
  expectedTiltRange: { min: Quantity; max: Quantity };
  frames: Array<Omit<RawFrame, "image"> & { imageHash: string }>;
}

export interface FiducialObservation {
  frameIndex: number;
  position: { x: number; y: number; coordinateFrame: "image-pixel" };
}

export interface TrackingGap { fromFrame: number; toFrame: number; cause: string }

export interface FiducialTrajectory {
  fiducialId: string;
  observations: FiducialObservation[];
  gaps: TrackingGap[];           // 跟踪缺口：轨迹可断裂
}

export interface ManualExclusion { frameIndex: number; reason: string; decidedBy: string }

export interface FiducialSet {
  kind: "fiducial-set";
  trajectories: FiducialTrajectory[];
  manualExclusions: ManualExclusion[]; // 手工排除原因
}

export interface RuleParams {
  kind: "rule-params";
  fixedAxisAtCenter: boolean;        // 规则：倾转轴不能被默认固定在图像中心
  localDeformationModes: number;
  minEffectivePoints: number;
  identitySwapMinFrames: number;
  multipleSolutionTolerance: number; // 多解容差（相对残差）
  highTiltMarginDeg: number;
}

export type AlignmentModel = "rigid" | "local-deformation" | "bad-frame-excluded";

export interface TiltAxisEstimate {
  angle: Quantity;                    // 倾转轴取向
  offsetFromImageCenter: Quantity;    // 轴线偏心量（不默认固定在图像中心）
}

export interface AlignmentCandidate {
  kind: "alignment-candidate";
  model: AlignmentModel;
  tiltAxis: TiltAxisEstimate;
  effectivePointSet: string[];        // 有效点集：候选用相同有效点集比较
  usedFrames: number[];
  excludedFrames: Array<{ frameIndex: number; reason: string }>;
  perFrameResiduals: Array<{ frameIndex: number; residual: Quantity }>; // 每帧残差（pixel）
  predictions: Record<string, { x: number; y: number }>; // "frame:fiducial" -> 预测位置（派生层）
  trajectoryBreaks: Array<{ fiducialId: string; atFrame: number; cause: string }>;
  identitySwaps: Array<{ atFrame: number; fromFiducial: string; toFiducial: string }>;
  dof: number;
  observationCount: number;
  diagnostics: Diagnostic[];
}

export interface CandidateComparisonRow {
  candidateEntityId: string;
  candidateVersion: number;
  model: AlignmentModel;
  comparedObservations: number;       // 所有候选一致：不用少帧换低残差
  meanResidual: Quantity;
  dof: number;
  nativeObservations: number;
  diagnostics: Diagnostic[];
}

export interface CandidateComparison {
  kind: "candidate-comparison";
  comparedPointSet: string[];
  comparedFrames: number[];
  rows: CandidateComparisonRow[];
  undecidable: boolean;               // 多解：保留全部合法候选
  keptCandidateRefs: Array<{ entityId: string; version: number }>;
}

export interface DoseReport {
  kind: "dose-report";
  perFrame: Array<{ frameIndex: number; dose: Quantity; rawDose: Quantity }>;
  cumulative: Quantity;
  diagnostics: Diagnostic[];
}

export interface Adjudication {
  kind: "adjudication";
  candidate: { entityId: string; version: number; digest: string };
  verdict: "accepted" | "rejected";
  basis: string;                      // 机器可读取的判断依据（同时进入事件流）
}

export interface LockedAlignment {
  kind: "locked-alignment";
  candidate: { entityId: string; version: number; digest: string };
  lockedFor: "reconstruction";
  lockedBy: string;
}

export interface EntityRef { entityId: string; version: number; branchId: string; digest: string }

// ---- 单位换算：导入时保留原始表示，派生层才规范化；无法转换留在原位置并附诊断 ----
const LENGTH_TO_NM: Record<string, number> = { nm: 1, angstrom: 0.1 };

export function convertQuantity(q: Quantity, target: Unit): Quantity | null {
  if (q.unit === target) return { ...q };
  const key = `${q.unit}->${target}`;
  switch (key) {
    case "deg->rad": return { value: (q.value * Math.PI) / 180, unit: target };
    case "rad->deg": return { value: (q.value * 180) / Math.PI, unit: target };
    case "angstrom/pixel->nm/pixel": return { value: q.value / 10, unit: target };
    case "nm/pixel->angstrom/pixel": return { value: q.value * 10, unit: target };
    case "e-/A^2->e-/nm^2": return { value: q.value * 100, unit: target };
    case "e-/nm^2->e-/A^2": return { value: q.value / 100, unit: target };
    case "nm->angstrom": return { value: q.value * 10, unit: target };
    case "angstrom->nm": return { value: q.value / 10, unit: target };
    default: {
      if (q.unit in LENGTH_TO_NM && target in LENGTH_TO_NM) {
        return { value: (q.value * LENGTH_TO_NM[q.unit]) / LENGTH_TO_NM[target], unit: target };
      }
      return null;
    }
  }
}

export function normalizeOrDiagnose(q: Quantity, target: Unit, at: string): { quantity: Quantity | null; diagnostic: Diagnostic | null } {
  const converted = convertQuantity(q, target);
  if (converted) return { quantity: converted, diagnostic: null };
  return {
    quantity: null,
    diagnostic: {
      code: "unit-unconvertible",
      severity: "warning",
      message: `无法把 ${q.value} ${q.unit} 规范化为 ${target}；原始值保留在 ${at}，派生层跳过`,
      at
    }
  };
}

export const DEFAULT_RULE_PARAMS: RuleParams = {
  kind: "rule-params",
  fixedAxisAtCenter: false,
  localDeformationModes: 6,
  minEffectivePoints: 5,
  identitySwapMinFrames: 3,
  multipleSolutionTolerance: 0.05,
  highTiltMarginDeg: 5
};
