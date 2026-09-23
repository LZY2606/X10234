// 推导规则（ruleset）：
//  R1 倾转轴不能被默认固定在图像中心 —— 轴线 offset/angle 是自由参数
//  R2 fiducial 轨迹可断裂且可能身份交换 —— 派生层拼接 tracklet，原始数据不动
//  R3 不同候选用相同有效点集比较，不用少帧换低残差
import { normalizeQuantity, hashContent } from '../shared/units.js';
import type { FiducialTrackSet, TiltSeriesSource, ManualExclusionSet, AlignmentCandidate, AlignmentParams, Diagnostic } from '../shared/types.js';

export interface NormPoint { trackletId: string; frameIndex: number; tiltDeg: number; x: number; y: number }

export interface NormalizedSeries {
  pixelSizeNmPx?: number;
  frames: { frameIndex: number; tiltDeg: number; dose?: number }[];
  diagnostics: Diagnostic[];
}

/** 派生层规范化：无法转换的值留在原位置并附诊断 */
export function normalizeTiltSeries(src: TiltSeriesSource): NormalizedSeries {
  const diagnostics: Diagnostic[] = [];
  const px = normalizeQuantity(src.pixelSize, 'pixelSize');
  if (px.diagnostic) diagnostics.push(px.diagnostic);
  const frames = src.frames.map((f) => {
    const tilt = normalizeQuantity(f.tiltAngle, `frames[${f.frameIndex}].tiltAngle`);
    if (tilt.diagnostic) diagnostics.push(tilt.diagnostic);
    const dose = normalizeQuantity(f.exposureDose, `frames[${f.frameIndex}].exposureDose`);
    if (dose.diagnostic) diagnostics.push(dose.diagnostic);
    return { frameIndex: f.frameIndex, tiltDeg: tilt.qty?.value ?? NaN, dose: dose.qty?.value };
  });
  return { pixelSizeNmPx: px.qty?.value, frames, diagnostics };
}

/** 有效点集：轨迹观测 − 手工排除帧 − 缺失帧；候选比较的唯一基准 */
export function buildEffectivePointSet(
  tracks: FiducialTrackSet,
  exclusions: ManualExclusionSet,
  series: NormalizedSeries,
): { points: NormPoint[]; hash: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const excluded = new Set(exclusions.exclusions.map((e) => e.frameIndex));
  const tiltByFrame = new Map(series.frames.map((f) => [f.frameIndex, f.tiltDeg]));
  const points: NormPoint[] = [];
  for (const t of tracks.tracklets) {
    for (const p of t.points) {
      if (excluded.has(p.frameIndex)) continue;
      const xq = normalizeQuantity(p.x, `tracklet ${t.trackletId} frame ${p.frameIndex}.x`);
      const yq = normalizeQuantity(p.y, `tracklet ${t.trackletId} frame ${p.frameIndex}.y`);
      if (xq.diagnostic) diagnostics.push(xq.diagnostic);
      if (yq.diagnostic) diagnostics.push(yq.diagnostic);
      if (!xq.qty || !yq.qty) continue; // 值留在原位置，不进入派生点集
      const tiltDeg = tiltByFrame.get(p.frameIndex);
      if (tiltDeg === undefined || Number.isNaN(tiltDeg)) continue;
      points.push({ trackletId: t.trackletId, frameIndex: p.frameIndex, tiltDeg, x: xq.qty.value, y: yq.qty.value });
    }
  }
  const keys = points.map((p) => `${p.trackletId}@${p.frameIndex}`).sort();
  return { points, hash: hashContent(keys.join('|')), diagnostics };
}

/** 3 参数线性最小二乘：p(t) = c0 + c1·cos t + c2·sin t */
function fitHarmonic(samples: { t: number; v: number }[]): [number, number, number] {
  let s00 = 0, s01 = 0, s02 = 0, s11 = 0, s12 = 0, s22 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (const { t, v } of samples) {
    const r = (t * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    s00 += 1; s01 += c; s02 += s; s11 += c * c; s12 += c * s; s22 += s * s;
    b0 += v; b1 += c * v; b2 += s * v;
  }
  // 解 3x3 正规方程（高斯消元）
  const A = [[s00, s01, s02, b0], [s01, s11, s12, b1], [s02, s12, s22, b2]];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r2 = col + 1; r2 < 3; r2++) if (Math.abs(A[r2][col]) > Math.abs(A[piv][col])) piv = r2;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col] || 1e-12;
    for (let r2 = 0; r2 < 3; r2++) {
      if (r2 === col) continue;
      const f = A[r2][col] / d;
      for (let c2 = col; c2 < 4; c2++) A[r2][c2] -= f * A[col][c2];
    }
  }
  return [A[0][3] / (A[0][0] || 1e-12), A[1][3] / (A[1][1] || 1e-12), A[2][3] / (A[2][2] || 1e-12)];
}

export interface AxisEstimate { angleDeg: number; offsetPx: number; fixedToImageCenter: false }

/** R1：从轨迹拟合倾转轴（角度 + 偏心距均为自由参数） */
export function fitTiltAxis(points: NormPoint[], imageCenter: [number, number]): { axis: AxisEstimate; perPoint: Map<string, { fx: number; fy: number }> } {
  const byTrack = new Map<string, NormPoint[]>();
  for (const p of points) {
    if (!byTrack.has(p.trackletId)) byTrack.set(p.trackletId, []);
    byTrack.get(p.trackletId)!.push(p);
  }
  let cxSum = 0, cySum = 0, n = 0, tanSum = 0, tanN = 0;
  const perPoint = new Map<string, { fx: number; fy: number }>();
  for (const [tid, pts] of byTrack) {
    const xs = pts.map((p) => ({ t: p.tiltDeg, v: p.x }));
    const ys = pts.map((p) => ({ t: p.tiltDeg, v: p.y }));
    const [cx, ax, bx] = fitHarmonic(xs);
    const [cy, ay, by] = fitHarmonic(ys);
    cxSum += cx; cySum += cy; n++;
    if (Math.abs(ax) > 1e-6) { tanSum += ay / ax; tanN++; }
    for (const p of pts) {
      const r = (p.tiltDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      perPoint.set(`${tid}@${p.frameIndex}`, { fx: cx + ax * c + bx * s, fy: cy + ay * c + by * s });
    }
  }
  const angleDeg = tanN ? (Math.atan(tanSum / tanN) * 180) / Math.PI : 0;
  return {
    axis: { angleDeg, offsetPx: cxSum / n - imageCenter[0], fixedToImageCenter: false },
    perPoint,
  };
}

export interface FitResult {
  candidate: Omit<AlignmentCandidate, 'candidateId'>;
  diagnostics: Diagnostic[];
  axis: AxisEstimate;
}

/** 生成一个配准候选（刚体 / 局部形变 / 排除坏帧），残差基于真实拟合 */
export function fitCandidate(
  model: AlignmentParams['model'],
  points: NormPoint[],
  pointSetHash: string,
  imageCenter: [number, number],
  opts: { axisOverride?: { angleDeg: number; offsetPx: number }; controlPointSpacingPx?: number; forceAxisToCenter?: boolean } = {},
): FitResult {
  const diagnostics: Diagnostic[] = [];
  const { axis, perPoint } = fitTiltAxis(points, imageCenter);
  const usedAxis = opts.forceAxisToCenter
    ? { angleDeg: 0, offsetPx: 0, fixedToImageCenter: false as const }
    : opts.axisOverride
      ? { ...opts.axisOverride, fixedToImageCenter: false as const }
      : axis;

  // 每帧残差
  const residualByFrame = new Map<number, number[]>();
  const perFrameShift = new Map<number, { dx: number; dy: number; n: number }>();
  for (const p of points) {
    const f = perPoint.get(`${p.trackletId}@${p.frameIndex}`)!;
    let rx = p.x - f.fx, ry = p.y - f.fy;
    if (opts.forceAxisToCenter) { rx -= axis.offsetPx; } // 强行居中引入系统性偏差
    if (!perFrameShift.has(p.frameIndex)) perFrameShift.set(p.frameIndex, { dx: 0, dy: 0, n: 0 });
    const acc = perFrameShift.get(p.frameIndex)!;
    acc.dx += rx; acc.dy += ry; acc.n++;
    if (!residualByFrame.has(p.frameIndex)) residualByFrame.set(p.frameIndex, []);
    residualByFrame.get(p.frameIndex)!.push(Math.hypot(rx, ry));
  }
  // 局部形变：每帧额外拟合一个平移（更多自由度）
  const useLocal = model === 'local-deformation';
  const perFrameResiduals = [...residualByFrame.entries()].map(([frameIndex, rs]) => ({ frameIndex, residualPx: 0 }));
  let sum = 0, cnt = 0;
  for (const p of points) {
    const f = perPoint.get(`${p.trackletId}@${p.frameIndex}`)!;
    let rx = p.x - f.fx, ry = p.y - f.fy;
    if (opts.forceAxisToCenter) rx -= axis.offsetPx;
    if (useLocal) {
      const sh = perFrameShift.get(p.frameIndex)!;
      rx -= sh.dx / sh.n; ry -= sh.dy / sh.n;
    }
    sum += Math.hypot(rx, ry); cnt++;
  }
  for (const r of perFrameResiduals) {
    const rs = residualByFrame.get(r.frameIndex)!;
    r.residualPx = rs.reduce((a, b) => a + b, 0) / rs.length;
  }
  const meanResidualPx = sum / cnt;

  // 过拟合判定：局部形变自由度相对点数过高
  if (useLocal) {
    const spacing = opts.controlPointSpacingPx ?? 24;
    const dof = 2 * perFrameShift.size;
    if (spacing < 12 || dof / cnt > 0.15) {
      diagnostics.push({ code: 'OVERFIT_LOCAL_DEFORMATION', message: `局部形变过拟合：控制点间距 ${spacing}px，自由度 ${dof} / 点数 ${cnt}` });
    }
  }
  if (opts.forceAxisToCenter) {
    diagnostics.push({ code: 'AXIS_FORCED_CENTER', message: '倾转轴被固定在图像中心，违反规则 R1；残差含系统性偏差' });
  }
  const tilts = [...new Set(points.map((p) => Math.abs(p.tiltDeg)))];
  if (Math.max(...tilts) < 55) {
    diagnostics.push({ code: 'MISSING_HIGH_TILT', message: `有效点集最高倾角仅 ${Math.max(...tilts)}°，缺失高倾角帧` });
  }
  return {
    candidate: {
      model,
      params: {
        tiltAxis: usedAxis,
        model,
        excludedFrames: [],
        ...(useLocal ? { localDeformation: { controlPointSpacingPx: opts.controlPointSpacingPx ?? 24 } } : {}),
      },
      effectivePointSetHash: pointSetHash,
      effectivePointCount: points.length,
      perFrameResiduals: perFrameResiduals.sort((a, b) => a.frameIndex - b.frameIndex),
      meanResidualPx,
    },
    diagnostics,
    axis,
  };
}

/** R3：候选比较必须在相同有效点集上；点集不同的候选保留但不得参与排名 */
export function compareCandidates(cands: AlignmentCandidate[]): { ranked: string[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const byHash = new Map<string, AlignmentCandidate[]>();
  for (const c of cands) {
    if (!byHash.has(c.effectivePointSetHash)) byHash.set(c.effectivePointSetHash, []);
    byHash.get(c.effectivePointSetHash)!.push(c);
  }
  const mainSet = [...byHash.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const ranked = mainSet[1].sort((a, b) => a.meanResidualPx - b.meanResidualPx).map((c) => c.candidateId);
  for (const [hash, group] of byHash) {
    if (hash === mainSet[0]) continue;
    for (const c of group) {
      diagnostics.push({
        code: 'POINT_SET_MISMATCH',
        message: `候选 ${c.candidateId} 有效点集(${c.effectivePointCount}点)与比较基准不同，不参与排名：不用少帧换低残差`,
      });
    }
  }
  return { ranked, diagnostics };
}

/** R2：轨迹断裂与身份交换 —— 派生层确认 swap hint，原始轨迹不动 */
export function confirmIdentitySwaps(tracks: FiducialTrackSet): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const hint of tracks.identitySwapHints) {
    const a = tracks.tracklets.find((t) => t.trackletId === hint.a);
    const b = tracks.tracklets.find((t) => t.trackletId === hint.b);
    if (!a || !b) continue;
    const lastA = a.points[a.points.length - 1];
    const firstB = b.points[0];
    if (lastA && firstB && firstB.frameIndex === hint.atFrame + 1) {
      const dx = parseFloat(lastA.x.raw) - parseFloat(firstB.x.raw);
      const dy = parseFloat(lastA.y.raw) - parseFloat(firstB.y.raw);
      if (Math.hypot(dx, dy) < 3) {
        diagnostics.push({
          code: 'TRACK_IDENTITY_SWAP_CONFIRMED',
          message: `${hint.a} 于 frame ${hint.atFrame} 结束、${hint.b} 于 frame ${firstB.frameIndex} 接续（位移 ${Math.hypot(dx, dy).toFixed(2)}px），判定为同一标记点的身份交换`,
        });
      }
    }
  }
  return diagnostics;
}
