import type { SeriesSpec } from "./series.ts";

/**
 * 固定离线案例包：
 *  - 七个最小输入：轴线偏心 / 轨迹身份交换 / 缺失高倾角帧 / 坏帧排除 /
 *    局部形变过拟合 / 多解 / 并发冻结（并发冻结复用核心帧）
 *  - 一个组合输入：同时触发全部边界
 * 最小输入与组合输入在倾角 -10/0/+10 的三帧上参数与种子一致，
 * 因此合成出的原始字节相同，内容存储只保留一份不可变 blob。
 */

const W = 128;
const H = 96;
const AXIS_X = 70; // 故意偏离图像中心 64
const AXIS_Y = 48;

const MARKERS_FIVE = [
  { trackId: "track-A", x0: 40, y0: 28, z: -14 },
  { trackId: "track-B", x0: 88, y0: 30, z: 10 },
  { trackId: "track-C", x0: 62, y0: 62, z: -6 },
  { trackId: "track-D", x0: 96, y0: 66, z: 16 },
  { trackId: "track-E", x0: 32, y0: 58, z: 4 },
];

const ANGLES_CORE = [-20, -10, 0, 10, 20];
const ANGLES_FULL = [-40, -30, -20, -10, 0, 10, 20, 30, 40];

function doses(n: number): string[] {
  return Array.from({ length: n }, (_, i) => (1.6 + 0.12 * i).toFixed(2));
}

/** 1. 轴线偏心（最小输入，也是主叙事基线核心） */
export const axisEccentricity: SeriesSpec = {
  seriesId: "core-axis-eccentricity",
  width: W,
  height: H,
  axisX: AXIS_X,
  axisY: AXIS_Y,
  axisAngleDeg: 2.5,
  tiltAnglesDeg: ANGLES_CORE,
  nmPerPixel: "0.54",
  doseSchedule: doses(ANGLES_CORE.length),
  markers: MARKERS_FIVE,
  seed: 910228,
};

/** 2. 轨迹身份交换：第 2 帧后 A/B 身份互换，并留下跟踪缺口 */
export const identitySwap: SeriesSpec = {
  ...axisEccentricity,
  seriesId: "min-identity-swap",
  seed: 910229,
  swapAfter: [{ trackId: "track-A", otherTrackId: "track-B", ordinal: 2 }],
  gaps: [{ trackId: "track-A", fromOrdinal: 2, toOrdinal: 3, reason: "track-lost-at-high-tilt" }],
};

/** 3. 缺失高倾角帧：±40 帧未导入 */
export const missingHighTilt: SeriesSpec = {
  ...axisEccentricity,
  seriesId: "min-missing-high-tilt",
  seed: 910230,
  tiltAnglesDeg: ANGLES_FULL,
  doseSchedule: doses(ANGLES_FULL.length),
  missingFrames: [0, 8],
};

/** 4. 坏帧排除：第 3 帧明显运动条纹（手工排除原因版本化） */
export const badFrameExclusion: SeriesSpec = {
  ...axisEccentricity,
  seriesId: "min-bad-frame",
  seed: 910231,
  badFrames: [3],
  exclusions: [{ ordinal: 3, reasonCode: "MOTION_STREAK", reason: "stage-jump, bead elongation beyond 2px" }],
};

/** 5. 局部形变过拟合：仅 3 条轨迹却允许逐帧 6 控制点 warp */
export const localWarpOverfit: SeriesSpec = {
  ...axisEccentricity,
  seriesId: "min-local-warp",
  seed: 910232,
  markers: MARKERS_FIVE.slice(0, 3),
  warpFrames: [2],
};

/** 6. 多解：对称标记 + 中段缺口，两种身份假设残差相同 */
export const multiSolution: SeriesSpec = {
  ...axisEccentricity,
  seriesId: "min-multi-solution",
  seed: 910233,
  axisX: 64,
  markers: [
    { trackId: "track-S1", x0: 48, y0: 34, z: -12 },
    { trackId: "track-S2", x0: 80, y0: 34, z: 12 },
    { trackId: "track-S3", x0: 64, y0: 64, z: 0 },
  ],
  swapAfter: [{ trackId: "track-S1", otherTrackId: "track-S2", ordinal: 2 }],
  gaps: [{ trackId: "track-S1", fromOrdinal: 2, toOrdinal: 3, reason: "ambiguous-crossing" }],
};

/** 7. 并发冻结：数据本身普通，场景在重放脚本中制造双会话 */
export const concurrentFreeze: SeriesSpec = {
  ...axisEccentricity,
  seriesId: "min-concurrent-freeze",
  seed: 910234,
};

/** 组合输入：同一序列上叠加全部边界，并含一个无法转换的剂量值 */
export const combined: SeriesSpec = {
  seriesId: "combined-tomogram-review",
  width: W,
  height: H,
  axisX: AXIS_X,
  axisY: AXIS_Y,
  axisAngleDeg: 2.5,
  tiltAnglesDeg: ANGLES_FULL,
  nmPerPixel: "0.54",
  doseSchedule: doses(ANGLES_FULL.length),
  markers: MARKERS_FIVE,
  seed: 910228, // 与核心共享 -10/0/+10 三帧的原始字节
  badFrames: [5],
  warpFrames: [6],
  missingFrames: [0, 8],
  swapAfter: [{ trackId: "track-A", otherTrackId: "track-B", ordinal: 4 }],
  gaps: [{ trackId: "track-A", fromOrdinal: 4, toOrdinal: 5, reason: "track-lost-at-high-tilt" }],
  exclusions: [{ ordinal: 5, reasonCode: "MOTION_STREAK", reason: "stage-jump during acquisition" }],
};

export interface ScenarioDef {
  key:
    | "axis-eccentricity"
    | "identity-swap"
    | "missing-high-tilt"
    | "bad-frame-exclusion"
    | "local-warp-overfit"
    | "multi-solution"
    | "concurrent-freeze";
  title: string;
  minimal: SeriesSpec;
  combined?: boolean;
}

export const MINIMAL_SCENARIOS: ScenarioDef[] = [
  { key: "axis-eccentricity", title: "轴线偏心", minimal: axisEccentricity },
  { key: "identity-swap", title: "轨迹身份交换", minimal: identitySwap },
  { key: "missing-high-tilt", title: "缺失高倾角帧", minimal: missingHighTilt },
  { key: "bad-frame-exclusion", title: "坏帧排除", minimal: badFrameExclusion },
  { key: "local-warp-overfit", title: "局部形变过拟合", minimal: localWarpOverfit },
  { key: "multi-solution", title: "多解", minimal: multiSolution },
  { key: "concurrent-freeze", title: "并发冻结", minimal: concurrentFreeze },
];

export { combined as COMBINED_SPEC };
