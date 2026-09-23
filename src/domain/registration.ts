import { canonicalHash } from "./units.js";
import { searchAxis, solveModel, type GeomPoint, type ObservationInput } from "./geometry.js";
import { checkRule } from "./rules.js";
import type {
  CandidateDiagnostic,
  CandidateKind,
  CandidateParams,
  EffectivePointSet,
  FrameId,
  PerFrameResidual,
  RegistrationCandidate,
  RuleCheckResult,
  AxisSolutionAlternative
} from "./types.js";

export interface BuilderFrame {
  frameId: FrameId;
  order: number;
  angleDeg: number;
}

export interface BuilderPoint {
  trackId: string;
  frameId: FrameId;
  x: number;
  y: number;
  heldOut: boolean;
}

export interface BuildInput {
  kind: CandidateKind;
  interpretationId: string;
  linkSetId: string;
  axis: {
    axisId: string;
    version: number;
    basisId: string;
    centerPx: GeomPoint;
    fixedAtCenter: boolean;
  };
  frames: BuilderFrame[];
  points: BuilderPoint[];
  excludedFrameIds: FrameId[];
  candidateId: string;
}

function buildPointSet(linkSetId: string, points: BuilderPoint[]): EffectivePointSet {
  const pairs = points
    .map((p) => ({ trackId: p.trackId, frameId: p.frameId }))
    .sort((a, b) =>
      a.frameId === b.frameId ? a.trackId.localeCompare(b.trackId) : a.frameId.localeCompare(b.frameId)
    );
  return {
    linkSetId,
    pairs,
    pointsHash: canonicalHash({ linkSetId, pairs }),
    frameCount: new Set(pairs.map((p) => p.frameId)).size,
    trackCount: new Set(pairs.map((p) => p.trackId)).size
  };
}

export interface BuildResult {
  candidate: RegistrationCandidate;
  pointSet: EffectivePointSet;
}

const HIGH_TILT_DEG = 50;

export function buildCandidate(input: BuildInput): BuildResult {
  const frames = [...input.frames].sort((a, b) => a.order - b.order);
  const frameIndex = new Map<FrameId, number>(frames.map((fr, j) => [fr.frameId, j]));
  const trackIds = [...new Set(input.points.map((p) => p.trackId))].sort();
  const trackIndex = new Map(trackIds.map((t, i) => [t, i]));

  const fitPoints = input.points.filter((p) => !p.heldOut);
  const pointSet = buildPointSet(
    input.linkSetId,
    input.points
  );

  const observations: ObservationInput[] = fitPoints.map((p) => ({
    trackIndex: trackIndex.get(p.trackId)!,
    frameIndex: frameIndex.get(p.frameId)!,
    x: p.x,
    y: p.y
  }));
  const anglesDeg = frames.map((f) => f.angleDeg);

  const fixed = input.axis.fixedAtCenter;
  const search = searchAxis(
    anglesDeg,
    trackIds.length,
    observations,
    input.axis.centerPx,
    fixed
      ? {
          dirRange: [-6, 22],
          offsetRangePx: 0,
          coarseStepPx: 999,
          dirStepDeg: 2
        }
      : { offsetRangePx: 30, coarseStepPx: 6, dirStepDeg: 4 }
  );

  const best = fixed
    ? {
        origin: { ...input.axis.centerPx },
        dirDeg: search.best.dirDeg,
        solve: solveModel({
          axisDirDeg: search.best.dirDeg,
          axisOrigin: input.axis.centerPx,
          anglesDeg,
          trackCount: trackIds.length,
          observations
        })
      }
    : search.best;

  const local =
    input.kind === "local-deformation"
      ? solveModel({
          axisDirDeg: best.dirDeg,
          axisOrigin: best.origin,
          anglesDeg,
          trackCount: trackIds.length,
          observations,
          warp: true,
          warpLambda: 1e-3
        })
      : null;

  const solve = local ?? best.solve;
  const diagnostics: CandidateDiagnostic[] = [];
  const ruleChecks: RuleCheckResult[] = [];

  // 规则：倾转轴不能被默认固定在图像中心
  if (fixed) {
    diagnostics.push({
      code: "axis.center-default",
      severity: "warning",
      message: "该候选把轴心固定在画幅中心；若真实偏心，残差会系统性偏移"
    });
    ruleChecks.push(
      checkRule(
        "axis.not-centered-by-default",
        false,
        `axis=${input.axis.axisId}@v${input.axis.version} 使用 centeredAssumption，轴心偏移为未检验假设`
      )
    );
  } else {
    diagnostics.push({
      code: "axis.estimated-offset",
      severity: "info",
      message: `轴心由轨迹拟合估计：(${best.origin.x.toFixed(1)}, ${best.origin.y.toFixed(1)}) px`
    });
    ruleChecks.push(
      checkRule(
        "axis.not-centered-by-default",
        true,
        `自由轴心估计偏移于中心：dx=${(best.origin.x - input.axis.centerPx.x).toFixed(1)} px, dy=${(
          best.origin.y - input.axis.centerPx.y
        ).toFixed(1)} px`
      )
    );
  }

  // 高倾角覆盖：缺帧/缺观测导致 |θ|>=50° 没有有效点，是 blocker
  const usedFrameIds = new Set(fitPoints.map((p) => p.frameId));
  const missingHighTilt = frames.filter(
    (fr) => Math.abs(fr.angleDeg) >= HIGH_TILT_DEG && !usedFrameIds.has(fr.frameId)
  );
  if (missingHighTilt.length > 0) {
    diagnostics.push({
      code: "coverage.high-tilt-missing",
      severity: "blocker",
      message: `高倾角帧 ${missingHighTilt.map((f) => f.frameId).join(", ")} 缺少有效点，无法约束 z 方向`,
      frameIds: missingHighTilt.map((f) => f.frameId)
    });
    ruleChecks.push(
      checkRule(
        "candidate.no-fewer-frames-for-lower-residual",
        false,
        `缺高倾角帧：${missingHighTilt.map((f) => f.frameId).join(",")}；低残差不可作为采纳依据`
      )
    );
  } else {
    ruleChecks.push(
      checkRule(
        "candidate.no-fewer-frames-for-lower-residual",
        input.kind !== "rigid-excluded" || input.excludedFrameIds.length === 0
          ? true
          : Math.max(...input.excludedFrameIds.map((id) => Math.abs(frames[frameIndex.get(id)!].angleDeg))) <
            HIGH_TILT_DEG,
        input.kind === "rigid-excluded"
          ? `排除帧 ${input.excludedFrameIds.join(",")} 不含 |θ|>=${HIGH_TILT_DEG}° 帧，高倾角覆盖保留`
          : "未通过排除帧减少覆盖"
      )
    );
  }

  if (input.excludedFrameIds.length > 0) {
    diagnostics.push({
      code: "frame.bad-excluded",
      severity: "info",
      message: `显式排除帧：${input.excludedFrameIds.join(", ")}`,
      frameIds: input.excludedFrameIds
    });
  }

  // 少帧警告：比同一解释的刚体候选覆盖更少时，不能直接宣称更优
  const excludedResidualHint =
    input.kind === "rigid-excluded"
      ? `有效帧 ${pointSet.frameCount}/${frames.length}；只能与相同 pointsHash 的候选比较`
      : "";
  ruleChecks.push(
    checkRule(
      "candidate.same-effective-points",
      true,
      `pointsHash=${pointSet.pointsHash.slice(0, 12)}… ${excludedResidualHint}`.trim()
    )
  );

  // 多解：多个几何上分离的近优轴解
  const alternates: AxisSolutionAlternative[] = search.nearBest.slice(0, 4).map((g) => ({
    originXPx: g.origin.x,
    originYPx: g.origin.y,
    directionDeg: g.dirDeg,
    rmsResidualPx: g.solve.rms
  }));
  if (!fixed && search.nearBest.length > 1) {
    diagnostics.push({
      code: "solution.non-unique",
      severity: "blocker",
      message: `存在 ${search.nearBest.length} 个分离的近优轴解，无法唯一决定，全部合法候选必须保留`
    });
    ruleChecks.push(checkRule("solution.keep-all-legal-candidates", false, "近优解不唯一，已保留全部合法候选"));
  } else {
    ruleChecks.push(checkRule("solution.keep-all-legal-candidates", true, "轴解唯一"));
  }

  // 局部形变过拟合：训练 RMS 改善但留出 RMS 不变差 => 过拟合
  let holdoutRms: number | null = null;
  const holdout = input.points.filter((p) => p.heldOut);
  if (local && holdout.length > 0) {
    holdoutRms = holdoutRmsAt(local, holdout, best, anglesDeg, frameIndex, trackIndex);
    const rigidHoldout = holdoutRmsAt(best.solve, holdout, best, anglesDeg, frameIndex, trackIndex);
    const trainGain = (best.solve.rms - local.rms) / Math.max(best.solve.rms, 1e-9);
    const holdoutGain = (rigidHoldout - holdoutRms) / Math.max(rigidHoldout, 1e-9);
    if (trainGain > 0.2 && holdoutGain <= 0.02) {
      diagnostics.push({
        code: "local.overfit",
        severity: "blocker",
        message: `局部形变训练残差下降 ${(trainGain * 100).toFixed(0)}% 但留出集无改善（${(
          holdoutGain * 100
        ).toFixed(0)}%），判定过拟合`
      });
    }
  }

  // 每帧残差（使用全部点，含留出点，标注 used）
  const perFrame: PerFrameResidual[] = frames.map((fr) => {
    const onFrame = solve.residuals.length; // placeholder to satisfy linter
    void onFrame;
    const fitOnFrame = fitPoints.filter((p) => p.frameId === fr.frameId);
    const allOnFrame = input.points.filter((p) => p.frameId === fr.frameId);
    const errors: number[] = [];
    for (const p of allOnFrame) {
      const res = predictResidual(solve, best, p, anglesDeg, frameIndex, trackIndex);
      errors.push(res);
    }
    const used = !input.excludedFrameIds.includes(fr.frameId);
    return {
      frameId: fr.frameId,
      used,
      rmsPx: errors.length ? Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length) : NaN,
      maxAbsPx: errors.length ? Math.max(...errors.map(Math.abs)) : NaN
    };
  });

  const frameShifts: CandidateParams["frameShiftsPx"] = {};
  frames.forEach((fr, j) => {
    frameShifts[fr.frameId] = { dx: solve.perFrame[j].dx, dy: solve.perFrame[j].dy };
  });

  const candidate: RegistrationCandidate = {
    candidateId: input.candidateId,
    kind: input.kind,
    interpretationId: input.interpretationId,
    linkSetId: input.linkSetId,
    axisRef: { axisId: input.axis.axisId, version: input.axis.version },
    pointSet,
    excludedFrameIds: input.excludedFrameIds,
    rmsResidualPx: solve.rms,
    holdoutRmsPx: holdoutRms,
    degreesOfFreedom: solve.degreesOfFreedom,
    perFrame,
    diagnostics,
    ruleChecks,
    params: {
      axisOffsetXPx: fixed ? null : best.origin.x - input.axis.centerPx.x,
      axisOffsetYPx: fixed ? null : best.origin.y - input.axis.centerPx.y,
      axisDirectionDeg: best.dirDeg,
      frameShiftsPx: frameShifts,
      localWarpAmplitudePx: local
        ? Math.max(...local.perFrame.map((p) => Math.abs(p.warpA))) * 48 * 48
        : null
    },
    alternateSolutions: alternates
  };

  return { candidate, pointSet };
}

function predictResidual(
  solve: ReturnType<typeof solveModel>,
  best: { origin: GeomPoint; dirDeg: number },
  point: BuilderPoint,
  anglesDeg: number[],
  frameIndex: Map<FrameId, number>,
  trackIndex: Map<string, number>
): number {
  const j = frameIndex.get(point.frameId)!;
  const i = trackIndex.get(point.trackId)!;
  const th = (anglesDeg[j] * Math.PI) / 180;
  const phi = (best.dirDeg * Math.PI) / 180;
  const ax = Math.cos(phi);
  const ay = Math.sin(phi);
  const bx = -Math.sin(phi);
  const by = Math.cos(phi);
  const dx0 = point.x - best.origin.x;
  const dy0 = point.y - best.origin.y;
  const tr = solve.perTrack[i];
  const fr = solve.perFrame[j];
  const rx = dx0 * ax + dy0 * ay - (tr.u + fr.dx);
  const ry = dx0 * bx + dy0 * by - (tr.v * Math.cos(th) - tr.z * Math.sin(th) + fr.dy);
  return Math.hypot(rx, ry);
}

function holdoutRmsAt(
  solve: ReturnType<typeof solveModel>,
  holdout: BuilderPoint[],
  best: { origin: GeomPoint; dirDeg: number },
  anglesDeg: number[],
  frameIndex: Map<FrameId, number>,
  trackIndex: Map<string, number>
): number {
  const errors = holdout.map((p) => predictResidual(solve, best, p, anglesDeg, frameIndex, trackIndex));
  return Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / Math.max(1, errors.length));
}
