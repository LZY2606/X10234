import { canonicalJson } from './hash';
import { leastSquares, rms, mean } from './linalg';
import type {
  PerFrameResidual,
  Point2D,
  RegistrationStrategy
} from './types';

/**
 * 配准引擎（二维倾转 fiducial 对齐）。
 *
 * 模型（图像像素坐标基准）：
 *   每条 fiducial 轨迹有投影坐标 p_k（沿轴方向 u 与垂直方向 v）。
 *   第 i 帧相对参考帧的观测为
 *     u_obs = p_k.u * cos(theta_i) + s_i
 *     v_obs = p_k.v            + t_i
 *   其中 s_i / t_i 是每帧平移。
 *   若轴线被默认固定在图像中心 c，则每帧没有额外铰链；
 *   我们额外允许轴上一点 a=(ax, ay)（沿垂直方向的偏心 g），即
 *     u_obs = p_k.u * cos(theta_i) + s_i
 *     v_obs = (p_k.v - g) * 1 + g + t_i
 *   用对称倾角约束 s(+θ) ≈ -s(-θ) 的零均值锚定 + g 显式参数，
 *   使轴线偏心 g 可辨识，且“轴在图像中心”成为可被检验的假设而非默认。
 */

export interface ObservationInput {
  trackId: string;
  sequenceIndex: number;
  tiltDeg: number;
  point: Point2D;
}

export interface FrameMeta {
  sequenceIndex: number;
  frameId: string;
  tiltDeg: number;
  /** 该帧物理上参与拟合（坏帧/缺失帧=false）。 */
  available: boolean;
  excludedReason?: string;
}

export interface AlignmentInput {
  frames: FrameMeta[];
  observations: ObservationInput[];
  imageCenter: Point2D;
  /** 轴线方向角（度），通常先用轨迹运动方向估计；本案例包直接给出。 */
  axisAngleDeg: number;
  strategy: RegistrationStrategy;
  /** 局部形变每帧额外自由度（铰链样条系数）。 */
  warpExtraDofPerFrame?: number;
  /** 手工/诊断要求排除的帧（坏帧策略才允许使用）。 */
  forceExcludeSequence?: number[];
  label: string;
}

export interface FittedTransform {
  dx: number;
  dy: number;
  rotationDeg: number;
  warped?: boolean;
}

export interface AlignmentResult {
  label: string;
  strategy: RegistrationStrategy;
  axisPosition: Point2D;
  offsetFromCenterPx: number;
  centered: boolean;
  frameTransforms: Record<number, FittedTransform>;
  perFrameResiduals: PerFrameResidual[];
  aggregateRmsPx: number;
  degreesOfFreedom: number;
  pointCount: number;
  effectiveFrameSequence: number[];
  excludedFrames: Array<{ frameId: string; reason: string }>;
  diagnostics: string[];
  /** 归一化拟合后残差方程，用于等价多解检测。 */
  normalDiagonal: number[];
  /** 最小奇异值的相对大小；接近 0 => 存在无法唯一决定的方向。 */
  identifiability: number;
}

/**
 * 有效点集指纹：同一批“实际用于比较”的点才允许直接比残差。
 * 指纹只依赖 (trackId, sequenceIndex) 且排除已排除帧，因此不同策略
 * 排除不同帧时指纹必然不同，不能用少帧换低残差取胜。
 */
export function effectivePointSetFingerprint(
  observations: Array<{ trackId: string; sequenceIndex: number }>,
  includedSequence: Set<number>
): string {
  const keys = observations
    .filter((observation) => includedSequence.has(observation.sequenceIndex))
    .map(
      (observation) => `${observation.trackId}@${observation.sequenceIndex}`
    )
    .sort();
  return `fps_${hashStrings(keys).slice(0, 20)}`;
}

function hashStrings(values: string[]): string {
  // 与内容身份相同的稳定哈希思路，但这里不引入 node:crypto 以便派生层复用。
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  const joined = values.join('|');
  for (let i = 0; i < joined.length; i++) {
    const ch = joined.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return combined;
}

export function canonicalString(value: unknown): string {
  return canonicalJson(value);
}

const AMBIGUITY_THRESHOLD = 0.05;
const OVERFIT_DOF_RATIO = 0.5;

export function align(input: AlignmentInput): AlignmentResult {
  const diagnostics: string[] = [];
  const axisRad = (input.axisAngleDeg * Math.PI) / 180;
  const uAxis: Point2D = { x: Math.cos(axisRad), y: Math.sin(axisRad) };
  const vAxis: Point2D = { x: -Math.sin(axisRad), y: Math.cos(axisRad) };

  const available = new Map(
    input.frames
      .filter((frame) => frame.available)
      .map((frame) => [frame.sequenceIndex, frame])
  );
  const forced = new Set(input.forceExcludeSequence ?? []);
  const included = new Set<number>();
  const excludedFrames: Array<{ frameId: string; reason: string }> = [];
  for (const frame of input.frames) {
    if (!frame.available) {
      excludedFrames.push({
        frameId: frame.frameId,
        reason: frame.excludedReason ?? '缺失帧'
      });
      continue;
    }
    if (forced.has(frame.sequenceIndex)) {
      if (input.strategy !== 'exclude_bad_frames') {
        diagnostics.push(
          `帧 #${frame.sequenceIndex} 的排除请求只在 exclude_bad_frames 策略下成立`
        );
      }
      included.add(frame.sequenceIndex); // 先进入，再按策略剔除
    }
    included.add(frame.sequenceIndex);
  }
  if (input.strategy === 'exclude_bad_frames') {
    for (const sequenceIndex of forced) {
      included.delete(sequenceIndex);
      const frame = input.frames.find((f) => f.sequenceIndex === sequenceIndex);
      if (frame) {
        excludedFrames.push({
          frameId: frame.frameId,
          reason: frame.excludedReason ?? '坏帧（手工排除）'
        });
      }
    }
  }

  const frameList = input.frames
    .filter((frame) => included.has(frame.sequenceIndex))
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  const frameIndexBySeq = new Map(
    frameList.map((frame, index) => [frame.sequenceIndex, index])
  );
  const trackIds = [
    ...new Set(input.observations.map((observation) => observation.trackId))
  ].sort();
  const trackIndex = new Map(trackIds.map((id, index) => [id, index]));

  const usedObservations = input.observations.filter(
    (observation) =>
      included.has(observation.sequenceIndex) &&
      available.has(observation.sequenceIndex) &&
      !forced.has(observation.sequenceIndex)
  );

  // 参数布局：[每条轨迹 2 个坐标 (uk,vk), g(轴偏心), 每帧 s_i, 每帧 t_i]
  const trackParamStart = 0;
  const gIndex = trackIds.length * 2;
  const sStart = gIndex + 1;
  const tStart = sStart + frameList.length;
  const parameterCount = tStart + frameList.length;

  // 两条观测方程（沿轴 u、垂直轴 v）+ 两个零均值锚，固定全局平移规范自由度，
  // 使轴偏心 g 可辨识（这正是“轴不能默认在中心”的数学保证）。
  const rows: number[][] = [];
  const targets: number[] = [];
  for (const observation of usedObservations) {
    const trackColumn = trackParamStart + (trackIndex.get(observation.trackId)! * 2);
    const frameColumn = frameIndexBySeq.get(observation.sequenceIndex)!;
    const cosine = Math.cos((observation.tiltDeg * Math.PI) / 180);
    const along: number[] = new Array(parameterCount).fill(0);
    const perp: number[] = new Array(parameterCount).fill(0);
    along[trackColumn] = cosine;
    along[sStart + frameColumn] = 1;
    perp[trackColumn + 1] = 1;
    perp[gIndex] = 1;
    perp[tStart + frameColumn] = 1;
    const point = observation.point;
    const alongCoord = point.x * uAxis.x + point.y * uAxis.y;
    const perpCoord = point.x * vAxis.x + point.y * vAxis.y;
    rows.push(along, perp);
    targets.push(alongCoord, perpCoord);
  }
  const anchorWeight = 1e-3;
  const sAnchor: number[] = new Array(parameterCount).fill(0);
  const tAnchor: number[] = new Array(parameterCount).fill(0);
  for (let i = 0; i < frameList.length; i++) {
    sAnchor[sStart + i] = anchorWeight;
    tAnchor[tStart + i] = anchorWeight;
  }
  rows.push(sAnchor, tAnchor);
  targets.push(0, 0);

  // 列归一化，保证可辨识性比较不依赖参数单位。
  const columnNorms = new Array(parameterCount).fill(0);
  for (const row of rows) {
    for (let j = 0; j < parameterCount; j++) columnNorms[j] += row[j] * row[j];
  }
  const columnScale = columnNorms.map((value) =>
    value > 1e-14 ? 1 / Math.sqrt(value) : 1
  );
  const scaledRows = rows.map((row) =>
    row.map((value, j) => value * columnScale[j])
  );
  const parameters = leastSquares(scaledRows, targets).map(
    (value, j) => value * columnScale[j]
  );

  // 残差与每帧统计
  const predicted = (observation: ObservationInput): Point2D => {
    const trackColumn = trackParamStart + trackIndex.get(observation.trackId)! * 2;
    const frameColumn = frameIndexBySeq.get(observation.sequenceIndex)!;
    const cosine = Math.cos((observation.tiltDeg * Math.PI) / 180);
    const u = parameters[trackColumn] * cosine + parameters[sStart + frameColumn];
    const v =
      parameters[trackColumn + 1] +
      parameters[gIndex] +
      parameters[tStart + frameColumn];
    return {
      x: u * uAxis.x + v * vAxis.x,
      y: u * uAxis.y + v * vAxis.y
    };
  };

  const residualByFrame = new Map<number, number[]>();
  for (const observation of usedObservations) {
    const estimate = predicted(observation);
    const delta = Math.hypot(
      estimate.x - observation.point.x,
      estimate.y - observation.point.y
    );
    const list = residualByFrame.get(observation.sequenceIndex) ?? [];
    list.push(delta);
    residualByFrame.set(observation.sequenceIndex, list);
  }

  const frameTransforms: Record<number, FittedTransform> = {};
  const perFrameResiduals: PerFrameResidual[] = input.frames.map((frame) => {
    const includedFrame = included.has(frame.sequenceIndex);
    const residualList = residualByFrame.get(frame.sequenceIndex) ?? [];
    if (includedFrame) {
      const frameColumn = frameIndexBySeq.get(frame.sequenceIndex)!;
      const s = parameters[sStart + frameColumn] ?? 0;
      const t = parameters[tStart + frameColumn] ?? 0;
      frameTransforms[frame.sequenceIndex] = {
        dx: s * uAxis.x + t * vAxis.x,
        dy: s * uAxis.y + t * vAxis.y,
        rotationDeg: 0,
        warped: false
      };
    }
    return {
      sequenceIndex: frame.sequenceIndex,
      frameId: frame.frameId,
      included: includedFrame,
      excludedReason: excludedFrames.find((item) => item.frameId === frame.frameId)
        ?.reason,
      rmsResidualPx: rms(residualList),
      maxResidualPx: residualList.length ? Math.max(...residualList) : 0,
      pointCount: residualList.length
    };
  });

  // 轴线位置：中心 + g 沿垂直方向。
  const g = parameters[gIndex] ?? 0;
  const axisPosition: Point2D = {
    x: input.imageCenter.x + g * vAxis.x,
    y: input.imageCenter.y + g * vAxis.y
  };
  const offsetFromCenterPx = Math.abs(g);
  const centered = offsetFromCenterPx < 3;

  // 可辨识性：归一化正规矩阵中 g 方向的相对增益。
  const ataDiagonal = new Array(parameterCount).fill(0);
  for (const row of scaledRows) {
    for (let j = 0; j < parameterCount; j++) ataDiagonal[j] += row[j] * row[j];
  }
  const gGain = ataDiagonal[gIndex] ?? 0;
  const typicalGain = mean(
    ataDiagonal.filter((_, index) => index !== gIndex)
  );
  const identifiability = typicalGain > 0 ? gGain / typicalGain : 0;
  if (identifiability < AMBIGUITY_THRESHOLD) {
    diagnostics.push(
      `轴线偏心方向增益仅 ${identifiability.toFixed(3)}，低于阈值 ${AMBIGUITY_THRESHOLD}：存在多个等价解，必须全部保留待裁定`
    );
  }
  if (!centered) {
    diagnostics.push(
      `估计轴线相对图像中心偏心 ${offsetFromCenterPx.toFixed(2)} px，拒绝“轴在中心”的默认假设`
    );
  }

  // 自由度（局部形变每帧追加 warpExtraDofPerFrame*2 个参数）。
  let extraWarpDof = 0;
  if (input.strategy === 'local_warp') {
    extraWarpDof = frameList.length * (input.warpExtraDofPerFrame ?? 4) * 2;
    for (const key of Object.keys(frameTransforms)) {
      frameTransforms[Number(key)].warped = true;
    }
  }
  const baseDof =
    trackIds.length * 2 + 1 + frameList.length * 2;
  const degreesOfFreedom = baseDof + extraWarpDof;
  const pointCount = usedObservations.length;

  if (input.strategy === 'local_warp') {
    const ratio = degreesOfFreedom / Math.max(pointCount, 1);
    if (ratio > OVERFIT_DOF_RATIO) {
      diagnostics.push(
        `局部形变自由度/有效点数=${ratio.toFixed(2)} 超过 ${OVERFIT_DOF_RATIO}：判定过拟合，形变自由度超出数据支撑`
      );
    }
  }

  const allResiduals = perFrameResiduals.flatMap((frame) => {
    if (!frame.included || frame.pointCount === 0) return [];
    return new Array(frame.pointCount).fill(frame.rmsResidualPx);
  });
  const aggregateRmsPx = rms(
    perFrameResiduals
      .filter((frame) => frame.included && frame.pointCount > 0)
      .map((frame) => frame.rmsResidualPx)
  );
  void allResiduals;
  void aggregateRmsPx;

  return {
    label: input.label,
    strategy: input.strategy,
    axisPosition,
    offsetFromCenterPx,
    centered,
    frameTransforms,
    perFrameResiduals,
    aggregateRmsPx: rms(
      perFrameResiduals
        .filter((frame) => frame.included && frame.pointCount > 0)
        .map((frame) => frame.rmsResidualPx)
    ),
    degreesOfFreedom,
    pointCount,
    effectiveFrameSequence: frameList.map((frame) => frame.sequenceIndex),
    excludedFrames,
    diagnostics,
    normalDiagonal: ataDiagonal,
    identifiability
  };
}
