import { stableId, canonicalJson } from "../hashing.ts";
import type {
  AlignmentCandidate,
  FrameTransform,
  SourceEntity,
  TransformKind,
} from "../types.ts";
import { prepareSeries, type PreparedSeries } from "./model.ts";
import { fitVariant, type ObservationPoint } from "./fit.ts";
import { median } from "../numeric.ts";

export interface CandidateBuildInput {
  branchId: string;
  commitId: string;
  entities: SourceEntity[];
  imageSize: { width: number; height: number };
  /** 身份交换假设：[原 trackId, 替代 trackId]（在 swapOrdinal 之后交换） */
  swapHypotheses?: { a: string; b: string; swapOrdinal: number }[];
  ruleSetVersion: string;
}

export interface CandidateBuildResult {
  candidates: AlignmentCandidate[];
  prepared: PreparedSeries;
  effectivePointKey: string;
  diagnostics: { level: "warn" | "error"; code: string; message: string; subjectId?: string }[];
}

interface HypothesisPoints {
  label: string;
  hypothesisId: string;
  points: ObservationPoint[];
  tracks: string[];
}

function buildHypotheses(prepared: PreparedSeries, swaps: CandidateBuildInput["swapHypotheses"]): HypothesisPoints[] {
  const base: ObservationPoint[] = [];
  for (const frameId of prepared.frameIdsInOrder) {
    const meta = prepared.frameById.get(frameId)!;
    const row = prepared.observations.get(frameId);
    if (!row) continue;
    for (const trackId of prepared.trackIds) {
      const obs = row.get(trackId);
      if (obs) base.push({ frameId, trackId, x: obs.x, y: obs.y, tiltRad: meta.tiltRad });
    }
  }
  const hyps: HypothesisPoints[] = [
    { label: "identity-as-tracked", hypothesisId: "H0", points: base, tracks: prepared.trackIds },
  ];

  for (const [idx, sw] of (swaps ?? []).entries()) {
    if (!prepared.trackIds.includes(sw.a) || !prepared.trackIds.includes(sw.b)) continue;
    const remapped: ObservationPoint[] = base.map((p) => {
      if (p.frameId === undefined) return p;
      const ordinal = prepared.frameById.get(p.frameId)!.ordinal;
      if (ordinal <= sw.swapOrdinal) return p;
      if (p.trackId === sw.a) return { ...p, trackId: sw.b };
      if (p.trackId === sw.b) return { ...p, trackId: sw.a };
      return p;
    });
    hyps.push({
      label: `identity-swap(${sw.a}<->${sw.b} after #${sw.swapOrdinal})`,
      hypothesisId: `H${idx + 1}`,
      points: remapped,
      tracks: prepared.trackIds,
    });
  }
  return hyps;
}

/** 共同有效点集：所有候选必须在同一 (frame,track) 键集上比较，禁止少帧换低残差 */
function commonPointSet(prepared: PreparedSeries, extraExcluded?: Set<string>): {
  frames: string[];
  tracks: string[];
  key: string;
  perHypothesis: ObservationPoint[][];
  hypotheses: HypothesisPoints[];
} {
  const manual = new Set(prepared.manualExclusions.keys());
  const allFrames = prepared.frameIdsInOrder.filter((f) => !manual.has(f) && !(extraExcluded?.has(f)));

  // 每条轨迹只在“全部有效帧都观测到”时进入共同点集（断点 => 不进入跨候选比较）
  const tracks: string[] = [];
  for (const trackId of prepared.trackIds) {
    let covered = true;
    for (const f of allFrames) {
      if (!prepared.observations.get(f)?.has(trackId)) {
        covered = false;
        break;
      }
    }
    if (covered) tracks.push(trackId);
  }
  const key = stableId(
    "pts",
    [...allFrames].sort().join(","),
    [...tracks].sort().join(","),
  );
  return { frames: allFrames, tracks, key, perHypothesis: [], hypotheses: [] };
}

const OVERFIT_RATIO = 2.0; // 自由度达到观测点数一半即判过拟合
const BAD_FRAME_Z = 2.5;
const AMBIGUITY_TOLERANCE = 0.06; // 两个假设 RMS 差小于 0.06px 视为无法唯一决定

export function buildCandidates(input: CandidateBuildInput): CandidateBuildResult {
  const prepared = prepareSeries(input.entities);
  const diagnostics: CandidateBuildResult["diagnostics"] = [];
  for (const u of prepared.unconvertible) {
    diagnostics.push({
      level: "error",
      code: "unconvertible-value",
      message: `${u.field} of ${u.frameId}: ${u.diagnostic} (raw="${u.raw}")`,
      subjectId: u.frameId,
    });
  }

  const manual = new Set(prepared.manualExclusions.keys());
  const hypotheses = buildHypotheses(prepared, input.swapHypotheses);

  // ---- 步骤 1：在“全部未手工排除帧”上做一次刚体初拟合，自动发现坏帧 ----
  const probeFrames = prepared.frameIdsInOrder.filter((f) => !manual.has(f));
  const autoBad = new Set<string>();
  for (const hyp of hypotheses) {
    const probePoints = hyp.points.filter((p) => probeFrames.includes(p.frameId));
    if (probePoints.length < 6) continue;
    const guess = { x: input.imageSize.width / 2, y: input.imageSize.height / 2 };
    const probe = fitVariant(
      probePoints,
      probeFrames.map((frameId) => ({ frameId, tiltRad: prepared.frameById.get(frameId)!.tiltRad })),
      input.imageSize,
      { kind: "rigid-free-axis", axisXGuess: guess.x, axisYGuess: guess.y, imageCenterX: guess.x, imageCenterY: guess.y },
    );
    const values = Object.entries(probe.perFrameResidual)
      .filter(([, v]) => Number.isFinite(v))
      .map(([, v]) => v);
    const med = median(values);
    for (const [frameId, r] of Object.entries(probe.perFrameResidual)) {
      if (Number.isFinite(r) && med > 0 && r > med * BAD_FRAME_Z + 0.8) autoBad.add(frameId);
    }
  }

  // ---- 步骤 2：共同有效点集（刚体基准） ----
  const excludedAll = new Set<string>([...manual, ...autoBad]);
  const common = commonPointSet(prepared, excludedAll);
  const baseHyp = hypotheses[0]!;
  const basePoints = baseHyp.points.filter(
    (p) => common.frames.includes(p.frameId) && common.tracks.includes(p.trackId),
  );
  const effectivePointKey = common.key;

  const frameMetas = common.frames.map((frameId) => ({
    frameId,
    tiltRad: prepared.frameById.get(frameId)!.tiltRad,
  }));

  function candidate(
    label: string,
    kind: TransformKind,
    hyp: HypothesisPoints,
    frames: string[],
    points: ObservationPoint[],
    extraExcluded: Set<string>,
    variant: Parameters<typeof fitVariant>[3],
    ambiguityFamilyId: string | null,
    enforcedStatus?: AlignmentCandidate["status"],
  ): AlignmentCandidate {
    const fit = fitVariant(points, frames.map((f) => ({ frameId: f, tiltRad: prepared.frameById.get(f)!.tiltRad })), input.imageSize, variant);
    const diagnosticsFor: string[] = [];
    let status: AlignmentCandidate["status"] = enforcedStatus ?? "legal";
    const ratio = fit.observationCount * 2 / Math.max(fit.freeParameterCount, 1);
    if (kind === "local-warp" && fit.observationCount * 2 < fit.freeParameterCount * OVERFIT_RATIO) {
      status = "overfit-rejected";
      diagnosticsFor.push(
        `overfit: 2×observations=${fit.observationCount * 2} < ${OVERFIT_RATIO}×freeParams=${fit.freeParameterCount * OVERFIT_RATIO}`,
      );
    }
    const excludedFrameIds = prepared.frameIdsInOrder.filter(
      (f) => !frames.includes(f),
    );
    return {
      candidateId: stableId("cand", input.commitId, kind, label, hyp.hypothesisId, effectivePointKey),
      branchId: input.branchId,
      commitId: input.commitId,
      label,
      transformKind: kind,
      effectiveFrameIds: frames,
      effectiveTrackIds: [...new Set(points.map((p) => p.trackId))].sort(),
      effectivePointKey,
      transforms: fit.transforms,
      perFrameResidual: fit.perFrameResidual,
      meanResidual: fit.meanResidual,
      maxResidual: fit.maxResidual,
      excludedFrameIds,
      status,
      diagnostics: diagnosticsFor,
      ambiguityFamilyId,
      overfitRatio: Number(ratio.toFixed(3)),
      freeParameterCount: fit.freeParameterCount,
      observationCount: fit.observationCount,
    };
  }

  const guess = { x: input.imageSize.width / 2, y: input.imageSize.height / 2 };
  const candidates: AlignmentCandidate[] = [];

  // 候选 A：刚体（自由轴线）—— 每个身份假设一个
  const rigidFits = hypotheses.map((hyp) => {
    const pts = hyp.points.filter((p) => common.frames.includes(p.frameId) && common.tracks.includes(p.trackId));
    return candidate(
      `rigid / ${hyp.label}`,
      "rigid",
      hyp,
      common.frames,
      pts,
      excludedAll,
      { kind: "rigid-free-axis", axisXGuess: guess.x, axisYGuess: guess.y, imageCenterX: guess.x, imageCenterY: guess.y },
      null,
    );
  });
  candidates.push(...rigidFits);

  // 候选 B：轴线钉在图像中心的刚体 —— 作为反例保留，用于证明“轴线不能默认中心”
  const centerFit = candidate(
    "rigid / axis-pinned-to-image-center",
    "rigid",
    baseHyp,
    common.frames,
    basePoints,
    excludedAll,
    { kind: "rigid-center-axis", axisXGuess: guess.x, axisYGuess: guess.y, imageCenterX: guess.x, imageCenterY: guess.y },
    null,
  );
  centerFit.diagnostics.push("axis-pinned: 轴线被强制为图像中心，仅用于对照");
  candidates.push(centerFit);

  // 候选 C：局部形变（在相同共同有效点集上拟合）
  const warpCPs = [
    { x: input.imageSize.width * 0.3, y: input.imageSize.height * 0.3 },
    { x: input.imageSize.width * 0.7, y: input.imageSize.height * 0.7 },
  ];
  const warpFit = candidate(
    "local-warp / 2-control-points",
    "local-warp",
    baseHyp,
    common.frames,
    basePoints,
    excludedAll,
    {
      kind: "local-warp",
      axisXGuess: guess.x,
      axisYGuess: guess.y,
      imageCenterX: guess.x,
      imageCenterY: guess.y,
      warpControlPoints: warpCPs,
    },
    null,
  );
  candidates.push(warpFit);

  // 候选 D：排除坏帧方案（在共同点集上再去掉自动坏帧；与刚体基准使用相同有效点集比较）
  if (autoBad.size > 0) {
    const badFrames = common.frames.filter((f) => autoBad.has(f));
    const remainingFrames = common.frames.filter((f) => !autoBad.has(f));
    const rec = commonPointSet(prepared, new Set([...manual, ...autoBad]));
    const pts = baseHyp.points.filter((p) => rec.frames.includes(p.frameId) && rec.tracks.includes(p.trackId));
    const excludedCand = candidate(
      `bad-frame-exclusion / drop ${badFrames.join(",")}`,
      "bad-frame-exclusion",
      baseHyp,
      remainingFrames,
      pts,
      new Set([...manual, ...autoBad]),
      {
        kind: "rigid-excluded",
        axisXGuess: guess.x,
        axisYGuess: guess.y,
        imageCenterX: guess.x,
        imageCenterY: guess.y,
        excludedFrameIds: excludedAll,
      },
      null,
    );
    // 规则：不允许“少帧换低残差”。在共同帧交集上重算两个方案的残差后比较。
    const baseOnCommon = residualOnFrames(rigidFits[0]!, remainingFrames);
    const exclOnCommon = residualOnFrames(excludedCand, remainingFrames);
    const gain = baseOnCommon - exclOnCommon;
    excludedCand.diagnostics.push(
      `fair-comparison: 在共同帧交集上 rigid=${baseOnCommon.toFixed(3)}px vs excluded=${exclOnCommon.toFixed(3)}px, gain=${gain.toFixed(3)}px`,
    );
    if (gain < 0.15) {
      excludedCand.status = "invalid-point-set";
      excludedCand.diagnostics.push("rejected: 排除帧未在共同帧交集上降低残差（疑似少帧换低残差）");
    }
    candidates.push(excludedCand);
  }

  // ---- 多解：两个身份假设残差接近时，全部保留为合法候选，挂同一 ambiguityFamily ----
  const legalRigid = rigidFits.filter((c) => c.status === "legal");
  if (legalRigid.length >= 2) {
    const rmsValues = legalRigid.map((c) => c.meanResidual);
    const spread = Math.max(...rmsValues) - Math.min(...rmsValues);
    if (spread < AMBIGUITY_TOLERANCE) {
      const family = stableId("amb", input.commitId, effectivePointKey);
      for (const c of legalRigid) {
        c.status = "ambiguous";
        c.ambiguityFamilyId = family;
        c.diagnostics.push(
          `ambiguous: 身份假设间 RMS 极差=${spread.toFixed(3)}px < ${AMBIGUITY_TOLERANCE}px，无法唯一决定，保留全部合法候选`,
        );
      }
    }
  }

  return { candidates, prepared, effectivePointKey, diagnostics };
}

function residualOnFrames(c: AlignmentCandidate, frames: string[]): number {
  const vals = frames.map((f) => c.perFrameResidual[f]).filter((v): v is number => Number.isFinite(v ?? NaN));
  if (!vals.length) return Number.POSITIVE_INFINITY;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
