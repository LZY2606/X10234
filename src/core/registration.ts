import {
  affineFit,
  applyRigid,
  centroid,
  leastSquares,
  rigidProcrustes,
  type Point,
} from './linalg.ts';
import { fingerprint } from '../shared/ids.ts';
import type {
  CandidateDifference,
  CandidateScore,
  Diagnostic,
  FrameResidual,
  FrameTransform,
  MarkerResidual,
  RegistrationCandidate,
  RegistrationModelKind,
  StableId,
  TiltAxisEstimate,
} from '../shared/types.ts';

/** 第 j 帧上第 i 个 fiducial 的像素坐标观测（坐标基准：帧 j 像素坐标）。 */
export interface MarkerObservation {
  markerId: StableId;
  frameIndex: number;
  x: number;
  y: number;
  present: boolean;
}

export interface FrameInfo {
  frameId: StableId;
  index: number;
  tiltDeg: number;
  excluded: boolean;
  exclusionReason: string | null;
  width: number;
  height: number;
}

export interface CandidateOptions {
  id: StableId;
  branchId: StableId;
  label: string;
  modelKind: RegistrationModelKind;
  frames: FrameInfo[];
  observations: MarkerObservation[];
  parameterVersion: number;
  sourceVersion: number;
  localWarpExclusionCandidates?: StableId[];
  forcedAxis?: { x: number; y: number; angleDeg: number; assumedCenter: boolean };
}

function markerIdsSorted(obs: MarkerObservation[]): StableId[] {
  return [...new Set(obs.filter((o) => o.present).map((o) => o.markerId))].sort();
}

/**
 * 有效点集指纹：参与比较的候选必须有相同 (marker, frame) 观测集合，
 * 禁止“少几帧换低残差”。
 */
export function pointSetFingerprint(
  frames: FrameInfo[],
  observations: MarkerObservation[],
  includedFrameIds: Set<StableId>,
): { fp: string; markers: StableId[] } {
  const markers = markerIdsSorted(observations);
  const parts: string[] = [];
  for (const frame of frames) {
    if (!includedFrameIds.has(frame.frameId)) continue;
    for (const marker of markers) {
      const hit = observations.find(
        (o) => o.markerId === marker && o.frameIndex === frame.index && o.present,
      );
      if (hit) parts.push(`${marker}@${frame.index}`);
    }
  }
  parts.sort();
  return { fp: fingerprint([...markers, ...parts]), markers };
}

/** 参考几何：所有有效帧上各 marker 的质心（fiducial 在叠影坐标中的基准）。 */
function referencePositions(
  frames: FrameInfo[],
  observations: MarkerObservation[],
  included: Set<StableId>,
): Map<StableId, Point> {
  const byMarker = new Map<StableId, Point[]>();
  for (const obs of observations) {
    if (!obs.present) continue;
    const frame = frames.find((f) => f.index === obs.frameIndex);
    if (!frame || !included.has(frame.frameId)) continue;
    const list = byMarker.get(obs.markerId) ?? [];
    list.push({ x: obs.x, y: obs.y });
    byMarker.set(obs.markerId, list);
  }
  const result = new Map<StableId, Point>();
  for (const [marker, list] of byMarker) {
    if (list.length >= 2) result.set(marker, centroid(list));
  }
  return result;
}

function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/**
 * 倾转轴估计：fiducial 随倾角在「垂直于轴线」方向移动。
 * 对每个 marker 拟合 p(frame) ≈ p0 + k*sin(tilt)*n，其中 n=(sin a, -cos a) 是轴法向，
 * 联合最小二乘求 (axisX, axisY, angleDeg)。绝不默认轴线穿过图像中心。
 */
export function estimateAxis(
  frames: FrameInfo[],
  observations: MarkerObservation[],
  included: Set<StableId>,
  forced?: { x: number; y: number; angleDeg: number; assumedCenter: boolean },
): TiltAxisEstimate {
  if (forced) {
    const cx = frames[0] ? frames[0].width / 2 : 0;
    const cy = frames[0] ? frames[0].height / 2 : 0;
    return {
      id: `axis_${fingerprint(['forced', forced.x, forced.y, forced.angleDeg])}`,
      x: forced.x,
      y: forced.y,
      angleDeg: forced.angleDeg,
      assumedCenter: forced.assumedCenter,
      basis: forced.assumedCenter
        ? '错误先验：轴线被默认固定在图像中心'
        : `外部指定轴线，相对图像中心偏移 (${(forced.x - cx).toFixed(1)}, ${(forced.y - cy).toFixed(1)}) px`,
      supportingMarkerIds: markerIdsSorted(observations),
      ambiguityWith: null,
    };
  }

  const markers = markerIdsSorted(observations);
  const usableFrames = frames.filter((f) => included.has(f.frameId));
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (const marker of markers) {
    const series = observations.filter(
      (o) => o.markerId === marker && o.present && included.has(frames[o.frameIndex]!.frameId),
    );
    if (series.length < 3) continue;
    const ref = centroid(series.map((s) => ({ x: s.x, y: s.y })));
    for (const obs of series) {
      const tilt = usableFrames.find((f) => f.index === obs.frameIndex)?.tiltDeg ?? 0;
      const s = Math.sin((tilt * Math.PI) / 180);
      if (Math.abs(s) < 1e-6) continue;
      // 令 d = p - p0 = k*s*n。联立所有点先解 (nx, ny)（模约束后归一化）。
      rows.push([s, 0]);
      rhs.push(obs.x - ref.x);
      rows.push([0, s]);
      rhs.push(obs.y - ref.y);
    }
  }
  let nx = 0;
  let ny = 1;
  const nFit = leastSquares(rows, rhs);
  if (nFit) {
    const norm = Math.hypot(nFit[0]!, nFit[1]!) || 1;
    nx = nFit[0]! / norm;
    ny = nFit[1]! / norm;
  }
  const axisAngle = (Math.atan2(-nx, -ny) * 180) / Math.PI;

  // 轴上点：取 marker 零倾位置在轴方向上的分布，拟合轴偏移。
  const axisDir: Point = { x: Math.cos((axisAngle * Math.PI) / 180), y: Math.sin((axisAngle * Math.PI) / 180) };
  let ax = 0;
  let ay = 0;
  let count = 0;
  for (const marker of markers) {
    const nearZero = observations
      .filter((o) => o.markerId === marker && o.present)
      .sort((a, b) => {
        const ta = Math.abs(frames[a.frameIndex]?.tiltDeg ?? 0);
        const tb = Math.abs(frames[b.frameIndex]?.tiltDeg ?? 0);
        return ta - tb;
      })[0];
    if (!nearZero) continue;
    // 过该点、沿 axisDir 的直线族；用零倾点质心近似轴上的代表点
    ax += nearZero.x - nx * 0;
    ay += nearZero.y - ny * 0;
    count += 1;
  }
  ax = count ? ax / count : 0;
  ay = count ? ay / count : 0;

  return {
    id: `axis_${fingerprint(['fit', ax.toFixed(3), ay.toFixed(3), axisAngle.toFixed(3)])}`,
    x: ax,
    y: ay,
    angleDeg: axisAngle,
    assumedCenter: false,
    basis: '由 fiducial 随倾角位移联合最小二乘估计（轴线不固定于图像中心）',
    supportingMarkerIds: markers,
    ambiguityWith: null,
    axisDirection: axisDir,
  } as TiltAxisEstimate & { axisDirection: Point };
}

/** 对称倾角范围（无零倾先验）会产生相差 180° 的两个不可区分轴解。 */
export function axisHasAmbiguity(frames: FrameInfo[], included: Set<StableId>): boolean {
  const tilts = frames.filter((f) => included.has(f.frameId)).map((f) => f.tiltDeg);
  if (tilts.length < 4) return true;
  const min = Math.min(...tilts);
  const max = Math.max(...tilts);
  return Math.abs(Math.abs(min) - Math.abs(max)) < 2.0;
}

function framePoints(
  frame: FrameInfo,
  observations: MarkerObservation[],
  ref: Map<StableId, Point>,
): { src: Point[]; dst: Point[]; markerIds: StableId[] } {
  const src: Point[] = [];
  const dst: Point[] = [];
  const markerIds: StableId[] = [];
  for (const obs of observations) {
    if (obs.frameIndex !== frame.index || !obs.present) continue;
    const r = ref.get(obs.markerId);
    if (!r) continue;
    src.push(r);
    dst.push({ x: obs.x, y: obs.y });
    markerIds.push(obs.markerId);
  }
  return { src, dst, markerIds };
}

interface SolvedFrame {
  transform: FrameTransform;
  residual: FrameResidual;
}

function solveRigidFrames(
  frames: FrameInfo[],
  observations: MarkerObservation[],
  included: Set<StableId>,
  ref: Map<StableId, Point>,
): SolvedFrame[] {
  return frames.map((frame) => {
    const { src, dst, markerIds } = framePoints(frame, observations, ref);
    const isIncluded = included.has(frame.frameId);
    const fit = isIncluded ? rigidProcrustes(src, dst) : null;
    const perMarker: MarkerResidual[] = markerIds.map((markerId, i) => {
      const predicted = fit ? applyRigid(src[i]!, fit) : src[i]!;
      return {
        markerId,
        dx: dst[i]!.x - predicted.x,
        dy: dst[i]!.y - predicted.y,
      };
    });
    const mags = isIncluded && fit ? perMarker.map((r) => Math.hypot(r.dx, r.dy)) : [];
    return {
      transform: {
        frameId: frame.frameId,
        tx: fit?.tx ?? 0,
        ty: fit?.ty ?? 0,
        rotRad: fit?.rotRad ?? 0,
        included: isIncluded,
        excludedReason: isIncluded ? null : frame.exclusionReason ?? '未参与配准',
      },
      residual: {
        frameId: frame.frameId,
        included: isIncluded,
        rms: mags.length ? Math.sqrt(mags.reduce((s, m) => s + m * m, 0) / mags.length) : 0,
        max: mags.length ? Math.max(...mags) : 0,
        perMarker,
      },
    };
  });
}

/** 局部形变：每帧做仿射 + 帧内二次局部项，用自由度惩罚识别过拟合。 */
function solveLocalWarp(
  frame: FrameInfo,
  observations: MarkerObservation[],
  ref: Map<StableId, Point>,
): { solved: SolvedFrame; dof: number; warpMagnitude: number; pointCount: number } | null {
  const { src, dst, markerIds } = framePoints(frame, observations, ref);
  if (src.length < 6) return null;
  const rowsA: number[][] = [];
  const rowsB: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const s = src[i]!;
    const d = dst[i]!;
    rowsA.push([s.x, s.y, 1, s.x * s.y, 0, 0, 0, 0, 0]);
    rowsB.push(d.x);
    rowsA.push([0, 0, 0, 0, s.x, s.y, 1, s.x * s.y, 0]);
    rowsB.push(d.y);
  }
  const fit = leastSquares(rowsA, rowsB);
  const affineParams = affineFit(src, dst);
  let warpMagnitude = 0;
  if (fit && affineParams) {
    const [a, b, tx, w1, c, d, ty, w2] = fit;
    void [a, b, tx, c, d, ty];
    warpMagnitude = Math.hypot(w1 ?? 0, w2 ?? 0);
  }
  const perMarker: MarkerResidual[] = markerIds.map((markerId, i) => {
    const s = src[i]!;
    const predicted = fit
      ? {
          x: fit[0]! * s.x + fit[1]! * s.y + fit[2]! + fit[3]! * s.x * s.y,
          y: fit[4]! * s.x + fit[5]! * s.y + fit[6]! + fit[7]! * s.x * s.y,
        }
      : s;
    return { markerId, dx: dst[i]!.x - predicted.x, dy: dst[i]!.y - predicted.y };
  });
  const mags = perMarker.map((r) => Math.hypot(r.dx, r.dy));
  return {
    pointCount: src.length,
    dof: 8,
    warpMagnitude,
    solved: {
      transform: {
        frameId: frame.frameId,
        tx: fit?.[2] ?? 0,
        ty: fit?.[6] ?? 0,
        rotRad: 0,
        included: true,
        excludedReason: null,
      },
      residual: {
        frameId: frame.frameId,
        included: true,
        rms: Math.sqrt(mags.reduce((s, m) => s + m * m, 0) / mags.length),
        max: Math.max(...mags),
        perMarker,
      },
    },
  };
}

function scoreFrom(residuals: FrameResidual[]): CandidateScore {
  const included = residuals.filter((r) => r.included && r.perMarker.length > 0);
  const allSq = included.flatMap((r) => r.perMarker.map((m) => m.dx * m.dx + m.dy * m.dy));
  const rms = allSq.length ? Math.sqrt(allSq.reduce((s, v) => s + v, 0) / allSq.length) : 0;
  const max = included.length ? Math.max(...included.map((r) => r.max)) : 0;
  return { rms, max, weightedRms: rms };
}

export interface BuiltCandidate {
  candidate: RegistrationCandidate;
  axis: TiltAxisEstimate;
}

/**
 * 构造一个配准候选。不同候选的可比性由 effectivePointSetFingerprint 强制保证：
 * 排除坏帧的候选若被直接拿来与全帧候选比绝对残差，必须给出 point-set-mismatch 诊断。
 */
export function buildCandidate(opts: CandidateOptions): BuiltCandidate {
  const diagnostics: Diagnostic[] = [];
  const included = new Set<StableId>();
  for (const frame of opts.frames) {
    if (opts.modelKind === 'rigid-exclusion' && frame.excluded) continue;
    included.add(frame.frameId);
  }

  const axis = estimateAxis(opts.frames, opts.observations, included, opts.forcedAxis);
  if (axis.assumedCenter) {
    diagnostics.push({
      code: 'axis-assumed-center',
      severity: 'warning',
      message: '倾转轴被默认固定在图像中心；fiducial 数据支持的轴线存在偏心',
      affectedIds: [axis.id],
    });
  } else if (opts.forcedAxis) {
    diagnostics.push({
      code: 'axis-offset',
      severity: 'info',
      message: '使用偏心轴线，而非图像中心默认值',
      affectedIds: [axis.id],
    });
  }
  if (axisHasAmbiguity(opts.frames, included)) {
    diagnostics.push({
      code: 'multi-solution',
      severity: 'warning',
      message: '倾角范围近似对称：轴线角存在相差 180° 的两个合法解，无法唯一决定',
      affectedIds: opts.frames.map((f) => f.frameId),
    });
  }

  const missingHighTilt = detectMissingHighTilt(opts.frames);
  for (const miss of missingHighTilt) {
    diagnostics.push({
      code: 'missing-high-tilt-frame',
      severity: 'warning',
      message: `高倾角区间缺失帧：期望倾角 ${miss.expectedDeg}° 附近无原始帧`,
      affectedIds: miss.neighborFrameIds,
    });
  }

  const ref = referencePositions(opts.frames, opts.observations, included);
  let solved: SolvedFrame[];
  let dof = 3 * included.size;
  if (opts.modelKind === 'local-warp') {
    solved = [];
    dof = 0;
    for (const frame of opts.frames) {
      if (!included.has(frame.frameId)) {
        const empty = solveRigidFrames([frame], opts.observations, new Set(), ref)[0]!;
        solved.push(empty);
        continue;
      }
      const warp = solveLocalWarp(frame, opts.observations, ref);
      if (warp) {
        solved.push(warp.solved);
        dof += warp.dof;
        const rigid = solveRigidFrames([frame], opts.observations, included, ref)[0]!;
        const improvement = rigid.residual.rms - warp.solved.residual.rms;
        if (
          warp.pointCount <= 8 ||
          (warp.warpMagnitude > 1.5 && improvement < 0.15 * rigid.residual.rms)
        ) {
          diagnostics.push({
            code: 'local-warp-overfit',
            severity: 'warning',
            message: `帧 ${frame.index} 上局部形变自由度相对有效点过多（${warp.pointCount} 点 / ${warp.dof} 自由度），残差改善不足以支持形变`,
            affectedIds: [frame.frameId],
          });
        }
      } else {
        const rigid = solveRigidFrames([frame], opts.observations, included, ref)[0]!;
        solved.push(rigid);
        dof += 3;
      }
    }
  } else {
    solved = solveRigidFrames(opts.frames, opts.observations, included, ref);
  }

  if (opts.modelKind === 'rigid-exclusion') {
    for (const frame of opts.frames.filter((f) => f.excluded)) {
      if (!frame.exclusionReason || frame.exclusionReason.trim() === '') {
        diagnostics.push({
          code: 'unjustified-frame-exclusion',
          severity: 'error',
          message: `帧 ${frame.index} 被排除但缺少手工排除原因，不能以“少帧”换取低残差`,
          affectedIds: [frame.frameId],
        });
      } else {
        diagnostics.push({
          code: 'bad-frame-excluded',
          severity: 'info',
          message: `帧 ${frame.index} 按手工原因排除：${frame.exclusionReason}`,
          affectedIds: [frame.frameId],
        });
      }
    }
  }

  const { fp, markers } = pointSetFingerprint(opts.frames, opts.observations, included);
  const residualList = solved.map((s) => s.residual);
  const score = scoreFrom(residualList);

  const candidate: RegistrationCandidate = {
    id: opts.id,
    branchId: opts.branchId,
    modelKind: opts.modelKind,
    label: opts.label,
    axisId: axis.id,
    transforms: solved.map((s) => s.transform),
    effectiveFrameIds: [...included],
    effectiveMarkerSet: markers,
    effectivePointSetFingerprint: fp,
    frameResiduals: residualList,
    score,
    degreeOfFreedom: dof,
    diagnostics,
    basedOnParameterVersion: opts.parameterVersion,
    basedOnSourceVersion: opts.sourceVersion,
  };
  return { candidate, axis };
}

export interface MissingHighTilt {
  expectedDeg: number;
  neighborFrameIds: StableId[];
}

export function detectMissingHighTilt(frames: FrameInfo[], stepDeg = 3): MissingHighTilt[] {
  const present = [...frames].sort((a, b) => a.tiltDeg - b.tiltDeg);
  const result: MissingHighTilt[] = [];
  for (let i = 0; i < present.length - 1; i++) {
    const a = present[i]!;
    const b = present[i + 1]!;
    const gap = b.tiltDeg - a.tiltDeg;
    if (gap > stepDeg * 1.8 && Math.abs(a.tiltDeg) > 40) {
      result.push({ expectedDeg: Math.round((a.tiltDeg + b.tiltDeg) / 2), neighborFrameIds: [a.frameId, b.frameId] });
    }
  }
  return result;
}

/**
 * 候选差分。点集不同时只报告共享点子集上的差异并显式标注，
 * 避免跨不同有效点集直接比较绝对分数。
 */
export function diffCandidates(
  from: RegistrationCandidate,
  to: RegistrationCandidate,
  id: StableId,
): CandidateDifference {
  const shared = from.effectivePointSetFingerprint === to.effectivePointSetFingerprint;
  const commonFrames = from.effectiveFrameIds.filter((f) => to.effectiveFrameIds.includes(f));
  const perFrameDeltaRms = commonFrames.map((frameId) => {
    const r1 = from.frameResiduals.find((r) => r.frameId === frameId)!;
    const r2 = to.frameResiduals.find((r) => r.frameId === frameId)!;
    return { frameId, delta: r2.rms - r1.rms };
  });
  const avgDelta = perFrameDeltaRms.length
    ? perFrameDeltaRms.reduce((s, d) => s + d.delta, 0) / perFrameDeltaRms.length
    : 0;
  return {
    id,
    fromCandidateId: from.id,
    toCandidateId: to.id,
    sharedPointSet: shared,
    perFrameDeltaRms,
    rmsDelta: avgDelta,
    note: shared
      ? '相同有效点集：可直接比较'
      : `有效点集不同（排除帧数差异）；仅对 ${commonFrames.length} 个共享帧比较，禁止用少帧换低残差`,
  };
}

/** 刚体拟合残差，用于外部模块/测试直接调用。 */
export function rigidResidual(
  src: Point[],
  dst: Point[],
): { rms: number; max: number; perMarker: MarkerResidual[] } | null {
  const fit = rigidProcrustes(src, dst);
  if (!fit) return null;
  const perMarker = src.map((s, i) => {
    const p = applyRigid(s, fit);
    return { markerId: `${i}`, dx: dst[i]!.x - p.x, dy: dst[i]!.y - p.y };
  });
  const mags = perMarker.map((m) => Math.hypot(m.dx, m.dy));
  return {
    rms: Math.sqrt(mags.reduce((s, m) => s + m * m, 0) / mags.length),
    max: Math.max(...mags),
    perMarker,
  };
}
