import type {
  AlignmentParams, Candidate, Diagnostic, FrameResidual,
  MarkerCoordsPayload, RawFramesPayload, Scheme, TrackingGapsPayload,
} from '../shared/domain.ts';
import { RULES } from '../shared/domain.ts';

// 确定性的配准残差计算。
// 领域规则在这里落地：
//  - 倾转轴不默认固定在图像中心：轴心来自 AlignmentParams，显式记录偏移量。
//  - fiducial 轨迹可断裂、可身份交换：断点/突跳只产生诊断，不做不可逆清洗。
//  - 不同候选用相同有效点集比较：有效点集由解释层一次性给出。
//  - 不用少帧换低残差：比较残差始终在共享帧集上计算。

export interface AlignInput {
  candidateId: string;
  interpretationId: string;
  scheme: Scheme;
  params: AlignmentParams;
  frames: RawFramesPayload['frames'];          // 已按倾角排序
  markers: MarkerCoordsPayload;
  gaps: TrackingGapsPayload['gaps'];
  excludedFrames: string[];                    // 手工排除（来自 exclusion_reasons）
  pixelScaleNmPerPx: number | null;            // null = 单位不可转换
  detector: { widthPx: number; heightPx: number };
  extraDiagnostics: Diagnostic[];
}

interface Pt { x: number; y: number; }

function rotateAround(p: Pt, center: Pt, angleRad: number, scale: number): Pt {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  const dx = p.x - center.x, dy = p.y - center.y;
  return { x: center.x + scale * (c * dx - s * dy), y: center.y + scale * (s * dx + c * dy) };
}

// 每帧最小二乘相似变换（局部形变方案用）
function fitSimilarity(pred: Pt[], obs: Pt[]): { scale: number; rot: number } {
  const n = pred.length;
  let pcx = 0, pcy = 0, ocx = 0, ocy = 0;
  for (let i = 0; i < n; i++) { pcx += pred[i].x; pcy += pred[i].y; ocx += obs[i].x; ocy += obs[i].y; }
  pcx /= n; pcy /= n; ocx /= n; ocy /= n;
  let a = 0, b = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    const px = pred[i].x - pcx, py = pred[i].y - pcy;
    const ox = obs[i].x - ocx, oy = obs[i].y - ocy;
    a += px * ox + py * oy;
    b += px * oy - py * ox;
    norm += px * px + py * py;
  }
  const rot = Math.atan2(b, a);
  const scale = norm > 0 ? Math.hypot(a, b) / norm : 1;
  return { scale, rot };
}

export function computeCandidate(input: AlignInput): Candidate {
  const diagnostics: Diagnostic[] = [...input.extraDiagnostics];
  const frameIds = input.frames.map(f => f.frameId);
  const tiltOf = new Map(input.frames.map(f => [f.frameId, f.tiltDeg]));
  const center: Pt = { x: input.detector.widthPx / 2, y: input.detector.heightPx / 2 };
  const axis: Pt = {
    x: center.x + input.params.axisOffsetXPx,
    y: center.y + input.params.axisOffsetYPx,
  };

  // 规则证据：轴线偏心量显式记录（绝不默认固定在图像中心）
  diagnostics.push({
    code: 'axis_offset_from_center_px',
    message: `倾转轴相对图像中心偏移 (${input.params.axisOffsetXPx.toFixed(2)}, ${input.params.axisOffsetYPx.toFixed(2)}) px；规则 ${RULES.AXIS_NOT_CENTERED}`,
    severity: 'info',
  });

  // 有效点集：在解释层帧清单的每一帧都有观测的轨迹（断裂轨迹保留在原数据中，仅不进有效集）
  const tracked = input.markers.trajectories.filter(t => {
    const have = new Set(t.points.map(p => p.frameId));
    return frameIds.every(f => have.has(f));
  });
  const effectivePointSet = tracked.map(t => t.trajectoryId).sort();

  for (const g of input.gaps) {
    diagnostics.push({
      code: 'trajectory_break',
      message: `轨迹 ${g.trajectoryId} 在 ${g.fromFrame}..${g.toFrame} 断裂（${g.cause}）；断裂不被清洗，规则 ${RULES.TRAJECTORY_BREAK_SWAP}`,
      at: g.trajectoryId,
      severity: 'info',
    });
  }

  // 身份交换检测：相邻帧位移突跳（只做诊断，不改数据）
  for (const t of input.markers.trajectories) {
    const sorted = [...t.points].sort((a, b) => (tiltOf.get(a.frameId) ?? 0) - (tiltOf.get(b.frameId) ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      const jump = Math.hypot(sorted[i].xPx - sorted[i - 1].xPx, sorted[i].yPx - sorted[i - 1].yPx);
      if (jump > 120) {
        diagnostics.push({
          code: 'possible_identity_swap',
          message: `轨迹 ${t.trajectoryId} 在 ${sorted[i - 1].frameId}→${sorted[i].frameId} 位移突跳 ${jump.toFixed(1)} px，疑似身份交换`,
          at: `${t.trajectoryId}@${sorted[i].frameId}`,
          severity: 'warn',
        });
        break;
      }
    }
  }

  // 高倾角覆盖检查
  const maxAbsTilt = Math.max(...input.frames.map(f => Math.abs(f.tiltDeg)));
  if (maxAbsTilt < 55) {
    diagnostics.push({
      code: 'missing_high_tilt_frames',
      message: `最高倾角仅 ${maxAbsTilt.toFixed(1)}°，高倾角帧缺失会影响深度方向分辨`,
      severity: 'warn',
    });
  }

  // 参考位置：每条有效轨迹的均值
  const refOf = new Map<string, Pt>();
  for (const t of tracked) {
    const n = t.points.length;
    refOf.set(t.trajectoryId, {
      x: t.points.reduce((s, p) => s + p.xPx, 0) / n,
      y: t.points.reduce((s, p) => s + p.yPx, 0) / n,
    });
  }
  const meanTilt = input.frames.reduce((s, f) => s + f.tiltDeg, 0) / input.frames.length;

  const excluded = new Set(input.scheme === 'exclude_bad_frames' ? input.excludedFrames : []);
  const framesUsed = frameIds.filter(f => !excluded.has(f));

  // 预测与观测
  const observed = new Map<string, Map<string, Pt>>(); // traj -> frame -> pt
  for (const t of tracked) {
    observed.set(t.trajectoryId, new Map(t.points.map(p => [p.frameId, { x: p.xPx, y: p.yPx }])));
  }
  const predict = (trajId: string, frameId: string, local: { scale: number; rot: number } | null): Pt => {
    const ref = refOf.get(trajId)!;
    const tilt = tiltOf.get(frameId) ?? 0;
    const base = rotateAround(ref, axis, -((tilt - meanTilt) * Math.PI / 180), input.params.magnification);
    if (!local) return base;
    return rotateAround(base, center, local.rot, local.scale);
  };

  // 局部形变：每帧拟合一个相似变换（自由度大增 → 过拟合风险）
  const localFits = new Map<string, { scale: number; rot: number }>();
  if (input.scheme === 'local_deform') {
    for (const f of framesUsed) {
      const pred: Pt[] = [], obs: Pt[] = [];
      for (const t of tracked) {
        const o = observed.get(t.trajectoryId)!.get(f);
        if (o) { pred.push(predict(t.trajectoryId, f, null)); obs.push(o); }
      }
      if (pred.length >= 3) localFits.set(f, fitSimilarity(pred, obs));
    }
  }

  const scale = input.pixelScaleNmPerPx;
  const perFrameResiduals: FrameResidual[] = [];
  for (const f of frameIds) {
    let sumSq = 0, n = 0;
    const local = localFits.get(f) ?? null;
    for (const t of tracked) {
      const o = observed.get(t.trajectoryId)!.get(f);
      if (!o) continue;
      const p = predict(t.trajectoryId, f, local);
      const d = Math.hypot(o.x - p.x, o.y - p.y); // px
      sumSq += d * d; n++;
    }
    const rmsePx = n > 0 ? Math.sqrt(sumSq / n) : 0;
    perFrameResiduals.push({
      frameId: f,
      rmseNm: scale != null ? rmsePx * scale : rmsePx, // 单位不可转换时保留 px 量级并已有诊断
      used: !excluded.has(f),
    });
  }

  // 比较残差：永远在共享帧集（全部帧）上计算 —— 少帧不能换低残差
  const compared = perFrameResiduals; // 不排除任何帧
  const comparisonRmseNm = compared.reduce((s, r) => s + r.rmseNm, 0) / Math.max(1, compared.length);

  if (input.scheme === 'exclude_bad_frames' && input.excludedFrames.length > 0) {
    diagnostics.push({
      code: 'fewer_frames_no_residual_advantage',
      message: `排除 ${input.excludedFrames.length} 帧参与拟合，但比较残差仍在全部 ${frameIds.length} 帧上计算；规则 ${RULES.NO_FEWER_FRAMES_FOR_RESIDUAL}`,
      severity: 'info',
    });
  }

  const dof = input.scheme === 'local_deform'
    ? 4 + 4 * framesUsed.length
    : 4;
  if (input.scheme === 'local_deform') {
    const rigidLike = perFrameResiduals.reduce((s, r) => s + r.rmseNm, 0);
    const obsCount = tracked.length * framesUsed.length;
    if (dof > obsCount / 2 || framesUsed.length < 8) {
      diagnostics.push({
        code: 'local_deform_overfit',
        message: `局部形变自由度 ${dof} 相对观测 ${obsCount} 过高，存在过拟合风险`,
        severity: 'warn',
      });
    }
    void rigidLike;
  }

  return {
    id: input.candidateId,
    interpretationId: input.interpretationId,
    scheme: input.scheme,
    effectivePointSet,
    framesUsed,
    perFrameResiduals,
    comparisonRmseNm,
    dof,
    diagnostics,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
}
