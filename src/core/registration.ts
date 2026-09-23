import type {
  CandidateDiagnostic,
  FiducialObservation,
  PerFrameResidual,
  Point2D,
  RegistrationCandidate,
  TiltAxis,
  VersionRef
} from "../shared/types";
import { axisVectors } from "./geometry";
import { contentHash } from "../shared/hash";

export interface NormalizedObservation {
  observationId: string;
  trackId: string;
  segmentId: string;
  frameId: string;
  tiltDeg: number;
  x: number;
  y: number;
}

export interface FrameMeta {
  frameId: string;
  frameIndex: number;
  tiltDeg: number;
  width: number;
  height: number;
}

export interface RegistrationInput {
  seriesId: string;
  branchId: string;
  observations: NormalizedObservation[];
  frames: FrameMeta[];
  excludedFrameIds: string[];
  exclusionReasons: Record<string, string>;
  gapTrackIds: string[];
  swappedTrackIds: string[];
  parameters: {
    axisPolicy: "unconstrained" | "instrument-anchored";
    instrumentAxis?: TiltAxis;
    maxLocalWarpNorm: number;
    ambiguityResidualThresholdPx: number;
  };
  expectedTiltRangeDeg?: number;
  refs: VersionRef[];
  tags: { rigid: string; warp: string; exclude: string };
  /** 排除帧候选实际丢弃的帧（反例：用少帧换低残差）。 */
  excludeCandidateDrops: string[];
}

export interface DerivedCandidates {
  candidates: RegistrationCandidate[];
  diagnostics: CandidateDiagnostic[];
  effectivePointSetHash: string;
}

/* ---------------- 基础几何：沿给定轴方向解算轨迹参数 ---------------- */

interface TrackFit {
  trackId: string;
  a: number;
  q: number;
  h: number;
  sse: number;
  n: number;
}

interface AxisFit {
  directionDeg: number;
  rms: number;
  anchor: { x: number; y: number };
  trackFits: Map<string, TrackFit>;
}

function decompose(x: number, y: number, ux: number, uy: number) {
  return { along: x * ux + y * uy, perp: x * (-uy) + y * ux };
}

/**
 * 固定轴方向 α 时，对每条 track 的观测做最小二乘：
 *   perp(θ) = q·cosθ + h·sinθ （相对该 track 自身常数，平移吸收到 anchor）
 * 沿轴分量 along ≈ a（常数 + 噪声）。
 */
function fitTracksForDirection(
  obs: NormalizedObservation[],
  directionDeg: number
): { trackFits: Map<string, TrackFit>; sse: number } {
  const { ux, uy } = axisVectors(directionDeg);
  const byTrack = new Map<string, NormalizedObservation[]>();
  for (const o of obs) {
    const list = byTrack.get(o.trackId) ?? [];
    list.push(o);
    byTrack.set(o.trackId, list);
  }
  let sse = 0;
  const trackFits = new Map<string, TrackFit>();
  for (const [trackId, list] of byTrack) {
    let ac = 0;
    let cc = 0;
    let hh = 0;
    let ch = 0;
    let cp = 0;
    let hp = 0;
    let alongSum = 0;
    for (const o of list) {
      const t = (o.tiltDeg * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const { along, perp } = decompose(o.x, o.y, ux, uy);
      cc += c * c;
      hh += s * s;
      ch += c * s;
      cp += c * perp;
      hp += s * perp;
      alongSum += along;
    }
    const n = list.length;
    const det = cc * hh - ch * ch;
    let q = 0;
    let h = 0;
    if (Math.abs(det) > 1e-9) {
      q = (hh * cp - ch * hp) / det;
      h = (cc * hp - ch * cp) / det;
    }
    let trackSse = 0;
    for (const o of list) {
      const t = (o.tiltDeg * Math.PI) / 180;
      const { perp } = decompose(o.x, o.y, ux, uy);
      const resid = perp - (q * Math.cos(t) + h * Math.sin(t));
      trackSse += resid * resid;
    }
    sse += trackSse;
    trackFits.set(trackId, { trackId, a: alongSum / n, q, h, sse: trackSse, n });
  }
  return { trackFits, sse };
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function anchorFromTracks(
  obs: NormalizedObservation[],
  fits: Map<string, TrackFit>,
  directionDeg: number
): { x: number; y: number } {
  const { ux, uy, vx, vy } = axisVectors(directionDeg);
  const perpOffsets: number[] = [];
  const alongCenters: number[] = [];
  for (const [trackId, fit] of fits) {
    const trackObs = obs.filter((o) => o.trackId === trackId);
    let perpMean = 0;
    for (const o of trackObs) perpMean += o.x * (-uy) + o.y * ux;
    perpMean /= trackObs.length;
    perpOffsets.push(perpMean - fit.q);
    alongCenters.push(fit.a);
  }
  const anchorPerp = median(perpOffsets);
  const anchorAlong = median(alongCenters);
  return {
    x: anchorAlong * ux + anchorPerp * vx,
    y: anchorAlong * uy + anchorPerp * vy
  };
}

/** 搜索轴方向：返回最优及阈值内其它局部极小（多解）。 */
function searchAxis(obs: NormalizedObservation[], thresholdPx: number): {
  best: AxisFit;
  alternates: { directionDeg: number; rmsPx: number; anchor: { x: number; y: number } }[];
  ambiguous: boolean;
} {
  const scored: { directionDeg: number; sse: number; fits: Map<string, TrackFit> }[] = [];
  for (let alpha = -90; alpha <= 90; alpha += 0.5) {
    const { sse, trackFits } = fitTracksForDirection(obs, alpha);
    scored.push({ directionDeg: alpha, sse, fits: trackFits });
  }
  scored.sort((a, b) => a.sse - b.sse);
  const n = obs.length;
  const toFit = (s: (typeof scored)[number]): AxisFit => ({
    directionDeg: s.directionDeg,
    rms: Math.sqrt(s.sse / n),
    anchor: anchorFromTracks(obs, s.fits, s.directionDeg),
    trackFits: s.fits
  });
  const best = toFit(scored[0]);
  const alternates: { directionDeg: number; rmsPx: number; anchor: { x: number; y: number } }[] = [];
  for (let i = 1; i < scored.length; i++) {
    const cand = toFit(scored[i]);
    const nearExisting = alternates.some((a) => Math.abs(a.directionDeg - cand.directionDeg) < 5);
    const nearBest = Math.abs(cand.directionDeg - best.directionDeg) < 5;
    if (cand.rms - best.rms <= thresholdPx && !nearBest && !nearExisting) {
      alternates.push({ directionDeg: cand.directionDeg, rmsPx: cand.rms, anchor: cand.anchor });
    }
    if (alternates.length >= 3) break;
  }
  return { best, alternates, ambiguous: alternates.length > 0 };
}

/* ---------------- 每帧残差 / 漂移（刚体）与局部形变 ---------------- */

interface ResidualResult {
  perFrame: PerFrameResidual[];
  rms: number;
  /** 每帧平移 dx,dy（用于审阅页叠影对齐）。 */
  transforms: Record<string, { dx: number; dy: number; tiltDeg: number }>;
  warpEnergy: number;
}

function predictedPoint(fit: TrackFit | undefined, tiltDeg: number, directionDeg: number) {
  const { vx, vy } = axisVectors(directionDeg);
  const t = (tiltDeg * Math.PI) / 180;
  const perp = (fit?.q ?? 0) * Math.cos(t) + (fit?.h ?? 0) * Math.sin(t);
  return { x: perp * vx, y: perp * vy };
}

/**
 * 刚体方案：
 *  1) 用全部有效点估计轴；
 *  2) 逐帧取各 track 残差中位数作为刚体漂移（异常点被 track-swap 污染时仍稳健）；
 *  3) 补偿后给出每帧 RMS。
 */
function rigidResiduals(
  obs: NormalizedObservation[],
  frames: FrameMeta[],
  fit: AxisFit
): ResidualResult {
  const { ux, uy } = axisVectors(fit.directionDeg);
  // 预测点（含 anchor）
  const residualAt = (o: NormalizedObservation) => {
    const trackFit = fit.trackFits.get(o.trackId);
    const base = predictedPoint(trackFit, o.tiltDeg, fit.directionDeg);
    const predX = fit.anchor.x + (trackFit?.a ?? 0) * ux + base.x;
    const predY = fit.anchor.y + (trackFit?.a ?? 0) * uy + base.y;
    return { dx: o.x - predX, dy: o.y - predY };
  };
  const transforms: ResidualResult["transforms"] = {};
  const perFrame: PerFrameResidual[] = [];
  let sse = 0;
  let count = 0;
  for (const frame of frames) {
    const frameObs = obs.filter((o) => o.frameId === frame.frameId);
    const rxs = frameObs.map((o) => residualAt(o).dx);
    const rys = frameObs.map((o) => residualAt(o).dy);
    const shiftX = rxs.length ? median(rxs) : 0;
    const shiftY = rys.length ? median(rys) : 0;
    transforms[frame.frameId] = { dx: -shiftX, dy: -shiftY, tiltDeg: frame.tiltDeg };
    let frameSse = 0;
    for (const o of frameObs) {
      const r = residualAt(o);
      frameSse += (r.dx - shiftX) ** 2 + (r.dy - shiftY) ** 2;
    }
    if (frameObs.length) {
      sse += frameSse;
      count += frameObs.length;
    }
    perFrame.push({
      frameId: frame.frameId,
      tiltDeg: frame.tiltDeg,
      rmsPx: frameObs.length ? Math.sqrt(frameSse / frameObs.length) : 0,
      used: frameObs.length > 0
    });
  }
  return { perFrame, rms: count ? Math.sqrt(sse / count) : 0, transforms, warpEnergy: 0 };
}

/** 局部形变：每帧 6 参数仿射（刚体只用 2 参数平移）。 */
function warpResiduals(
  obs: NormalizedObservation[],
  frames: FrameMeta[],
  fit: AxisFit
): ResidualResult {
  const { ux, uy } = axisVectors(fit.directionDeg);
  const predicted = (o: NormalizedObservation) => {
    const trackFit = fit.trackFits.get(o.trackId);
    const base = predictedPoint(trackFit, o.tiltDeg, fit.directionDeg);
    return {
      px: fit.anchor.x + (trackFit?.a ?? 0) * ux + base.x,
      py: fit.anchor.y + (trackFit?.a ?? 0) * uy + base.y
    };
  };
  const transforms: ResidualResult["transforms"] = {};
  const perFrame: PerFrameResidual[] = [];
  let sse = 0;
  let count = 0;
  let warpEnergy = 0;
  for (const frame of frames) {
    const frameObs = obs.filter((o) => o.frameId === frame.frameId);
    // 最小二乘仿射 [x'] = [a b tx; c d ty][x;1]
    let A00 = 0, A01 = 0, A11 = 0, bx = 0, by = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    const nPts = frameObs.length;
    for (const o of frameObs) {
      const { px, py } = predicted(o);
      A00 += px * px; A01 += px * py; A11 += py * py;
      sx += px; sy += py; sxx += o.x * px; sxy += o.x * py; syy += o.y * px;
      bx += o.x; by += o.y;
    }
    let a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0;
    if (nPts >= 3) {
      const M = [
        [A00, A01, sx],
        [A01, A11, sy],
        [sx, sy, nPts]
      ];
      const solX = solve3(M, [sxx, sxy, bx]);
      const solY = solve3(M, [
        frameObs.reduce((z, o) => z + predicted(o).px * o.y, 0),
        frameObs.reduce((z, o) => z + predicted(o).py * o.y, 0),
        by
      ]);
      if (solX && solY) {
        [a, b, tx] = solX;
        [c, d, ty] = solY;
      }
    } else if (nPts > 0) {
      tx = frameObs.reduce((z, o) => z + o.x - predicted(o).px, 0) / nPts;
      ty = frameObs.reduce((z, o) => z + o.y - predicted(o).py, 0) / nPts;
    }
    warpEnergy += (a - 1) ** 2 + b * b + c * c + (d - 1) ** 2;
    let frameSse = 0;
    for (const o of frameObs) {
      const { px, py } = predicted(o);
      const qx = a * px + b * py + tx;
      const qy = c * px + d * py + ty;
      frameSse += (o.x - qx) ** 2 + (o.y - qy) ** 2;
    }
    if (nPts) {
      sse += frameSse;
      count += nPts;
    }
    // 审阅叠影仍展示平移分量
    transforms[frame.frameId] = { dx: tx, dy: ty, tiltDeg: frame.tiltDeg };
    perFrame.push({
      frameId: frame.frameId,
      tiltDeg: frame.tiltDeg,
      rmsPx: nPts ? Math.sqrt(frameSse / nPts) : 0,
      used: nPts > 0
    });
  }
  return { perFrame, rms: count ? Math.sqrt(sse / count) : 0, transforms, warpEnergy };
}

function solve3(M: number[][], rhs: number[]): [number, number, number] | null {
  const A = M.map((row, i) => [...row, rhs[i]]);
  const n = 3;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k <= n; k++) A[r][k] -= f * A[col][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

/* ---------------- 轨迹身份交换检测 ---------------- */

interface SegmentSignature {
  segmentId: string;
  trackId: string;
  q: number;
  h: number;
  tiltMean: number;
}

function segmentSignatures(obs: NormalizedObservation[], directionDeg: number): SegmentSignature[] {
  const { uy, ux } = axisVectors(directionDeg);
  const bySeg = new Map<string, NormalizedObservation[]>();
  for (const o of obs) {
    const list = bySeg.get(o.segmentId) ?? [];
    list.push(o);
    bySeg.set(o.segmentId, list);
  }
  const sigs: SegmentSignature[] = [];
  for (const [segmentId, list] of bySeg) {
    let cc = 0, hh = 0, ch = 0, cp = 0, hp = 0, tiltSum = 0;
    for (const o of list) {
      const t = (o.tiltDeg * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const perp = o.x * (-uy) + o.y * ux;
      cc += c * c; hh += s * s; ch += c * s; cp += c * perp; hp += s * perp; tiltSum += o.tiltDeg;
    }
    const det = cc * hh - ch * ch;
    const q = det ? (hh * cp - ch * hp) / det : 0;
    const h = det ? (cc * hp - ch * cp) / det : 0;
    sigs.push({ segmentId, trackId: list[0].trackId, q, h, tiltMean: tiltSum / list.length });
  }
  return sigs;
}

/**
 * 检测身份交换：同一 trackId 在跟踪缺口两侧的 (q,h) 签名，若与另一 track 更匹配，则交换。
 */
export function detectTrackSwap(obs: NormalizedObservation[], directionDeg: number): {
  swapped: string[];
  pairs: { trackA: string; segA: string; trackB: string; segB: string; distance: number }[];
} {
  const sigs = segmentSignatures(obs, directionDeg);
  const neg = sigs.filter((s) => s.tiltMean < 0);
  const pos = sigs.filter((s) => s.tiltMean >= 0);
  const pairs: ReturnType<typeof detectTrackSwap>["pairs"] = [];
  const swapped = new Set<string>();
  for (const p of pos) {
    if (!neg.some((n) => n.trackId === p.trackId)) continue;
    const own = neg.find((n) => n.trackId === p.trackId)!;
    const dOwn = Math.hypot(p.q - own.q, p.h - own.h);
    let bestOther: { n: SegmentSignature; d: number } | null = null;
    for (const n of neg) {
      if (n.trackId === p.trackId) continue;
      const d = Math.hypot(p.q - n.q, p.h - n.h);
      if (!bestOther || d < bestOther.d) bestOther = { n, d };
    }
    if (bestOther && bestOther.d + 6 < dOwn && dOwn > 8) {
      pairs.push({ trackA: p.trackId, segA: p.segmentId, trackB: bestOther.n.trackId, segB: bestOther.n.segmentId, distance: dOwn - bestOther.d });
      swapped.add(p.trackId);
      swapped.add(bestOther.n.trackId);
    }
  }
  return { swapped: [...swapped], pairs };
}

/* ---------------- 主派生：三类候选 + 全部领域诊断 ---------------- */

function pointSetHash(obs: NormalizedObservation[]): string {
  return contentHash({ obs: obs.map((o) => o.observationId).sort() });
}

function buildAxis(input: RegistrationInput, fit: AxisFit): TiltAxis {
  if (input.parameters.axisPolicy === "instrument-anchored" && input.parameters.instrumentAxis) {
    return input.parameters.instrumentAxis;
  }
  const anchor: Point2D = {
    x: fit.anchor.x,
    y: fit.anchor.y,
    basis: { kind: "image-pixel-grid", origin: "top-left", unit: "pixel" }
  };
  return {
    kind: "tiltAxis",
    seriesId: input.seriesId,
    directionDeg: fit.directionDeg,
    anchor,
    anchored: false,
    anchorProvenance: { source: "fiducial-fit", refs: input.refs }
  };
}

export function deriveCandidates(input: RegistrationInput): DerivedCandidates {
  const excludedSet = new Set(input.excludedFrameIds);
  const validFrames = input.frames.filter((f) => !excludedSet.has(f.frameId));
  const usedFrameIds = validFrames.map((f) => f.frameId);
  let obs = input.observations.filter((o) => !excludedSet.has(o.frameId));

  const effectivePointSetHash = pointSetHash(obs);

  // 轴估计（unconstrained）：绝不默认中心。
  const search = searchAxis(obs, input.parameters.ambiguityResidualThresholdPx);
  const axisFit = search.best;

  // 身份交换检测
  const swap = detectTrackSwap(obs, axisFit.directionDeg);

  const diagnostics: CandidateDiagnostic[] = [];
  const imageCenter = {
    x: input.frames[0]?.width ? input.frames[0].width / 2 : 0,
    y: input.frames[0]?.height ? input.frames[0].height / 2 : 0
  };
  const axis = buildAxis(input, axisFit);

  // 诊断：轴线偏心（拟合锚点远离中心）。
  if (!axis.anchored || axis.anchorProvenance?.source === "fiducial-fit") {
    const off = Math.hypot(axisFit.anchor.x - imageCenter.x, axisFit.anchor.y - imageCenter.y);
    if (off > 12) {
      diagnostics.push({
        code: "axis-off-center",
        severity: "info",
        message: `拟合倾转轴锚点偏离图像中心 ${off.toFixed(1)} px；未采用中心默认。`,
        frameIds: []
      });
    }
  } else {
    // 仪器锚定为中心默认时，与无约束拟合显著不同 => 警告
    const ax = axis.anchor!;
    const off = Math.hypot(ax.x - axisFit.anchor.x, ax.y - axisFit.anchor.y);
    const dAng = Math.abs(axis.directionDeg - axisFit.directionDeg);
    if (off > 12) {
      diagnostics.push({
        code: "axis-off-center",
        severity: "warning",
        message: `仪器/中心锚定轴与 fiducial 无约束拟合相差 ${off.toFixed(1)} px（${dAng.toFixed(1)}°）；不允许默认中心。`,
        frameIds: []
      });
    }
  }

  if (swap.pairs.length) {
    diagnostics.push({
      code: "track-identity-swap",
      severity: "warning",
      message: `跟踪缺口两侧发现 ${swap.pairs.length} 组 fiducial 身份交换：${swap.pairs
        .map((p) => `${p.trackA}↔${p.trackB}`)
        .join("，")}。轨迹可断裂，身份不可默认连续。`,
      trackIds: swap.swapped
    });
  }

  // 诊断：缺失高倾角帧
  const tilts = validFrames.map((f) => f.tiltDeg).sort((a, b) => a - b);
  const minTilt = tilts[0] ?? 0;
  const maxTilt = tilts[tilts.length - 1] ?? 0;
  const expected = input.expectedTiltRangeDeg ?? 55;
  if (Math.max(Math.abs(minTilt), Math.abs(maxTilt)) < expected) {
    diagnostics.push({
      code: "missing-high-tilt",
      severity: "warning",
      message: `最高可用倾角仅 ${Math.max(Math.abs(minTilt), Math.abs(maxTilt)).toFixed(0)}°（期望 ±${expected}°）；缺失高倾角帧，z 分辨率受限。`,
      frameIds: input.frames.filter((f) => Math.abs(f.tiltDeg) >= expected).map((f) => f.frameId)
    });
  }

  /* ----- 候选 A：刚体（全部有效帧） ----- */
  const rigid = rigidResiduals(obs, validFrames, axisFit);
  /* ----- 候选 B：局部形变（相同点集） ----- */
  const warp = warpResiduals(obs, validFrames, axisFit);

  /* ----- 候选 C：排除坏帧（子集），但 RMS 一律按相同有效点集计算 ----- */
  const dropSet = new Set(input.excludeCandidateDrops);
  const keptFrames = validFrames.filter((f) => !dropSet.has(f.frameId));
  const keptObs = obs.filter((o) => !dropSet.has(o.frameId));
  const dropFit = searchAxis(keptObs, input.parameters.ambiguityResidualThresholdPx).best;
  const excludeOnKept = rigidResiduals(keptObs, keptFrames, dropFit);
  // 关键：用子集模型在“相同有效点集”上评估残差
  const canonicalRmsExclude = canonicalSetRms(obs, validFrames, dropFit, axisFit);
  const excludePerFrame = excludeOnKept.perFrame.map((pf) => {
    if (dropSet.has(pf.frameId)) return { ...pf, used: false, excludedReason: "excluded-to-lower-residual" };
    return pf;
  });

  /** 用子集轴模型在标准（相同）有效点集上评估 RMS，杜绝“少帧换低残差”。 */
  function canonicalSetRms(
    canonicalObs: NormalizedObservation[],
    canonicalFrames: FrameMeta[],
    subsetFit: AxisFit,
    _fullFit: AxisFit
  ): number {
    return rigidResiduals(canonicalObs, canonicalFrames, subsetFit).rms;
  }

  const canonicalRigid = rigid.rms;
  const canonicalWarp = warp.rms;

  // 诊断：局部形变过拟合
  const normalizedWarp = Math.sqrt(warp.warpEnergy / validFrames.length);
  const warpGain = canonicalRigid - canonicalWarp;
  const warpOverfit = normalizedWarp > input.parameters.maxLocalWarpNorm && warpGain < 0.5 * canonicalRigid;
  if (warpOverfit) {
    diagnostics.push({
      code: "local-warp-overfit",
      severity: "error",
      message: `局部形变能量 ${(normalizedWarp * 100).toFixed(2)}%/帧 超过阈值 ${(
        input.parameters.maxLocalWarpNorm * 100
      ).toFixed(2)}%，而 RMS 仅降低 ${warpGain.toFixed(2)} px：判为过拟合，拒绝以形变吸收跟踪误差。`
    });
  }

  // 诊断：坏帧排除（人工、对全部候选生效的合法排除）
  if (input.excludedFrameIds.length) {
    diagnostics.push({
      code: "bad-frame-excluded",
      severity: "info",
      message: `人工排除坏帧 ${input.excludedFrameIds.length} 个：${input.excludedFrameIds
        .map((id) => `${id}(${input.exclusionReasons[id] ?? "未注明"})`)
        .join("，")}。`,
      frameIds: input.excludedFrameIds
    });
  }

  // 诊断：排除帧候选试图用少帧换低残差
  if (input.excludeCandidateDrops.length) {
    const rmsOnFewer = excludeOnKept.rms;
    const coverageDrop = keptFrames.length / validFrames.length;
    if (rmsOnFewer + 1e-6 < canonicalRigid && canonicalRmsExclude + 0.25 >= canonicalRigid) {
      diagnostics.push({
        code: "fewer-frames-lower-residual-rejected",
        severity: "error",
        message: `排除帧候选仅在 ${keptFrames.length}/${validFrames.length} 帧上把 RMS 降到 ${rmsOnFewer.toFixed(
          2
        )} px，但在相同有效点集上为 ${canonicalRmsExclude.toFixed(
          2
        )} px，并不优于刚体 ${canonicalRigid.toFixed(2)} px；不得用少帧换低残差（覆盖度 ${(coverageDrop * 100).toFixed(0)}%）。`,
        frameIds: input.excludeCandidateDrops
      });
    }
  }

  function coverage() {
    return {
      frameCount: validFrames.length,
      totalFrameCount: input.frames.length,
      tiltSpanDeg: maxTilt - minTilt
    };
  }

  const angleKeys = (frameIds: string[]) =>
    frameIds.map((id) => `tiltAngle:${id}`);
  const baseDepKeys = [
    `pixelScale:${input.seriesId}`,
    `fiducialObservation:${input.seriesId}`,
    `trackingGap:${input.seriesId}`,
    `manualExclusion:${input.seriesId}`,
    `parameterSet:${input.branchId}`
  ];
  const depKeysFor = (frameIds: string[]) => [...baseDepKeys, ...angleKeys(frameIds)];

  const common = {
    seriesId: input.seriesId,
    effectivePointSetHash,
    usedFrameIds,
    excludedFrameIds: input.excludedFrameIds,
    trackingGapIds: input.gapTrackIds.map((t) => `gap:${t}`),
    axis,
    coverage: coverage(),
    dependencies: depKeysFor(usedFrameIds),
    refs: input.refs
  } as const;

  const candidates: RegistrationCandidate[] = [
    {
      ...common,
      kind: "registrationCandidate",
      branchId: input.branchId,
      model: "rigid",
      rmsPx: canonicalRigid,
      warpEnergy: 0,
      perFrame: rigid.perFrame,
      frameTransforms: rigid.transforms,
      diagnostics: diagnostics.filter((d) =>
        ["axis-off-center", "track-identity-swap", "missing-high-tilt", "bad-frame-excluded", "multi-solution"].includes(
          d.code
        )
      ),
      alternateAxes: search.ambiguous
        ? search.alternates.map((a) => ({
            directionDeg: a.directionDeg,
            rmsPx: a.rmsPx,
            anchor: {
              x: a.anchor.x,
              y: a.anchor.y,
              basis: { kind: "image-pixel-grid", origin: "top-left", unit: "pixel" }
            }
          }))
        : undefined,
      ambiguous: search.ambiguous,
      solveStatus: search.ambiguous ? "ambiguous" : "unique"
    }
  ];

  candidates.push({
    ...common,
    kind: "registrationCandidate",
    branchId: input.branchId,
    model: "local-warp",
    rmsPx: canonicalWarp,
    warpEnergy: normalizedWarp,
    perFrame: warp.perFrame,
    frameTransforms: warp.transforms,
    diagnostics: [
      ...diagnostics.filter((d) =>
        ["axis-off-center", "track-identity-swap", "missing-high-tilt", "bad-frame-excluded"].includes(d.code)
      ),
      ...(warpOverfit
        ? [
            {
              code: "local-warp-overfit" as const,
              severity: "error" as const,
              message: diagnostics.find((d) => d.code === "local-warp-overfit")!.message
            }
          ]
        : [])
    ],
    ambiguous: search.ambiguous,
    solveStatus: warpOverfit ? "overfit" : search.ambiguous ? "ambiguous" : "ok"
  });

  candidates.push({
    ...common,
    kind: "registrationCandidate",
    branchId: input.branchId,
    model: "exclude-frames",
    rmsPx: canonicalRmsExclude,
    warpEnergy: 0,
    usedFrameIds: keptFrames.map((f) => f.frameId),
    dependencies: depKeysFor(keptFrames.map((f) => f.frameId)),
    perFrame: [
      ...excludePerFrame,
      ...input.frames
        .filter((f) => excludedSet.has(f.frameId))
        .map((f) => ({
          frameId: f.frameId,
          tiltDeg: f.tiltDeg,
          rmsPx: 0,
          used: false,
          excludedReason: input.exclusionReasons[f.frameId] ?? "manual-exclusion"
        }))
    ],
    frameTransforms: excludeOnKept.transforms,
    diagnostics: diagnostics.filter((d) =>
      ["bad-frame-excluded", "fewer-frames-lower-residual-rejected", "missing-high-tilt"].includes(d.code)
    ),
    ambiguous: false,
    solveStatus: canonicalRmsExclude + 0.25 >= canonicalRigid && dropSet.size > 0 ? "degenerate" : "ok"
  });

  // 多解诊断附加到整体（被所有保留轴候选的模型共享）
  if (search.ambiguous) {
    diagnostics.push({
      code: "multi-solution",
      severity: "warning",
      message: `倾转轴在残差阈值 ${input.parameters.ambiguityResidualThresholdPx.toFixed(
        2
      )} px 内存在 ${search.alternates.length + 1} 个合法解（${[axisFit.directionDeg, ...search.alternates.map(
        (a) => a.directionDeg
      )]
        .map((a) => `${a.toFixed(1)}°`)
        .join(" / ")}）；保留全部合法候选，不唯一裁定。`
    });
  }

  return { candidates, diagnostics, effectivePointSetHash };
}
