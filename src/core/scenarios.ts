import { SERIES_ID, trackId } from "../shared/ids";
import type { AcquisitionSpec } from "./case-pack";
import { DEMO_MARKERS, FRAME_H, FRAME_W, TRUE_AXIS } from "./case-pack";

const DEMO_TILTS = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60];

/** 主叙事倾转序列：轴线偏心、漂移、缺口、身份交换、坏帧、高倾角缺失帧、离群、坏剂量。 */
export const DEMO_SPEC: AcquisitionSpec = {
  id: "demo-tomogram-01",
  seriesId: SERIES_ID,
  tilts: DEMO_TILTS,
  markers: DEMO_MARKERS,
  axis: TRUE_AXIS,
  width: FRAME_W,
  height: FRAME_H,
  seed: 20260923,
  noisePx: 0.55,
  drift: (i) => ({ dx: 3.2 * Math.sin((i / 12) * Math.PI) - 1.4, dy: 0.9 * Math.cos((i / 9) * Math.PI) }),
  // fid:01 / fid:03 在 -50 出视野断裂；缺口之后（+30 起）两 track 身份交换
  gaps: { [trackId(1)]: [1], [trackId(3)]: [1] },
  swaps: [{ fromIndex: 9, pair: [trackId(1), trackId(3)] }],
  badFrames: {
    4: { reasonCode: "motion-blur", reason: "-20° 曝光期间样品台抖动，运动模糊", blur: true }
  },
  missingFrames: [12], // +60° 整帧未采集（缺失高倾角帧）
  badDoseRaw: { 10: "N/A (microscope log gap)" },
  outliers: {
    7: [{ track: trackId(5), dx: 5.5, dy: -4.0 }],
    8: [{ track: trackId(5), dx: -5.0, dy: 4.5 }]
  }
};

function narrowTilts(): number[] {
  return [-40, -30, -20, -10, 0, 10, 20, 30, 40];
}

const baseNarrow = (over: Partial<AcquisitionSpec>): AcquisitionSpec => ({
  id: "frag",
  seriesId: SERIES_ID,
  tilts: narrowTilts(),
  markers: DEMO_MARKERS,
  axis: TRUE_AXIS,
  width: FRAME_W,
  height: FRAME_H,
  seed: 777,
  noisePx: 0.5,
  drift: (i) => ({ dx: 1.6 * Math.sin((i / 8) * Math.PI), dy: 0.5 * Math.cos((i / 6) * Math.PI) }),
  ...over
});

/** 七个“最小输入”反例片段。 */
export const MINIMAL_FRAGMENTS: { scenario: string; spec: AcquisitionSpec; expected: string }[] = [
  {
    scenario: "axis-off-center",
    expected: "拟合锚点明显偏离中心；中心默认轴产生系统性残差。",
    spec: baseNarrow({ id: "min-axis", seed: 11 })
  },
  {
    scenario: "track-identity-swap",
    expected: "缺口后 fid:01/fid:03 身份交换；检测到交换，不假设跨缺口连续。",
    spec: baseNarrow({
      id: "min-swap",
      seed: 12,
      gaps: { [trackId(1)]: [2, 3], [trackId(3)]: [2, 3] },
      swaps: [{ fromIndex: 5, pair: [trackId(1), trackId(3)] }]
    })
  },
  {
    scenario: "missing-high-tilt",
    expected: "最高倾角仅 ±20°，z 分辨率受限并被诊断。",
    spec: baseNarrow({
      id: "min-high-tilt",
      seed: 13,
      tilts: [-20, -10, 0, 10, 20]
    })
  },
  {
    scenario: "bad-frame-exclusion",
    expected: "-10° 坏帧被人工排除；所有候选在相同有效点集上比较。",
    spec: baseNarrow({
      id: "min-bad-frame",
      seed: 14,
      badFrames: { 3: { reasonCode: "motion-blur", reason: "-10° 运动模糊", blur: true } }
    })
  },
  {
    scenario: "local-warp-overfit",
    expected: "离群点被局部仿射吸收，形变能量超阈而 RMS 收益不足 => 过拟合拒绝。",
    spec: baseNarrow({
      id: "min-warp",
      seed: 15,
      outliers: {
        4: [{ track: trackId(4), dx: 6, dy: -5 }],
        5: [{ track: trackId(4), dx: -6, dy: 5 }],
        6: [{ track: trackId(2), dx: 5, dy: 5 }]
      }
    })
  },
  {
    scenario: "multi-solution",
    expected: "窄倾转范围 + 对称几何产生多个阈值内合法轴解，全部保留。",
    spec: baseNarrow({
      id: "min-multi",
      seed: 16,
      tilts: [-20, -10, 0, 10, 20],
      markers: DEMO_MARKERS.slice(0, 4),
      noisePx: 0.9
    })
  },
  {
    scenario: "concurrency-freeze",
    expected: "同一基线两个窗口并发裁定，后提交者得到版本冲突与双方差异。",
    spec: baseNarrow({ id: "min-concurrency", seed: 17, tilts: [-30, -15, 0, 15, 30] })
  }
];

/** 一个“组合输入”：叠加全部边界情形。 */
export const COMPOSITE_SPEC: AcquisitionSpec = {
  ...DEMO_SPEC,
  id: "composite-all",
  seed: 9091,
  outliers: {
    ...DEMO_SPEC.outliers,
    6: [{ track: trackId(4), dx: 6, dy: -5 }],
    9: [{ track: trackId(2), dx: -5, dy: 5 }]
  }
};
