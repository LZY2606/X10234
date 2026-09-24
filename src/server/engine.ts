import { angleDiff, deg2rad, lstsq, rmse, toAxisBasis, type Vec2 } from './math';
import { projectFiducial } from './generator';
import type { CaseSpec, TrackSpec } from './case-types';
import type { DiagnosisCode, PerFrameResidual, PointXY, TiltAxisModel } from '../shared/model';

export interface Observation {
  frameId: string;
  trackId: string;
  point: PointXY;
  tiltDeg: number;
  excluded: boolean;
  missing: boolean;
  bad: boolean;
}

export function observationsFromCase(spec: CaseSpec): Observation[] {
  const obs: Observation[] = [];
  for (const frame of spec.frames) {
    for (const tr of spec.tracks) {
      if (!frame.presentTracks.includes(tr.trackId)) continue;
      let actual: TrackSpec = tr;
      if (tr.swapAfterFrame && frame.frameId > tr.swapAfterFrame) {
        const other =
          spec.tracks.find((t) => t.trackId === tr.swapTargetId) ?? spec.tracks.find((t) => t !== tr);
        if (other) actual = other;
      }
      const driftU = Math.sin(frame.index * 1.7) * 0.35;
      const driftN =
        Math.cos(frame.index * 1.1) * 0.3 + (frame.bad ? spec.geometry.badShiftPx : 0) + (frame.rippleN ?? 0);
      const point = projectFiducial({
        tiltDeg: frame.tiltDeg,
        u0: actual.u0,
        z: actual.z,
        axisAngleDeg: spec.geometry.axisAngleDeg,
        axisOffsetPx: spec.geometry.axisOffsetPx,
        center: spec.geometry.imageCenter,
        driftU,
        driftN,
      });
      obs.push({
        frameId: frame.frameId,
        trackId: tr.trackId,
        point,
        tiltDeg: frame.tiltDeg,
        excluded: !!frame.excluded,
        missing: !!frame.missing,
        bad: !!frame.bad,
      });
    }
  }
  return obs;
}

export interface EngineParams {
  rulesVersion: string;
  center: Vec2;
  localWarp: boolean;
  useManualExclusions: boolean;
  highTiltDeg: number;
  overfitHoldoutRatio: number;
  offCenterTolPx: number;
}

export const DEFAULT_PARAMS: EngineParams = {
  rulesVersion: 'rules@v1',
  center: { x: 23.5, y: 23.5 },
  localWarp: false,
  useManualExclusions: true,
  highTiltDeg: 50,
  overfitHoldoutRatio: 0.2,
  offCenterTolPx: 1.0,
};

export function frameIndex(frameId: string): number {
  const m = frameId.match(/f(\d+)$/);
  return m ? Number(m[1]) : 0;
}

interface AngleFit {
  angle: number;
  rmse: number;
  d: number;
  zByTrack: Record<string, number>;
  driftByTrack: Record<string, number>;
  drift2ByTrack: Record<string, number>;
}

// 固定轴角，对法向分量做线性拟合：
//   刚体：    n_{k,t} = z_k*sin(t) + d + b*index
//   局部形变：n_{k,t} = z_k*sin(t) + d + b_k*index + c_k*index^2（每轨迹两个漂移自由度）
function evaluateAngle(
  set: Observation[],
  angle: number,
  center: Vec2,
  localWarp: boolean
): AngleFit {
  const tracks = [...new Set(set.map((o) => o.trackId))];
  const idx = new Map(tracks.map((t, i) => [t, i]));
  // 列：z_0..z_{K-1}, d, 刚体 b；局部 b_0..b_K, c_0..c_K
  const cols = tracks.length + 1 + (localWarp ? 2 * tracks.length : 1);
  const A: number[][] = [];
  const b: number[] = [];
  for (const o of set) {
    const { n } = toAxisBasis(o.point, angle, center);
    const row = new Array<number>(cols).fill(0);
    row[idx.get(o.trackId)!] = Math.sin(deg2rad(o.tiltDeg));
    row[tracks.length] = 1;
    const fi = frameIndex(o.frameId);
    if (localWarp) {
      row[tracks.length + 1 + idx.get(o.trackId)!] = fi;
      row[tracks.length + 1 + tracks.length + idx.get(o.trackId)!] = fi * fi;
    } else {
      row[tracks.length + 1] = fi;
    }
    A.push(row);
    b.push(n);
  }
  const { x, resid } = lstsq(A, b);
  const zByTrack: Record<string, number> = {};
  const driftByTrack: Record<string, number> = {};
  const drift2ByTrack: Record<string, number> = {};
  tracks.forEach((t, k) => {
    zByTrack[t] = x[k];
    driftByTrack[t] = localWarp ? x[tracks.length + 1 + k] : x[tracks.length + 1];
    drift2ByTrack[t] = localWarp ? x[tracks.length + 1 + tracks.length + k] : 0;
  });
  return { angle, rmse: resid, d: x[tracks.length], zByTrack, driftByTrack, drift2ByTrack };
}

function searchAxis(
  set: Observation[],
  center: Vec2,
  localWarp: boolean
): { best: AngleFit; curve: AngleFit[]; altMinima: AngleFit[] } {
  const coarse: AngleFit[] = [];
  for (let a = -89; a <= 90; a += 2) coarse.push(evaluateAngle(set, a, center, localWarp));
  let best = coarse[0];
  for (const c of coarse) if (c.rmse < best.rmse) best = c;
  for (let a = best.angle - 2; a <= best.angle + 2; a += 0.1) {
    const f = evaluateAngle(set, a, center, localWarp);
    if (f.rmse < best.rmse) best = f;
  }
  // 可选多解：远离主极小的近等极小（缺失高倾角时曲率变平，常出现）。
  const altMinima = coarse.filter((c) => {
    if (Math.abs(angleDiff(c.angle, best.angle)) < 25) return false;
    return c.rmse <= best.rmse + 0.15 && c.rmse < 1.6;
  });
  return { best, curve: coarse, altMinima };
}

function predictN(o: Observation, fit: AngleFit): number {
  const fi = frameIndex(o.frameId);
  return (
    fit.zByTrack[o.trackId] * Math.sin(deg2rad(o.tiltDeg)) +
    fit.d +
    fit.driftByTrack[o.trackId] * fi +
    fit.drift2ByTrack[o.trackId] * fi * fi
  );
}

export interface FitResult {
  axis: TiltAxisModel;
  rmsePx: number;
  holdoutRmsePx?: number;
  perFrame: PerFrameResidual[];
  transforms: Record<string, { tx: number; ty: number }>;
  effectiveFrameIds: string[];
  dof: number;
  altAngles: number[];
  diagnoses: DiagnosisCode[];
}

function buildFit(args: {
  obs: Observation[];
  params: EngineParams;
  localWarp: boolean;
  droppedFrameIds?: string[];
}): FitResult {
  const { params } = args;
  // 有效点集：缺失帧无点；坏帧按参数决定是否纳入；手工排除帧剔除。
  const dropped = new Set(args.droppedFrameIds ?? []);
  const usable = args.obs.filter(
    (o) => !o.missing && !(params.useManualExclusions && o.excluded) && !dropped.has(o.frameId)
  );
  // 训练 / 留一（过拟合检验）
  const allFrames = [...new Set(usable.map((o) => o.frameId))];
  const holdoutCount = Math.max(1, Math.round(allFrames.length * params.overfitHoldoutRatio));
  const holdout = new Set(allFrames.filter((_, i) => i % Math.max(2, Math.round(1 / params.overfitHoldoutRatio)) === 0).slice(0, holdoutCount));
  const train = usable.filter((o) => !holdout.has(o.frameId));
  const { best, altMinima } = searchAxis(train, params.center, args.localWarp);

  const residualFor = (o: Observation) => {
    const { n } = toAxisBasis(o.point, best.angle, params.center);
    return n - predictN(o, best);
  };
  const perFrame: PerFrameResidual[] = allFrames.map((fid) => {
    const fobs = usable.filter((o) => o.frameId === fid);
    return {
      frameId: fid,
      rmsePx: rmse(fobs.map(residualFor)),
      nPoints: fobs.length,
      excluded: fobs.some((o) => o.excluded) || dropped.has(fid),
    };
  });
  const trainRmse = rmse(train.map(residualFor));
  const hobs = usable.filter((o) => holdout.has(o.frameId));
  const holdoutRmse = hobs.length ? rmse(hobs.map(residualFor)) : undefined;

  const diagnoses: DiagnosisCode[] = [];
  if (Math.abs(best.d) > params.offCenterTolPx) diagnoses.push('AXIS_OFF_CENTER');
  if (altMinima.length) diagnoses.push('NON_UNIQUE_SOLUTION');

  // 缺失高倾角帧
  const presentTilts = [...new Set(usable.map((o) => o.tiltDeg))];
  const highExpected = [-60, 60, -50, 50];
  const missingHigh = highExpected.filter((t) => !presentTilts.some((x) => Math.abs(x - t) < 1));
  if (missingHigh.length) diagnoses.push('MISSING_HIGH_TILT_FRAMES');

  // 坏帧：未剔除时帧残差显著偏大
  const badFrames = [...new Set(args.obs.filter((o) => o.bad).map((o) => o.frameId))];
  if (badFrames.some((f) => allFrames.includes(f))) {
    const pf = perFrame.find((p) => p.frameId === badFrames[0]);
    const others = perFrame.filter((p) => p.frameId !== badFrames[0]).map((p) => p.rmsePx);
    if (pf && others.length && pf.rmsePx > rmse(others) * 2.2) diagnoses.push('BAD_FRAME_EXCLUDED');
  }

  // 轨迹身份交换：交换后同一 track 的残差呈跳变（前段/后段均值差大）。
  const tracks = [...new Set(usable.map((o) => o.trackId))];
  for (const t of tracks) {
    const tobs = usable.filter((o) => o.trackId === t).sort((a, b) => frameIndex(a.frameId) - frameIndex(b.frameId));
    if (tobs.length >= 5) {
      const half = Math.floor(tobs.length / 2);
      const r1 = tobs.slice(0, half).map(residualFor);
      const r2 = tobs.slice(half).map(residualFor);
      if (Math.abs(rmse(r1) - rmse(r2)) > 1.6 || (rmse(r2) > 1.4 && rmse(r1) < 0.8)) {
        diagnoses.push('TRACK_IDENTITY_SWAP_SUSPECTED');
        break;
      }
    }
  }

  const axis: TiltAxisModel = {
    axisAngleDeg: Math.round(best.angle * 100) / 100,
    offsetPx: Math.round(best.d * 1000) / 1000,
    centerRef: 'image_origin_top_left@frame0',
    fixedAtCenter: false,
  };

  return {
    axis,
    rmsePx: Math.round(trainRmse * 1000) / 1000,
    holdoutRmsePx: holdoutRmse === undefined ? undefined : Math.round(holdoutRmse * 1000) / 1000,
    perFrame,
    transforms: Object.fromEntries(allFrames.map((f) => [f, { tx: 0, ty: 0 }])),
    effectiveFrameIds: allFrames,
    dof: tracks.length + 1 + (args.localWarp ? 2 * tracks.length : 1),
    altAngles: altMinima.map((m) => m.angle),
    diagnoses: [...new Set(diagnoses)],
  };
}

export function fitRigidCandidate(obs: Observation[], params: EngineParams): FitResult {
  return buildFit({ obs, params, localWarp: false });
}

export function fitLocalWarpCandidate(obs: Observation[], params: EngineParams): FitResult {
  const fit = buildFit({ obs, params, localWarp: true });
  // 局部形变过拟合：训练残差更低，但留一残差显著更差。
  if (fit.holdoutRmsePx !== undefined && fit.holdoutRmsePx > fit.rmsePx * 1.5 + 0.15) {
    fit.diagnoses = [...new Set([...fit.diagnoses, 'LOCAL_WARP_OVERFIT'])];
  }
  return fit;
}

// “排除坏帧”候选：只能基于手工排除原因剔除，不能为降残差自行丢帧。
export function fitExcludedFramesCandidate(
  obs: Observation[],
  params: EngineParams,
  manualExcludedFrameIds: string[]
): FitResult {
  return buildFit({ obs, params, localWarp: false, droppedFrameIds: manualExcludedFrameIds });
}
