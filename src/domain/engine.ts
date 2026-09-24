import { createHash } from "node:crypto";
import type {
  AlignmentCandidate,
  AxisModel,
  CandidateStrategy,
  Diagnostic,
  FrameTransform,
  MarkerObservation,
  MarkerTrack,
  PerFrameResidual,
  RawFrame,
  RuleParameters,
  SourceRevision,
  WarpControlPoint
} from "../types.ts";
import { deterministicId } from "../ids.ts";

export interface Vec2 { x: number; y: number }

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function rmse(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);
}

/** 2D 刚体（平移+旋转+整体尺度）拟合，返回使 pred≈ref 的变换。 */
export function fitRigid(pred: Vec2[], ref: Vec2[]) {
  const mp = { x: mean(pred.map((p) => p.x)), y: mean(pred.map((p) => p.y)) };
  const mr = { x: mean(ref.map((p) => p.x)), y: mean(ref.map((p) => p.y)) };
  let a = 0;
  let b = 0;
  let varP = 0;
  for (let i = 0; i < pred.length; i++) {
    const px = pred[i]!.x - mp.x;
    const py = pred[i]!.y - mp.y;
    const rx = ref[i]!.x - mr.x;
    const ry = ref[i]!.y - mr.y;
    a += px * rx + py * ry;
    b += px * ry - py * rx;
    varP += px * px + py * py;
  }
  const rotationDeg = (Math.atan2(b, a) * 180) / Math.PI;
  const varR = ref.reduce((s, p) => s + (p.x - mr.x) ** 2 + (p.y - mr.y) ** 2, 0);
  const scale = varP > 0 ? Math.sqrt(varR / varP) : 1;
  const translationX = mr.x - scale * (Math.cos((rotationDeg * Math.PI) / 180) * mp.x - Math.sin((rotationDeg * Math.PI) / 180) * mp.y);
  const translationY = mr.y - scale * (Math.sin((rotationDeg * Math.PI) / 180) * mp.x + Math.cos((rotationDeg * Math.PI) / 180) * mp.y);
  return { translationX, translationY, rotationDeg, scale };
}

export function applyRigid(p: Vec2, t: { translationX: number; translationY: number; rotationDeg: number; scale: number }): Vec2 {
  const c = Math.cos((t.rotationDeg * Math.PI) / 180);
  const s = Math.sin((t.rotationDeg * Math.PI) / 180);
  return {
    x: t.scale * (c * p.x - s * p.y) + t.translationX,
    y: t.scale * (s * p.x + c * p.y) + t.translationY
  };
}

export interface ModeledTrack {
  trackId: string;
  points: { frame: RawFrame; obs: MarkerObservation; X: number; Y: number; Z: number }[];
  fitResidual: number;
  breakFrames: string[];
}

export interface AxisFitResult {
  axis: AxisModel;
  tracks: ModeledTrack[];
  totalRmse: number;
  modeled: Map<string, Map<string, Vec2>>; // frameId -> markerId -> predicted untilted point
}

/** 沿轴/垂直轴基向量。 */
export function axisBasis(angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { e: { x: Math.cos(a), y: Math.sin(a) }, n: { x: -Math.sin(a), y: Math.cos(a) } };
}

/** 给定轴，拟合每条 fiducial 轨迹 a≈X, b≈Y cosθ + Z sinθ。 */
export function fitTrajectories(
  frames: RawFrame[],
  tracks: MarkerTrack[],
  center: Vec2,
  angleDeg: number
): { tracks: ModeledTrack[]; totalRmse: number; modeled: Map<string, Map<string, Vec2>> } {
  const { e, n } = axisBasis(angleDeg);
  const frameByIndex = new Map(frames.map((f) => [f.frameId, f]));
  const modeled = new Map<string, Map<string, Vec2>>();
  const modeledTracks: ModeledTrack[] = [];
  const allRes: number[] = [];

  for (const track of tracks) {
    const obsPoints: { frame: RawFrame; obs: MarkerObservation; a: number; b: number; theta: number }[] = [];
    for (const obs of track.observations) {
      if (!obs.present) continue;
      const frame = frameByIndex.get(obs.frameId);
      if (!frame || !frame.tiltAngle.parsed) continue;
      const theta = (frame.tiltAngle.parsed.degrees * Math.PI) / 180;
      const dx = obs.x - center.x;
      const dy = obs.y - center.y;
      obsPoints.push({
        frame,
        obs,
        a: dx * e.x + dy * e.y,
        b: dx * n.x + dy * n.y,
        theta
      });
    }
    // 最小二乘 b ≈ Y cosθ + Z sinθ；X 取 a 均值。
    let ca = 0;
    let cb = 0;
    let cc = 0;
    let s1 = 0;
    let s2 = 0;
    for (const p of obsPoints) {
      const c = Math.cos(p.theta);
      const s = Math.sin(p.theta);
      ca += c * c;
      cb += c * s;
      cc += s * s;
      s1 += p.b * c;
      s2 += p.b * s;
    }
    const det = ca * cc - cb * cb;
    const Y = det !== 0 ? (s1 * cc - s2 * cb) / det : 0;
    const Z = det !== 0 ? (ca * s2 - cb * s1) / det : 0;
    const X = obsPoints.length ? mean(obsPoints.map((p) => p.a)) : 0;
    const trackRes: number[] = [];
    for (const p of obsPoints) {
      const predA = X;
      const predB = Y * Math.cos(p.theta) + Z * Math.sin(p.theta);
      const err2 = (p.a - predA) ** 2 + (p.b - predB) ** 2;
      trackRes.push(Math.sqrt(err2));
      allRes.push(Math.sqrt(err2));
      const untilted = {
        x: center.x + e.x * predA + n.x * predB,
        y: center.y + e.y * predA + n.y * predB
      };
      let map = modeled.get(p.frame.frameId);
      if (!map) {
        map = new Map();
        modeled.set(p.frame.frameId, map);
      }
      map.set(p.obs.markerId, untilted);
    }
    modeledTracks.push({
      trackId: track.trackId,
      points: obsPoints.map((p) => ({ frame: p.frame, obs: p.obs, X, Y, Z })),
      fitResidual: rmse(trackRes),
      breakFrames: track.gaps.filter((g) => g.fromFrameId && g.toFrameId).map((g) => g.toFrameId!)
    });
  }
  return { tracks: modeledTracks, totalRmse: rmse(allRes), modeled };
}

/**
 * 倾转轴必须由数据拟合，不能默认固定在图像中心。
 * 先粗后细网格搜索 (angle, cx, cy)，返回最优与合法近优解（多解时全部保留）。
 */
export function fitTiltAxis(
  frames: RawFrame[],
  tracks: MarkerTrack[],
  imageSize: Vec2,
  fixedCenter: boolean,
  maxCandidates = 5
): { best: AxisFitResult; axis: AxisModel; nearBest: { axis: AxisModel; fit: AxisFitResult; score: number }[] } {
  const search = (stepAngle: number, stepXY: number, around: { a: number; cx: number; cy: number; spanA: number; spanXY: number }) => {
    let best: { axis: AxisModel; fit: AxisFitResult; score: number } | null = null;
    const all: { axis: AxisModel; fit: AxisFitResult; score: number }[] = [];
    const centerXs = fixedCenter ? [imageSize.x / 2] : [around.cx - around.spanXY, around.cx, around.cx + around.spanXY];
    const centerYs = fixedCenter ? [imageSize.y / 2] : [around.cy - around.spanXY, around.cy, around.cy + around.spanXY];
    for (let angle = around.a - around.spanA; angle <= around.a + around.spanA + 1e-9; angle += stepAngle) {
      for (const cx of centerXs) {
        for (const cy of centerYs) {
          const fit = fitTrajectories(frames, tracks, { x: cx, y: cy }, angle);
          const entry = {
            axis: {
              axisId: deterministicId("frame", `axis:${angle.toFixed(2)}:${cx.toFixed(1)}:${cy.toFixed(1)}`).replace("frm-", "axis-"),
              centerX: cx,
              centerY: cy,
              angleDeg: angle,
              fixedAtImageCenter: fixedCenter,
              origin: fixedCenter ? ("assumed-image-center" as const) : ("fitted" as const)
            },
            fit,
            score: fit.totalRmse
          };
          all.push(entry);
          if (!best || entry.score < best.score) best = entry;
        }
      }
    }
    if (!best) throw new Error("axis search produced no solution");
    const nearBest = all
      .filter((e) => e !== best && e.score - best.score <= 0.35)
      .sort((p, q) => p.score - q.score)
      .slice(0, maxCandidates);
    return { best, nearBest };
  };

  const coarse = search(5, 1, { a: 0, cx: imageSize.x / 2, cy: imageSize.y / 2, spanA: 45, spanXY: 12 });
  const fine = search(0.5, 1, {
    a: coarse.best.axis.angleDeg,
    cx: coarse.best.axis.centerX,
    cy: coarse.best.axis.centerY,
    spanA: 4,
    spanXY: 2
  });
  return { best: fine.best.fit, axis: fine.best.axis, nearBest: fine.nearBest };
}

/** 检测身份交换：跨越轨迹断裂处残差显著偏高，则认为相邻轨迹可能交换身份。 */
export function detectIdentitySwaps(
  frames: RawFrame[],
  tracks: MarkerTrack[],
  modeled: Map<string, Map<string, Vec2>>
): { trackId: string; otherTrackId: string; atFrameId: string; residualPixels: number }[] {
  const frameSet = new Map(frames.map((f) => [f.frameId, f]));
  const out: { trackId: string; otherTrackId: string; atFrameId: string; residualPixels: number }[] = [];
  const byId = new Map(tracks.map((t) => [t.trackId, t]));
  for (const track of tracks) {
    if (!track.identitySwapWith) continue;
    const other = byId.get(track.identitySwapWith);
    if (!other) continue;
    const gap = track.gaps.find((g) => g.toFrameId && frameSet.has(g.toFrameId));
    const atFrameId = gap?.toFrameId ?? track.observations[track.observations.length - 1]?.frameId;
    if (!atFrameId) continue;
    // 用“自身轨迹模型 vs 另一轨迹模型”比较交换点处残差，判定交换是否真实。
    const own = track.observations.find((o) => o.frameId === atFrameId);
    const otherObs = other.observations.find((o) => o.frameId === atFrameId);
    const modelOwn = modeled.get(atFrameId)?.get(track.trackId);
    const modelOther = modeled.get(atFrameId)?.get(other.trackId);
    let residualPixels = 0;
    if (own && modelOther && otherObs && modelOwn) {
      const ownMismatch = Math.hypot(own.x - modelOwn.x, own.y - modelOwn.y);
      const swapMatch = Math.hypot(own.x - modelOther.x, own.y - modelOther.y);
      residualPixels = ownMismatch - swapMatch;
    }
    out.push({ trackId: track.identitySwapWith, otherTrackId: track.trackId, atFrameId, residualPixels });
    void otherObs;
  }
  // 去重
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = [s.trackId, s.otherTrackId].sort().join("~");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface FrameAlignment {
  transform: FrameTransform;
  residual: PerFrameResidual;
  perPointErrors: number[];
}

function alignFrames(
  frames: RawFrame[],
  tracks: MarkerTrack[],
  modeled: Map<string, Map<string, Vec2>>,
  excluded: Set<string>,
  warpStrength = 0
): Map<string, FrameAlignment> {
  const out = new Map<string, FrameAlignment>();
  for (const frame of frames) {
    const pred: Vec2[] = [];
    const ref: Vec2[] = [];
    for (const track of tracks) {
      const obs = track.observations.find((o) => o.frameId === frame.frameId && o.present);
      const model = modeled.get(frame.frameId)?.get(track.trackId);
      if (obs && model) {
        pred.push({ x: obs.x, y: obs.y });
        ref.push(model);
      }
    }
    const isExcluded = excluded.has(frame.frameId);
    if (pred.length < 2 || isExcluded) {
      out.set(frame.frameId, {
        transform: { frameId: frame.frameId, translationX: 0, translationY: 0, rotationDeg: 0, scale: 1, excluded: true, warp: [] },
        residual: { frameId: frame.frameId, rmsePixels: NaN, pointCount: pred.length, usedInComparison: false },
        perPointErrors: []
      });
      continue;
    }
    const rigid = fitRigid(pred, ref);
    const errors = pred.map((p, i) => Math.hypot(applyRigid(p, rigid).x - ref[i]!.x, applyRigid(p, rigid).y - ref[i]!.y));
    // 局部形变控制点：只把残差向量的一小部分吸收为非刚体位移，能量随强度增长。
    const warp: WarpControlPoint[] = [];
    if (warpStrength > 0) {
      for (let i = 0; i < pred.length; i++) {
        const mapped = applyRigid(pred[i]!, rigid);
        warp.push({
          controlPointId: deterministicId("frame", `cp:${frame.frameId}:${i}`).replace("frm-", "cp-"),
          x: mapped.x,
          y: mapped.y,
          dx: (ref[i]!.x - mapped.x) * warpStrength,
          dy: (ref[i]!.y - mapped.y) * warpStrength
        });
      }
    }
    out.set(frame.frameId, {
      transform: { ...rigid, frameId: frame.frameId, excluded: false, warp },
      residual: { frameId: frame.frameId, rmsePixels: rmse(errors), pointCount: errors.length, usedInComparison: true },
      perPointErrors: errors
    });
  }
  return out;
}

function collectObservations(tracks: MarkerTrack[], frameIds: string[]) {
  const allowed = new Set(frameIds);
  const errs: number[] = [];
  let points = 0;
  for (const track of tracks) {
    for (const obs of track.observations) {
      if (obs.present && allowed.has(obs.frameId)) {
        points += 1;
      }
    }
  }
  return { errs, points };
}

/** 重新连接被交换身份的轨迹：交换点之后互换两条轨迹的观测归属。 */
export function rewireSwappedTracks(
  tracks: MarkerTrack[],
  swap: { trackId: string; otherTrackId: string; atFrameId: string },
  orderedFrameIds: string[]
): MarkerTrack[] {
  const atIndex = orderedFrameIds.indexOf(swap.atFrameId);
  const after = new Set(orderedFrameIds.slice(Math.max(0, atIndex)));
  return tracks.map((track) => {
    if (track.trackId !== swap.trackId && track.trackId !== swap.otherTrackId) return track;
    const counterpart = track.trackId === swap.trackId ? swap.otherTrackId : swap.trackId;
    const counterpartTrack = tracks.find((t) => t.trackId === counterpart)!;
    const keepOwn = track.observations.filter((o) => !after.has(o.frameId));
    const takeOther = counterpartTrack.observations.filter((o) => after.has(o.frameId)).map((o) => ({ ...o, trackId: track.trackId }));
    return { ...track, observations: [...keepOwn, ...takeOther], identitySwapWith: null };
  });
}

export interface CandidateComputation {
  candidates: AlignmentCandidate[];
  diagnostics: Diagnostic[];
  imageSize: Vec2;
}

interface ComputeOptions {
  candidateSeed: string;
  imageSize: Vec2;
  createdAt: string;
}

function buildCandidate(
  revision: SourceRevision,
  rulesVersion: string,
  strategy: CandidateStrategy,
  label: string,
  seedTag: string,
  axisResult: { best: AxisFitResult; axis: AxisModel },
  alignments: Map<string, FrameAlignment>,
  manuallyExcluded: Set<string>,
  commonValidFrames: string[],
  diagnostics: Diagnostic[],
  warpStrength: number,
  rules: RuleParameters,
  opts: ComputeOptions,
  ambiguityGroup: string | null = null
): AlignmentCandidate {
  const frames = revision.frameIds.map((id) => revision.frameById[id]!);
  const transforms: Record<string, FrameTransform> = {};
  const perFrame: Record<string, PerFrameResidual> = {};
  let excludedFrameIds: string[] = [];
  let totalErrors: number[] = [];
  let validPoints = 0;
  let warpEnergy = 0;
  for (const frame of frames) {
    const a = alignments.get(frame.frameId);
    if (!a) continue;
    transforms[frame.frameId] = a.transform;
    if (a.transform.excluded) excludedFrameIds.push(frame.frameId);
    if (commonValidFrames.includes(frame.frameId)) {
      // 用共同有效点集（刚体对齐结果）评分，禁止用少帧换低残差。
      totalErrors.push(a.residual.rmsePixels);
      validPoints += a.residual.pointCount;
    }
    perFrame[frame.frameId] = {
      ...a.residual,
      usedInComparison: commonValidFrames.includes(frame.frameId)
    };
    for (const cp of a.transform.warp) warpEnergy += cp.dx * cp.dx + cp.dy * cp.dy;
  }
  excludedFrameIds = [...new Set([...excludedFrameIds, ...frames.filter((f) => manuallyExcluded.has(f.frameId)).map((f) => f.frameId)])];
  const baseRmse = rmse(totalErrors);
  const droppedFrames = excludedFrameIds.filter((id) => !manuallyExcluded.has(id)).length;
  const frameTradeoffPenalty = droppedFrames * baseRmse;
  const overfitPenalty = warpEnergy > rules.localWarpOverfitThreshold ? Math.sqrt(warpEnergy) * 0.5 : 0;
  return {
    candidateId: deterministicId("candidate", `${opts.candidateSeed}:${revision.revisionId}:${seedTag}`),
    archiveId: revision.archiveId,
    branchId: revision.branchId,
    revisionId: revision.revisionId,
    rulesVersion,
    strategy,
    label,
    axis: axisResult.axis,
    transforms,
    validFrameIds: commonValidFrames.filter((id) => !excludedFrameIds.includes(id)),
    excludedFrameIds,
    perFrameResidual: perFrame,
    metrics: {
      totalRmsePixels: baseRmse,
      maxResidualPixels: totalErrors.length ? Math.max(...totalErrors) : NaN,
      validFrames: commonValidFrames.length,
      validPoints,
      warpEnergy,
      overfitPenalty,
      comparableScore: baseRmse + frameTradeoffPenalty + overfitPenalty
    },
    diagnostics,
    ambiguityGroup,
    createdAt: opts.createdAt
  };
}

export function computeAlignmentCandidates(
  revision: SourceRevision,
  rulesVersion: string,
  rules: RuleParameters,
  opts: ComputeOptions
): CandidateComputation {
  const frames = revision.frameIds.map((id) => revision.frameById[id]!);
  const diagnostics: Diagnostic[] = [];
  const manualExcluded = new Set(revision.exclusions.map((e) => e.frameId));
  const usableFrames = frames.filter((f) => f.tiltAngle.parsed && !manualExcluded.has(f.frameId));

  // 1) 拟合倾转轴（不允许默认图像中心）。
  const fitted = fitTiltAxis(usableFrames, revision.tracks, opts.imageSize, false);
  const centerOffset = Math.hypot(fitted.axis.centerX - opts.imageSize.x / 2, fitted.axis.centerY - opts.imageSize.y / 2);
  if (centerOffset > 3) {
    diagnostics.push({
      code: "axis.offset-from-image-center",
      severity: "warning",
      message: `拟合轴线中心 (${fitted.axis.centerX.toFixed(1)}, ${fitted.axis.centerY.toFixed(1)}) 偏离图像中心 ${centerOffset.toFixed(1)}px，禁止把轴线默认固定在图像中心`
    });
  }

  // 2) 高倾角缺失 → 轴线拟合多解，保留全部合法近优候选。
  const maxTilt = Math.max(...usableFrames.map((f) => Math.abs(f.tiltAngle.parsed!.degrees)), 0);
  const highTiltMissing = maxTilt < 50;
  if (highTiltMissing) {
    diagnostics.push({
      code: "high-tilt.missing",
      severity: "warning",
      message: `缺少 |倾角|≥50° 的帧（当前最大 ${maxTilt.toFixed(0)}°），轴线中心不可唯一决定，保留全部合法近优解`
    });
  }

  // 3) 身份交换检测。
  const swaps = detectIdentitySwaps(usableFrames, revision.tracks, fitted.best.modeled);
  if (swaps.some((s) => s.residualPixels > 1)) {
    diagnostics.push({
      code: "fiducial.identity-swap",
      severity: "warning",
      message: "检测到 fiducial 轨迹断裂后身份交换，提供身份重连候选"
    });
  }

  const rigidAlignment = alignFrames(usableFrames, revision.tracks, fitted.best.modeled, new Set(), 0);
  // 共同有效点集：所有候选都在同一批有效帧上比较。
  const commonValidFrames = usableFrames.map((f) => f.frameId);

  const candidates: AlignmentCandidate[] = [];

  // 候选 A：刚体（拟合轴）。
  candidates.push(
    buildCandidate(
      revision, rulesVersion, "rigid", "刚体配准（拟合倾转轴）", "rigid", fitted, rigidAlignment,
      manualExcluded, commonValidFrames, [], 0, rules, opts
    )
  );

  // 候选 A2：错误的朴素做法——轴固定在图像中心，仅作对照，会留下更大残差/诊断。
  const naive = fitTiltAxis(usableFrames, revision.tracks, opts.imageSize, true);
  const naiveAlignment = alignFrames(usableFrames, revision.tracks, naive.best.modeled, new Set(), 0);
  const naiveDiag: Diagnostic[] = [];
  if (centerOffset > 3) {
    naiveDiag.push({
      code: "axis.assumed-center-invalid",
      severity: "error",
      message: "把轴线默认固定在图像中心与观测不符，残差显著增大，不予采纳为默认结论"
    });
  }
  candidates.push(
    buildCandidate(
      revision, rulesVersion, "rigid", "刚体配准（轴线强制图像中心，对照）", "rigid-center", naive, naiveAlignment,
      manualExcluded, commonValidFrames, naiveDiag, 0, rules, opts
    )
  );

  // 候选 B：局部形变（控制点多、容易过拟合时给出诊断与惩罚）。
  const warpStrength = Math.min(1, rules.localWarpControlPoints / 10);
  const warpAlignment = alignFrames(usableFrames, revision.tracks, fitted.best.modeled, new Set(), warpStrength);
  let warpEnergy = 0;
  for (const a of warpAlignment.values()) for (const cp of a.transform.warp) warpEnergy += cp.dx ** 2 + cp.dy ** 2;
  const warpDiag: Diagnostic[] = [];
  if (warpEnergy > rules.localWarpOverfitThreshold) {
    warpDiag.push({
      code: "local-warp.overfit",
      severity: "warning",
      message: `局部形变能量 ${warpEnergy.toFixed(2)} 超过阈值 ${rules.localWarpOverfitThreshold}，疑似过拟合，comparableScore 已加惩罚`
    });
  }
  candidates.push(
    buildCandidate(
      revision, rulesVersion, "local-warp", "局部形变配准", "local-warp", fitted, warpAlignment,
      manualExcluded, commonValidFrames, warpDiag, warpStrength, rules, opts
    )
  );

  // 候选 C：排除坏帧。残差超过 σ 阈值的帧被排除；仍在共同点集上评分，防止用少帧换低残差。
  const rmses = commonValidFrames.map((id) => rigidAlignment.get(id)!.residual.rmsePixels);
  const avg = mean(rmses);
  const sd = Math.sqrt(mean(rmses.map((r) => (r - avg) ** 2)));
  const badFrames = new Set(
    commonValidFrames.filter((id) => rigidAlignment.get(id)!.residual.rmsePixels > avg + rules.badFrameResidualSigma * sd)
  );
  const excludeDiag: Diagnostic[] = [];
  for (const id of badFrames) {
    excludeDiag.push({ code: "bad-frame.excluded", severity: "info", message: `帧 ${revision.frameById[id]!.externalLabel} 残差超阈值，作为坏帧候选排除`, frameId: id });
  }
  const excludeAlignment = alignFrames(usableFrames, revision.tracks, fitted.best.modeled, badFrames, 0);
  candidates.push(
    buildCandidate(
      revision, rulesVersion, "rigid-exclude-bad", "刚体 + 排除坏帧", "exclude-bad", fitted, excludeAlignment,
      new Set([...manualExcluded, ...badFrames]), commonValidFrames, excludeDiag, 0, rules, opts
    )
  );
  // 把自动检测坏帧的 frameTradeoff 惩罚落实：少用的帧按基准残差计罚（buildCandidate 已计 droppedFrames）。

  // 候选 D：身份交换重连后再刚体配准。
  const realSwap = swaps.find((s) => s.residualPixels > 1);
  if (realSwap) {
    const rewired = rewireSwappedTracks(revision.tracks, realSwap, revision.frameIds);
    const refit = fitTiltAxis(usableFrames, rewired, opts.imageSize, false);
    const reAlign = alignFrames(usableFrames, rewired, refit.best.modeled, new Set(), 0);
    candidates.push(
      buildCandidate(
        revision, rulesVersion, "rigid", "刚体配准（fiducial 身份重连）", "identity-rewired", refit, reAlign,
        manualExcluded, commonValidFrames,
        [{ code: "fiducial.swap-corrected", severity: "info", message: "交换点后互换轨迹归属，轨迹可断裂且身份可交换，重连后再比较" }],
        0, rules, opts
      )
    );
  }

  // 候选 E：高倾角缺失时的全部合法近优解（多解），共享 ambiguityGroup。
  if (highTiltMissing) {
    const groupId = deterministicId("candidate", `${opts.candidateSeed}:${revision.revisionId}:ambig-group`).replace("cand-", "ambig-");
    fitted.nearBest.slice(0, 3).forEach((nb, i) => {
      const align = alignFrames(usableFrames, revision.tracks, nb.fit.modeled, new Set(), 0);
      candidates.push(
        buildCandidate(
          revision, rulesVersion, "rigid", `刚体合法近优解 #${i + 1}（轴线多解）`, `ambig-${i}`,
          { best: nb.fit, axis: nb.axis }, align, manualExcluded, commonValidFrames,
          [{ code: "ambiguity.equally-legal", severity: "info", message: "缺少高倾角帧时该轴线解与最优解统计上不可区分，必须保留" }],
          0, rules, opts, groupId
        )
      );
    });
  }

  candidates.sort((a, b) => a.metrics.comparableScore - b.metrics.comparableScore);
  return { candidates, diagnostics, imageSize: opts.imageSize };
}

export function usedPoints(tracks: MarkerTrack[], frameIds: string[]): number {
  return collectObservations(tracks, frameIds).points;
}
