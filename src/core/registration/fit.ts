import { backProject, projectPoint, type AxisParams, type FrameParams, type ProjectionContext, type SpecimenPoint } from '../geometry/model';

export interface FitObservation {
  observationId: string;
  frameId: string;
  trackId: string;
  tiltIndex: number;
  tiltDeg: number;
  xPx: number;
  yPx: number;
}

export interface FitFrame {
  frameId: string;
  tiltIndex: number;
  tiltDeg: number;
  ctx: ProjectionContext;
}

export interface FitResult {
  axis: AxisParams;
  frameParams: Map<string, FrameParams>;
  specimenPoints: Map<string, SpecimenPoint>; // 物理点身份 -> 样品坐标
  residualByObservation: Map<string, number>; // px
  rmsByFrame: Map<string, number>;
  rmsOverall: number;
  /** 高倾角缺失 / 倾角范围不足时，Z 与轴偏移方向病态。 */
  zConditioning: number;
}

export interface FitOptions {
  /** 轨迹身份映射：把 (trackId, tiltIndex) 归并到物理点身份，支持断裂与身份交换假设。 */
  physicalTrackOf?: (trackId: string, tiltIndex: number) => string;
  initialAxis?: Partial<AxisParams>;
  iterations?: number;
  /** 冻结轴偏移（用于构造多解中的另一合法候选）。 */
  freezePivot?: boolean;
}

/** 交替最小二乘：反投影样品点 ↔ 更新每帧平移、轴偏移、方位角。 */
export function fitAlignment(frames: FitFrame[], observations: FitObservation[], opts: FitOptions = {}): FitResult {
  const physicalOf = opts.physicalTrackOf ?? ((trackId: string) => trackId);
  const axis: AxisParams = {
    azimuthDeg: opts.initialAxis?.azimuthDeg ?? 0,
    pivotX: opts.initialAxis?.pivotX ?? 0,
    pivotY: opts.initialAxis?.pivotY ?? 0,
    scale: opts.initialAxis?.scale ?? 1,
  };
  const frameParams = new Map<string, FrameParams>();
  for (const f of frames) frameParams.set(f.frameId, { shiftX: 0, shiftY: 0 });

  const ctx = frames[0]?.ctx ?? { widthPx: 0, heightPx: 0, pixelSizeNm: 1 };
  const obsByPhysical = new Map<string, Array<{ obs: FitObservation; idx: number }>>();
  for (const o of observations) {
    const key = physicalOf(o.trackId, o.tiltIndex);
    const arr = obsByPhysical.get(key) ?? [];
    arr.push({ obs: o, idx: 0 });
    obsByPhysical.set(key, arr);
  }

  let specimen = new Map<string, SpecimenPoint>();
  const iterations = opts.iterations ?? 30;
  for (let iter = 0; iter < iterations; iter++) {
    specimen = new Map();
    for (const [key, list] of obsByPhysical) {
      const obs = list.map(({ obs: o }) => ({ tiltDeg: o.tiltDeg, xPx: o.xPx, yPx: o.yPx }));
      const fps = list.map(({ obs: o }) => frameParams.get(o.frameId)!);
      specimen.set(key, backProject(obs, axis, fps, ctx));
    }
    // 每帧平移更新
    const dx = new Map<string, number[]>();
    const dy = new Map<string, number[]>();
    for (const o of observations) {
      const p = specimen.get(physicalOf(o.trackId, o.tiltIndex))!;
      const f = frameParams.get(o.frameId)!;
      const fr = frames.find((fr) => fr.frameId === o.frameId)!;
      const proj = projectPoint(p, fr.tiltDeg, axis, f, ctx);
      (dx.get(o.frameId) ?? dx.set(o.frameId, []).get(o.frameId)!).push(o.xPx - proj.x);
      (dy.get(o.frameId) ?? dy.set(o.frameId, []).get(o.frameId)!).push(o.yPx - proj.y);
    }
    let meanDx = 0, meanDy = 0, n = 0;
    for (const f of frames) {
      const xs = dx.get(f.frameId) ?? [];
      const ys = dy.get(f.frameId) ?? [];
      if (!xs.length) continue;
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      const fp = frameParams.get(f.frameId)!;
      fp.shiftX += mx;
      fp.shiftY += my;
      meanDx += mx; meanDy += my; n++;
    }
    // 轴偏移吸收公共分量（轴不默认居中：pivot 是显式拟合参数）
    if (n > 0 && !opts.freezePivot) {
      axis.pivotX += meanDx / n;
      axis.pivotY += meanDy / n;
      for (const f of frames) {
        const fp = frameParams.get(f.frameId)!;
        fp.shiftX -= meanDx / n;
        fp.shiftY -= meanDy / n;
      }
    }
    // 方位角：有限差分下降
    const cost = (a: AxisParams) => totalSq(frames, observations, specimen, a, frameParams, ctx, physicalOf);
    const base = cost(axis);
    const step = 0.5;
    const trial = { ...axis, azimuthDeg: axis.azimuthDeg + step };
    const cPlus = cost(trial);
    const trial2 = { ...axis, azimuthDeg: axis.azimuthDeg - step };
    const cMinus = cost(trial2);
    if (cPlus < base && cPlus <= cMinus) axis.azimuthDeg += step;
    else if (cMinus < base) axis.azimuthDeg -= step;
  }

  const residualByObservation = new Map<string, number>();
  const sumByFrame = new Map<string, { sum: number; n: number }>();
  let total = 0;
  for (const o of observations) {
    const p = specimen.get(physicalOf(o.trackId, o.tiltIndex))!;
    const f = frameParams.get(o.frameId)!;
    const fr = frames.find((fr) => fr.frameId === o.frameId)!;
    const proj = projectPoint(p, fr.tiltDeg, axis, f, ctx);
    const r = Math.hypot(o.xPx - proj.x, o.yPx - proj.y);
    residualByObservation.set(o.observationId, r);
    const acc = sumByFrame.get(o.frameId) ?? { sum: 0, n: 0 };
    acc.sum += r * r; acc.n += 1;
    sumByFrame.set(o.frameId, acc);
    total += r * r;
  }
  const rmsByFrame = new Map<string, number>();
  for (const [fid, acc] of sumByFrame) rmsByFrame.set(fid, Math.sqrt(acc.sum / acc.n));
  const rmsOverall = Math.sqrt(total / Math.max(1, observations.length));

  // Z 向条件数：sin(t) 覆盖不足时病态（缺失高倾角帧的典型后果）
  let sss = 0;
  for (const f of frames) {
    const s = Math.sin((f.tiltDeg * Math.PI) / 180);
    sss += s * s;
  }
  const zConditioning = sss / Math.max(1, frames.length);

  return { axis, frameParams, specimenPoints: specimen, residualByObservation, rmsByFrame, rmsOverall, zConditioning };
}

function totalSq(
  frames: FitFrame[],
  observations: FitObservation[],
  specimen: Map<string, SpecimenPoint>,
  axis: AxisParams,
  frameParams: Map<string, FrameParams>,
  ctx: ProjectionContext,
  physicalOf: (t: string, i: number) => string,
): number {
  let sum = 0;
  for (const o of observations) {
    const p = specimen.get(physicalOf(o.trackId, o.tiltIndex));
    if (!p) continue;
    const fr = frames.find((f) => f.frameId === o.frameId)!;
    const proj = projectPoint(p, fr.tiltDeg, axis, frameParams.get(o.frameId)!, ctx);
    sum += (o.xPx - proj.x) ** 2 + (o.yPx - proj.y) ** 2;
  }
  return sum;
}
