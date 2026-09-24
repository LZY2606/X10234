import { createHash } from "node:crypto";
import { FRAME_H, FRAME_W, synthesize, type Marker3D, type SynthOptions } from "../src/shared/synthetic.js";
import type {
  DoseQ,
  ExposureDose,
  ManualExclusion,
  ParameterValues,
  PixelScale,
  ScenarioId,
  ScenarioSize,
  SourceSnapshot,
} from "../src/shared/domain.js";

/**
 * 离线案例包：专门针对「倾转帧拼合室：电镜 tilt-series 轴线、
 * fiducial 轨迹与配准分支」。不是通用表格。
 *
 * 每个情形同时保存一个最小输入与一个组合输入；二者共享的原始帧片段
 * 只存一份不可变内容（blob 内容寻址，见 build 脚本），但解释版本、
 * 失败诊断与人工决定各自独立。
 */

const BASE_MARKERS: Marker3D[] = [
  { id: "trk-1", x: -22, y: -16, z: -10 },
  { id: "trk-2", x: 20, y: -18, z: 6 },
  { id: "trk-3", x: -8, y: 20, z: 14 },
  { id: "trk-4", x: 24, y: 14, z: -16 },
];

const SYM_13 = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60];
const SYM_15 = [-70, -60, -50, -40, -30, -20, 0, 20, 30, 40, 50, 60, 70];

export const BASELINE_PARAMS: ParameterValues = {
  axisMode: "free-eccentric",
  allowTrackReidentification: true,
  warpGridSpacingPx: 18,
  highTiltThresholdDeg: 50,
  badFrameResidualFactor: 3,
  maxWarpDofRatio: 0.6,
  ambiguityBandFactor: 1.05,
};

// dose-symmetric 采集顺序（围绕 0 交替）
const symmetricOrder = (angles: number[]): number[] => {
  const indexed = angles.map((a, i) => ({ a, i }));
  indexed.sort((p, q) => Math.abs(p.a) - Math.abs(q.a) || p.a - q.a);
  return indexed.map((x) => x.i);
};

interface ScenarioSpec {
  scenarioId: ScenarioId;
  label: string;
  minimal: SynthOptions;
  combined: SynthOptions;
  combinedExclusions?: (angles: number[]) => ManualExclusion[];
  unparseableAt?: { pixelScaleRaw?: string };
}

export const SCENARIOS: ScenarioSpec[] = [
  {
    scenarioId: "axis-eccentric",
    label: "轴线偏心：倾转轴不能被默认固定在图像中心",
    minimal: {
      tiltAnglesDeg: SYM_13,
      markers: BASE_MARKERS,
      centerShiftPx: { x: 14, y: -9 },
      axisAngleDeg: 6,
      acquisitionOrder: symmetricOrder(SYM_13),
    },
    combined: {
      tiltAnglesDeg: SYM_15,
      markers: BASE_MARKERS,
      centerShiftPx: { x: 14, y: -9 },
      axisAngleDeg: 6,
      missingSeqs: [0, 12],
      jitterBySeq: { 7: { x: 7, y: -6 } },
      acquisitionOrder: symmetricOrder(SYM_15),
    },
  },
  {
    scenarioId: "track-swap",
    label: "轨迹身份交换：fiducial 轨迹可断裂且可能身份交换",
    minimal: {
      tiltAnglesDeg: SYM_13,
      markers: BASE_MARKERS,
      swapTracks: { trackA: "trk-1", trackB: "trk-2", fromSeq: 9, toSeq: 12 },
      acquisitionOrder: symmetricOrder(SYM_13),
    },
    combined: {
      tiltAnglesDeg: SYM_15,
      markers: BASE_MARKERS,
      centerShiftPx: { x: 10, y: 6 },
      swapTracks: { trackA: "trk-1", trackB: "trk-2", fromSeq: 10, toSeq: 14 },
      gap: { trackId: "trk-3", fromSeq: 11, toSeq: 13 },
      jitterBySeq: { 6: { x: 6, y: 5 } },
      acquisitionOrder: symmetricOrder(SYM_15),
    },
  },
  {
    scenarioId: "missing-high-tilt",
    label: "缺失高倾角帧",
    minimal: {
      tiltAnglesDeg: SYM_13,
      markers: BASE_MARKERS,
      missingSeqs: [0, 12],
      acquisitionOrder: symmetricOrder(SYM_13),
    },
    combined: {
      tiltAnglesDeg: SYM_15,
      markers: BASE_MARKERS,
      centerShiftPx: { x: -8, y: 7 },
      missingSeqs: [0, 1, 13, 14],
      jitterBySeq: { 5: { x: 5, y: -4 } },
      acquisitionOrder: symmetricOrder(SYM_15),
    },
  },
  {
    scenarioId: "bad-frame-exclusion",
    label: "坏帧排除：不用少帧换低残差",
    minimal: {
      tiltAnglesDeg: SYM_13,
      markers: BASE_MARKERS,
      jitterBySeq: { 6: { x: 8, y: -7 } },
      acquisitionOrder: symmetricOrder(SYM_13),
    },
    combinedExclusions: () => [
      {
        id: "exc-hand-s6",
        frameId: "frame-s6",
        reason: "记录在案的运动污染帧，电镜小组手工排除",
        excludedBy: "em-team",
      },
    ],
    combined: {
      tiltAnglesDeg: SYM_15,
      markers: BASE_MARKERS,
      centerShiftPx: { x: 5, y: -5 },
      jitterBySeq: {
        6: { x: 8, y: -7 },
        8: { x: -6, y: 6 },
      },
      acquisitionOrder: symmetricOrder(SYM_15),
    },
  },
  {
    scenarioId: "local-warp-overfit",
    label: "局部形变过拟合",
    minimal: {
      tiltAnglesDeg: SYM_13,
      markers: BASE_MARKERS.slice(0, 3),
      warpBySeq: { 5: { x: 3, y: -2 }, 8: { x: -2, y: 3 } },
      acquisitionOrder: symmetricOrder(SYM_13),
    },
    combined: {
      tiltAnglesDeg: SYM_15,
      markers: BASE_MARKERS,
      centerShiftPx: { x: 9, y: 4 },
      warpBySeq: {
        4: { x: 3, y: -3 },
        5: { x: -3, y: 2 },
        9: { x: 2, y: 3 },
        10: { x: -3, y: -2 },
      },
      jitterBySeq: { 7: { x: 5, y: -5 } },
      missingSeqs: [0, 14],
      acquisitionOrder: symmetricOrder(SYM_15),
    },
  },
  {
    scenarioId: "multi-solution",
    label: "多解：无法唯一决定时保留全部合法候选",
    minimal: {
      tiltAnglesDeg: [-20, -10, 0, 10, 20],
      markers: [
        // 对称布置 + 小角范围 => 轴线方向存在两组近等价解
        { id: "trk-1", x: -20, y: 0, z: 0 },
        { id: "trk-2", x: 20, y: 0, z: 0 },
        { id: "trk-3", x: 0, y: 18, z: 0 },
        { id: "trk-4", x: 0, y: -18, z: 0 },
      ],
      axisAngleDeg: 0,
      acquisitionOrder: symmetricOrder([-20, -10, 0, 10, 20]),
    },
    combined: {
      tiltAnglesDeg: SYM_13,
      markers: BASE_MARKERS,
      centerShiftPx: { x: 0, y: 0 },
      axisAngleDeg: 90,
      warpBySeq: { 6: { x: 2, y: -2 } },
      acquisitionOrder: symmetricOrder(SYM_13),
    },
  },
  {
    scenarioId: "concurrency-freeze",
    label: "并发冻结：两个窗口同时保存，后提交者看到版本冲突",
    minimal: {
      tiltAnglesDeg: SYM_13,
      markers: BASE_MARKERS,
      centerShiftPx: { x: 4, y: -4 },
      acquisitionOrder: symmetricOrder(SYM_13),
    },
    combined: {
      tiltAnglesDeg: SYM_15,
      markers: BASE_MARKERS,
      centerShiftPx: { x: 4, y: -4 },
      axisAngleDeg: 4,
      jitterBySeq: { 6: { x: 6, y: -6 } },
      swapTracks: { trackA: "trk-2", trackB: "trk-3", fromSeq: 11, toSeq: 12 },
      acquisitionOrder: symmetricOrder(SYM_15),
    },
  },
];

export interface BuiltScenario {
  scenarioId: ScenarioId;
  label: string;
  snapshots: Array<{ size: ScenarioSize; snapshot: SourceSnapshot; blobBytes: Map<string, Buffer> }>;
}

function makeSnapshot(
  scenarioId: ScenarioId,
  size: ScenarioSize,
  label: string,
  opts: SynthOptions,
  extraExclusions: ManualExclusion[] | undefined,
  note: string
): { snapshot: SourceSnapshot; blobBytes: Map<string, Buffer> } {
  const synth = synthesize(opts);
  const width = opts.width ?? FRAME_W;
  const height = opts.height ?? FRAME_H;

  const doses: ExposureDose[] = [];
  let cum = 0;
  for (let k = 0; k < synth.frames.length; k++) {
    const frame = synth.frames[k];
    const angle = synth.tilts[k].angle.value;
    const inc = 2.0 * Math.abs(Math.cos((angle * Math.PI) / 180)) + 0.4;
    cum += inc;
    const dose: DoseQ = { value: Math.round(inc * 100) / 100, unit: "e-/A^2", raw: `${inc.toFixed(2)} e/A2` };
    doses.push({
      id: `dose-${frame.id}`,
      frameId: frame.id,
      dose,
      cumulativeDose: { value: Math.round(cum * 100) / 100, unit: "e-/A^2", raw: `${cum.toFixed(2)} e/A2` },
    });
  }

  const pixelScales: PixelScale[] = [
    {
      id: "pxscale-series",
      scale: { value: 2.7, unit: "angstrom/pixel", raw: "2.7 A/pix" },
      calibratedFrom: "mag-49k calibration table",
    },
  ];
  const exclusions: ManualExclusion[] = [...(extraExclusions ?? [])];

  const blobBytes = new Map<string, Buffer>();
  for (const [seq, bytes] of synth.blobBytesBySeq) {
    const frame = synth.frames.find((f) => f.seq === seq)!;
    blobBytes.set(frame.blobId, bytes);
  }

  const id = `${scenarioId}--${size}--v1`;
  const snapshot: SourceSnapshot = {
    id,
    kind: "initial-import",
    scenarioId,
    scenarioSize: size,
    sharedFragmentIds: [],
    frames: synth.frames,
    tilts: synth.tilts,
    pixelScales,
    doses,
    observations: synth.observations,
    gaps: synth.gaps,
    exclusions,
    parameterSet: {
      id: `params-${scenarioId}-${size}-v1`,
      values: BASELINE_PARAMS,
      rawNote: label,
    },
    createdAt: "2026-09-24T00:00:00.000Z",
    note,
  };
  return { snapshot, blobBytes };
}

export function buildAllScenarios(): BuiltScenario[] {
  return SCENARIOS.map((spec) => ({
    scenarioId: spec.scenarioId,
    label: spec.label,
    snapshots: [
      makeSnapshot(spec.scenarioId, "minimal", spec.label, spec.minimal, undefined, `最小输入：${spec.label}`),
      makeSnapshot(
        spec.scenarioId,
        "combined",
        spec.label,
        spec.combined,
        spec.combinedExclusions?.(spec.combined.tiltAnglesDeg),
        `组合输入：${spec.label}（叠加缺口/坏帧/缺失高倾角等边界）`
      ),
    ],
  }));
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}
