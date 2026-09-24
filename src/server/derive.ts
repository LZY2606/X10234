/**
 * 派生层推导规则（纯函数，可单测）：
 * - 倾转轴不允许默认固定在图像中心，由 fiducial 拟合出轴线偏心；
 * - fiducial 轨迹可断裂，且相邻轨迹可能发生身份交换；
 * - 不同候选必须在相同有效点集上比较，不能用少帧换低残差。
 */

export interface SpecimenPoint {
  x: number;
  y: number;
}

export interface Observation {
  frameId: string;
  frameIndex: number;
  tiltDeg: number;
  x: number;
  y: number;
}

export interface CandidateModelSummary {
  candidateId: string;
  model: 'rigid' | 'local-deform' | 'bad-frame-exclusion';
  rmsPx: number;
  effectivePointCount: number;
  excludedFrameIds: string[];
  overfit: boolean;
}

export function projectPoint(
  specimen: SpecimenPoint,
  tiltDeg: number,
  axisOffsetPx: number,
  center: { x: number; y: number }
): { x: number; y: number } {
  const theta = (tiltDeg * Math.PI) / 180;
  return {
    x: center.x + axisOffsetPx + specimen.x * Math.cos(theta),
    y: center.y + specimen.y
  };
}

/** 由观察点拟合轴线相对图像中心的偏心（px）。offset=0 即“固定在中心”的反例。 */
export function fitAxisOffset(
  samples: { tiltDeg: number; specimenX: number; observedX: number; centerX: number }[]
): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const theta = (sample.tiltDeg * Math.PI) / 180;
    sum += sample.observedX - sample.centerX - sample.specimenX * Math.cos(theta);
  }
  return sum / samples.length;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 检测两条轨迹在相邻帧间是否发生身份交换，返回交换开始的 frameIndex。 */
export function detectIdentitySwap(a: Observation[], b: Observation[]): number | null {
  const mapA = new Map(a.map((obs) => [obs.frameIndex, obs]));
  const mapB = new Map(b.map((obs) => [obs.frameIndex, obs]));
  const common = [...mapA.keys()].filter((idx) => mapB.has(idx)).sort((x, y) => x - y);
  for (let i = 0; i + 1 < common.length; i += 1) {
    const f0 = common[i];
    const f1 = common[i + 1];
    const a0 = mapA.get(f0)!;
    const a1 = mapA.get(f1)!;
    const b0 = mapB.get(f0)!;
    const b1 = mapB.get(f1)!;
    const keepCost = distance(a0, a1) + distance(b0, b1);
    const swapCost = distance(a0, b1) + distance(b0, a1);
    if (swapCost + 1e-9 < keepCost) return f1;
  }
  return null;
}

/** 有效点集：轨迹观察中未被排除帧的全部点，结果稳定排序后哈希。 */
export function effectivePointSet(
  trajectories: { trajectoryId: string; observations: Observation[] }[],
  excludedFrameIds: ReadonlySet<string>
): string[] {
  const keys: string[] = [];
  for (const trajectory of trajectories) {
    for (const obs of trajectory.observations) {
      if (!excludedFrameIds.has(obs.frameId)) keys.push(`${trajectory.trajectoryId}@${obs.frameId}`);
    }
  }
  return keys.sort();
}

export interface ResidualPoint {
  trajectoryId: string;
  frameId: string;
  frameIndex: number;
  residualPx: number;
}

/** 在给定有效点集上逐点、逐帧计算残差（px）。 */
export function residuals(
  trajectories: { trajectoryId: string; specimen: SpecimenPoint; observations: Observation[] }[],
  axisOffsetPx: number,
  center: { x: number; y: number },
  pointSet: ReadonlySet<string>
): ResidualPoint[] {
  const output: ResidualPoint[] = [];
  for (const trajectory of trajectories) {
    for (const obs of trajectory.observations) {
      if (!pointSet.has(`${trajectory.trajectoryId}@${obs.frameId}`)) continue;
      const predicted = projectPoint(trajectory.specimen, obs.tiltDeg, axisOffsetPx, center);
      output.push({
        trajectoryId: trajectory.trajectoryId,
        frameId: obs.frameId,
        frameIndex: obs.frameIndex,
        residualPx: Math.hypot(obs.x - predicted.x, obs.y - predicted.y)
      });
    }
  }
  return output;
}

export function perFrameResiduals(points: ResidualPoint[]): { frameId: string; frameIndex: number; rmsPx: number }[] {
  const byFrame = new Map<string, { frameIndex: number; sum: number; count: number }>();
  for (const point of points) {
    const entry = byFrame.get(point.frameId) ?? { frameIndex: point.frameIndex, sum: 0, count: 0 };
    entry.sum += point.residualPx ** 2;
    entry.count += 1;
    byFrame.set(point.frameId, entry);
  }
  return [...byFrame.entries()]
    .map(([frameId, entry]) => ({ frameId, frameIndex: entry.frameIndex, rmsPx: Math.sqrt(entry.sum / entry.count) }))
    .sort((a, b) => a.frameIndex - b.frameIndex);
}

export function rms(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
}

/**
 * 局部形变过拟合：逐帧仿射 6 个参数，有效点数不足两倍参数数，
 * 且残差相对刚体基线异常下降时判定过拟合。
 */
export function isOverfit(effectivePoints: number, params: number, rmsValue: number, baselineRms: number): boolean {
  return effectivePoints < params * 2 && rmsValue < baselineRms * 0.5;
}

/** 残差无法区分（差 <= 容差）时返回并列候选组——多解必须全部保留。 */
export function ambiguousGroups(summaries: { candidateId: string; rmsPx: number }[], tolerancePx = 0.15): string[][] {
  const sorted = [...summaries].sort((a, b) => a.rmsPx - b.rmsPx);
  const groups: string[][] = [];
  for (const item of sorted) {
    const group = groups.find((candidateIds) =>
      candidateIds.some((id) => {
        const other = sorted.find((summary) => summary.candidateId === id)!;
        return Math.abs(other.rmsPx - item.rmsPx) <= tolerancePx;
      })
    );
    if (group) group.push(item.candidateId);
    else groups.push([item.candidateId]);
  }
  return groups.filter((group) => group.length > 1);
}

/** 确定性微扰，让残差非零且可复现。 */
export function deterministicNoise(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return (value - Math.floor(value) - 0.5) * 0.8;
}
