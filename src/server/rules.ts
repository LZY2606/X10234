import type {
  AlignmentCandidate,
  CandidateKind,
  DerivedDependency,
  Diagnostic,
  FiducialObservation,
  FrameResidual,
  ParameterValues,
  ReviewDecision,
  SourceSnapshot,
  TrackingGap,
  VersionRef,
} from "../shared/domain.js";
import { hashJson } from "../../case-pack/cases.js";

/**
 * 推导规则（规则版本化；参数或参考版本变化后用依赖关系计算失效范围）。
 *
 * 领域铁律：
 *  R1 倾转轴不能被默认固定在图像中心（允许偏心、自由拟合）。
 *  R2 fiducial 轨迹可断裂且可能身份交换（分段、不假设 trackId 恒定连通）。
 *  R3 不同候选用相同有效点集比较，不用少帧换低残差（公平分数）。
 *  R4 局部形变自由度过高 => 过拟合诊断。
 *  R5 无法唯一决定时保留全部合法候选（多解）。
 */
export const RULE_VERSION = "rules-2026.09.0";

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return 0;
  return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
};

interface Point {
  obsId: string;
  trackId: string;
  segmentId: string;
  frameSeq: number;
  x: number;
  y: number;
}

interface PreparedSeries {
  points: Point[];
  frameSeqs: number[];
  width: number;
  height: number;
  angleBySeq: Map<number, number>;
  tracks: string[];
  gaps: TrackingGap[];
  swapDetected: boolean;
  maxAbsAnglePresent: number;
  angleRangeRequested: [number, number];
}
