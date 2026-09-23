import { BASIS_ID, fragmentHash, generateBaselineMaterial } from "../domain/synthetic.js";
import { baselineSidecar } from "./pack-sidecar.js";
import { allVariants } from "./pack-scenarios.js";
import type {
  CaseManifest,
  CasePack,
  ReplayAction,
  ScenarioCode
} from "./pack-types.js";

const SERIES_ID = "tilt-room-v1";

const BASELINE_REPLAY: ReplayAction[] = [
  { id: "b-import", kind: "import-baseline", summary: "导入基线倾转序列（含剂量、轨迹段、缺口、手工排除原因）" },
  { id: "b-compute", kind: "compute-candidates", interpretationId: "interp-baseline", summary: "生成刚体 / 局部形变 / 排除坏帧三类候选（相同有效点集）" },
  { id: "b-reject-local", kind: "adjudicate", interpretationId: "interp-baseline", candidateKind: "local-deformation", candidateId: "c-interp-baseline-local-deformation", verdict: "rejected", reason: "局部形变自由度高，留出 RMS 不改善，存在过拟合风险", summary: "否定局部形变候选" },
  { id: "b-accept-rigid", kind: "adjudicate", interpretationId: "interp-baseline", candidateKind: "rigid-excluded", candidateId: "c-interp-baseline-rigid-excluded", verdict: "accepted", reason: "f09 为人工确认的运动模糊坏帧，排除后高倾角覆盖仍完整", summary: "接受排除坏帧刚体候选" },
  { id: "b-lock", kind: "lock", interpretationId: "interp-baseline", candidateKind: "rigid-excluded", candidateId: "c-interp-baseline-rigid-excluded", reason: "基线复核完成", summary: "锁定一版配准供重建引用" }
];

const TITLES: Record<ScenarioCode, { title: string; ruleId: string }> = {
  "axis-offset": { title: "轴线偏心", ruleId: "axis.not-centered-by-default" },
  "identity-swap": { title: "轨迹身份交换", ruleId: "track.breakable-swappable" },
  "missing-high-tilt": { title: "缺失高倾角帧", ruleId: "candidate.no-fewer-frames-for-lower-residual" },
  "bad-frame": { title: "坏帧排除", ruleId: "candidate.same-effective-points" },
  "local-overfit": { title: "局部形变过拟合", ruleId: "candidate.same-effective-points" },
  "multi-solution": { title: "多解与并发冻结", ruleId: "solution.keep-all-legal-candidates" }
};

export function buildCasePack(): CasePack {
  const mat = generateBaselineMaterial();
  const fragmentBinaries: Record<string, Buffer> = {};
  const fragmentFiles: CaseManifest["fragmentFiles"] = [];
  for (const f of mat.frames) {
    const hash = fragmentHash(f.frameId, mat.fragmentPixels[f.frameId]);
    fragmentBinaries[hash] = Buffer.from(mat.fragmentPixels[f.frameId].buffer);
    fragmentFiles.push({ frameId: f.frameId, hash, file: `fragments/${f.frameId}.bin` });
  }

  const manifest: CaseManifest = {
    packId: SERIES_ID,
    title: "倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支",
    basis: { basisId: BASIS_ID, widthPx: mat.widthPx, heightPx: mat.heightPx },
    baselineSidecarId: "sidecar-baseline",
    fragmentFiles,
    scenarios: (Object.keys(TITLES) as ScenarioCode[]).map((code) => ({
      code,
      title: TITLES[code].title,
      ruleId: TITLES[code].ruleId,
      minimalSidecarId: `sidecar-${code}-minimal`,
      combinedSidecarId: `sidecar-${code}-combined`
    }))
  };

  return {
    manifest,
    baseline: baselineSidecar(mat),
    baselineReplay: BASELINE_REPLAY,
    baselineExpectations: {
      must: [
        { code: "axis.estimated-offset", evidence: "基线刚体候选自由估计轴心，得到相对中心偏心 (~14,-9) px" },
        { code: "frame.bad-excluded", evidence: "f09 手工排除原因保留并被 rigid-excluded 候选引用" }
      ],
      adoptedCandidateKind: "rigid-excluded",
      rejectedCandidateKinds: ["local-deformation"]
    },
    variants: allVariants(mat),
    fragmentBinaries
  };
}
