import { fragmentHash, generateBaselineMaterial, type SeriesMaterial } from "../domain/synthetic.js";
import type { InputSidecar, PackAxis, PackFrameMeta, PackLinkSet, PackObservation, ScenarioCode } from "./pack-types.js";

export const NAIVE_LINKSET: PackLinkSet = {
  linkSetId: "ls-naive",
  label: "跟踪器朴素拼接（按最近端点）",
  links: [
    { linkId: "link-4-naive", leftSegmentId: "seg-4a", rightSegmentId: "seg-4b", note: "f05/f06 断段后朴素最近端点续接" },
    { linkId: "link-5-naive", leftSegmentId: "seg-5a", rightSegmentId: "seg-5b", note: "f05/f06 断段后朴素最近端点续接" }
  ],
  note: "在交叉区把两条轨迹的身份交换后缝合"
};

export const REVIEWED_LINKSET: PackLinkSet = {
  linkSetId: "ls-reviewed",
  label: "人工复核链接（按投影一致性）",
  links: [
    { linkId: "link-4-reviewed", leftSegmentId: "seg-4a", rightSegmentId: "seg-5b", note: "交叉区实际属于同一物理标记点 T4" },
    { linkId: "link-5-reviewed", leftSegmentId: "seg-5a", rightSegmentId: "seg-4b", note: "交叉区实际属于同一物理标记点 T5" }
  ],
  note: "纠正朴素拼接造成的轨迹身份交换"
};

export const AXIS_CENTERED: PackAxis = {
  axisId: "axis-1",
  version: 1,
  offsetXPx: 0,
  offsetYPx: 0,
  directionDeg: 8,
  centeredAssumption: true,
  note: "导入时的初始解释：暂按画幅中心放置轴心（显式假设，非事实）"
};

export const AXIS_FREE: PackAxis = {
  axisId: "axis-1",
  version: 2,
  offsetXPx: null,
  offsetYPx: null,
  directionDeg: 8,
  centeredAssumption: false,
  note: "修订：释放轴心自由度，由 fiducial 轨迹拟合决定，不预设中心"
};

function frameMetas(mat: SeriesMaterial, includeIds: Set<string>): PackFrameMeta[] {
  return mat.frames.map((f) => ({
    frameId: f.frameId,
    order: f.order,
    angleRaw: f.angleRaw,
    angleDeg: f.angleDeg,
    doseRaw: f.doseRaw,
    dose: f.dose,
    quality: f.quality,
    fragmentHash: fragmentHash(f.frameId, mat.fragmentPixels[f.frameId]),
    include: includeIds.has(f.frameId)
  }));
}

export function baselineSidecar(mat: SeriesMaterial): InputSidecar {
  const all = new Set(mat.frames.map((f) => f.frameId));
  return {
    sidecarId: "sidecar-baseline",
    description: "基线初始版本：原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口与手工排除原因全部版本化",
    pixelScaleRaw: mat.pixelScaleRaw,
    frames: frameMetas(mat, all),
    segments: mat.segments.map((s) => ({ segmentId: s.segmentId, observedFrameIds: [...s.observedFrameIds] })),
    observations: mat.observations.map((o) => ({ ...o })),
    gaps: mat.gaps.map((g) => ({ ...g })),
    exclusions: [
      {
        frameId: "f09",
        reason: "运动模糊：fiducial 明显拖影（motion-blur）",
        rawText: "f09 motion-blur, fiducial streaks, reviewed by hongmei",
        decidedBy: "hongmei"
      }
    ],
    linkSets: [NAIVE_LINKSET],
    axes: [AXIS_CENTERED],
    interpretations: [
      {
        interpretationId: "interp-baseline",
        label: "初始导入解释（朴素链接 + 居中轴假设 + f09 手工排除）",
        axisId: "axis-1",
        axisVersion: 1,
        linkSetId: "ls-naive",
        excludedFrameIds: ["f09"],
        note: "电镜小组首次导入倾转序列、曝光剂量和 fiducial 点轨迹"
      }
    ],
    diagnostics: []
  };
}

export function baseSidecarSubset(
  mat: SeriesMaterial,
  scenarioCode: ScenarioCode,
  includeIds: Set<string>
): InputSidecar {
  return {
    sidecarId: `sidecar-${scenarioCode}-minimal`,
    description: `${scenarioCode} 最小输入：仅含触发该边界所需的共享原始片段子集`,
    pixelScaleRaw: mat.pixelScaleRaw,
    frames: frameMetas(mat, includeIds),
    segments: mat.segments
      .map((s) => ({ segmentId: s.segmentId, observedFrameIds: s.observedFrameIds.filter((id) => includeIds.has(id)) }))
      .filter((s) => s.observedFrameIds.length > 0),
    observations: mat.observations.filter((o) => includeIds.has(o.frameId)).map((o) => ({ ...o })),
    gaps: mat.gaps.filter((g) => includeIds.has(g.missingFrameId)).map((g) => ({ ...g })),
    exclusions: [],
    linkSets: [NAIVE_LINKSET],
    axes: [AXIS_CENTERED],
    interpretations: [
      {
        interpretationId: `interp-${scenarioCode}-minimal`,
        label: `${scenarioCode} 最小解释`,
        axisId: "axis-1",
        axisVersion: 1,
        linkSetId: "ls-naive",
        excludedFrameIds: [],
        note: `${scenarioCode} 最小输入解释`
      }
    ],
    diagnostics: []
  };
}

export function fullAs(mat: SeriesMaterial, scenarioCode: ScenarioCode): InputSidecar {
  const s = baselineSidecar(mat);
  s.sidecarId = `sidecar-${scenarioCode}-combined`;
  s.description = `${scenarioCode} 组合输入：在基线之上只改动一个直接来源`;
  return s;
}

export { generateBaselineMaterial };
export type { PackObservation };
