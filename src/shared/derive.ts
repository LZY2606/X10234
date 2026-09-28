import { lstsq } from './linalg';
import type {
  MarkerObservation,
  PerFrameResidual,
  RawFrame,
  RegistrationCandidate,
  TiltAngle,
  TiltAxisGeometry,
  TrackIdentity,
  Vec2,
} from './types';

export interface FrameTilt {
  frameId: string;
  acquisitionIndex: number;
  tiltDeg: number | null;
  excluded: boolean;
}

export interface DeriveInput {
  frames: RawFrame[];
  tilts: TiltAngle[];
  observations: MarkerObservation[];
  tracks: TrackIdentity[];
  excludedFrameIds: Set<string>;
  badFrameIds: Set<string>;
  highTiltDeg: number;
  imageSize: { widthPx: number; heightPx: number };
  missingAcquisitionIndices: number[];
  missingHighTilt: boolean;
}

export const AMBIGUITY_RATIO = 1.02;
export const OVERFIT_CV_RATIO = 1.25;

function normalizeDeg(deg: number): number {
  let a = deg % 180;
  if (a < 0) a += 180;
  return a;
}

type ObsIndex = Map<string, MarkerObservation>;

function indexObservations(input: DeriveInput): ObsIndex {
  const map: ObsIndex = new Map();
  for (const o of input.observations) map.set(o.observationId, o);
  return map;
}

// ---------- 轨迹直线（与倾转轴垂直） ----------

export interface TrackLine {
  trackId: string;
  angleDeg: number;
  center: Vec2;
  points: Vec2[];
}

export function fitTrackLine(track: TrackIdentity, obsByFrame: ObsIndex): TrackLine | null {
  const points: Vec2[] = [];
  for (const seg of track.segments) {
    for (const oid of seg.observationIds) {
      const obs = obsByFrame.get(oid);
      if (obs) points.push(obs.position.frame);
    }
  }
  if (points.length < 2) return null;
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  let dx: number;
  let dy: number;
  if (Math.abs(sxy) > 1e-12) {
    dx = l1 - syy;
    dy = sxy;
  } else {
    dx = sxx >= syy ? 1 : 0;
    dy = sxx >= syy ? 0 : 1;
  }
  const norm = Math.hypot(dx, dy) || 1;
  const angle = normalizeDeg((Math.atan2(dy / norm, dx / norm) * 180) / Math.PI);
  return { trackId: track.trackId, angleDeg: angle, center: { x: cx, y: cy }, points };
}

// ---------- 倾转轴几何：角度 + 显式穿过点（禁止默认在中心） ----------

export interface AxisHypothesis extends TiltAxisGeometry {
  fitRmsPx: number;
  swapped: boolean;
}

export function enumerateTrackGroupings(tracks: TrackIdentity[]): TrackIdentity[][] {
  if (tracks.length !== 2) return [tracks];
  const [a, b] = tracks;
  if (a.segments.length !== 1 || b.segments.length !== 1) return [tracks];
  const swapped: TrackIdentity[] = [
    { ...a, physicalMarkerRef: b.physicalMarkerRef, segments: b.segments, note: '身份交换候选' },
    { ...b, physicalMarkerRef: a.physicalMarkerRef, segments: a.segments, note: '身份交换候选' },
  ];
  return [tracks, swapped];
}

function robustAxisAngle(lines: TrackLine[]): number {
  const angles = lines.map((l) => normalizeDeg(l.angleDeg + 90));
  const ref = angles[0];
  const unwrapped = angles.map((a) => {
    let d = a - ref;
    while (d > 90) d -= 180;
    while (d < -90) d += 180;
    return ref + d;
  });
  unwrapped.sort((a, b) => a - b);
  return unwrapped[Math.floor(unwrapped.length / 2)];
}

function axisLineRms(lines: TrackLine[], axisAngleDeg: number): number {
  const ar = ((axisAngleDeg - 90) * Math.PI) / 180;
  const nx = -Math.sin(ar);
  const ny = Math.cos(ar);
  let ss = 0;
  let count = 0;
  for (const line of lines) {
    const rho = line.center.x * nx + line.center.y * ny;
    for (const p of line.points) {
      ss += (p.x * nx + p.y * ny - rho) ** 2;
      count += 1;
    }
  }
  return Math.sqrt(ss / Math.max(1, count));
}

function axisPointFromLines(lines: TrackLine[], angleDeg: number, size: { widthPx: number; heightPx: number }): Vec2 {
  const ar = (angleDeg * Math.PI) / 180;
  const nx = -Math.sin(ar);
  const ny = Math.cos(ar);
  const rhos = lines.map((l) => l.center.x * nx + l.center.y * ny);
  const offset = rhos.reduce((s, r) => s + r, 0) / rhos.length;
  return {
    x: size.widthPx / 2 + nx * offset,
    y: size.heightPx / 2 + ny * offset,
  };
}

export function proposeAxes(input: DeriveInput): AxisHypothesis[] {
  const obsByFrame = indexObservations(input);
  const groupings = enumerateTrackGroupings(input.tracks);
  const found: { axis: AxisHypothesis; rms: number }[] = [];
  for (const grouped of groupings) {
    const lines = grouped
      .map((t) => fitTrackLine(t, obsByFrame))
      .filter((l): l is TrackLine => l !== null);
    if (lines.length === 0) continue;
    const angle = robustAxisAngle(lines);
    const rms = axisLineRms(lines, angle);
    const point = axisPointFromLines(lines, angle, input.imageSize);
    const center = { x: input.imageSize.widthPx / 2, y: input.imageSize.heightPx / 2 };
    const swapped = grouped !== input.tracks;
    found.push({
      axis: {
        kind: 'TiltAxisGeometry',
        axisId: '',
        angleDeg: angle,
        axisPoint: point,
        imageSize: input.imageSize,
        eccentricityPx: Math.hypot(point.x - center.x, point.y - center.y),
        source: 'fitted',
        note: swapped ? '由交换后的 fiducial 身份假设拟合' : '由 fiducial 轨迹直线稳健拟合',
        fitRmsPx: rms,
        swapped,
      },
      rms,
    });
  }
  found.sort((a, b) => a.rms - b.rms);
  const best = found[0]?.rms ?? 1;
  return found.filter((h) => h.rms <= best * AMBIGUITY_RATIO + 1e-9).map((h) => h.axis);
}

// ---------- 配准候选拟合 ----------

interface ObsEntry {
  obsId: string;
  frameId: string;
  frameIndex: number;
  trackId: string;
  pos: Vec2;
  sinTilt: number;
  trackCenter: Vec2;
  trackDir: Vec2;
}

export interface FitResult {
  frameShifts: Map<string, Vec2>;
  perFrame: PerFrameResidual[];
  ownRmsPx: number;
  usedFrameIds: string[];
  usedObservationIds: string[];
  cvRmsPx: number;
  residualOf: Map<string, Vec2>;
}

function buildEntries(input: DeriveInput, lines: TrackLine[]): ObsEntry[] {
  const frameIndex = new Map(input.frames.map((f) => [f.frameId, f.acquisitionIndex]));
  const tiltOf = new Map<string, number | null>();
  for (const t of input.tilts) {
    tiltOf.set(t.frameId, t.angle.value === undefined ? null : t.angle.value);
  }
  const lineOfTrack = new Map(lines.map((l) => [l.trackId, l]));
  const obsByFrameTrack = new Map<string, MarkerObservation>();
  for (const o of input.observations) obsByFrameTrack.set(o.observationId, o);
  const entries: ObsEntry[] = [];
  for (const track of input.tracks) {
    const line = lineOfTrack.get(track.trackId);
    if (!line) continue;
    const dirAngle = (line.angleDeg * Math.PI) / 180;
    const dir = { x: Math.cos(dirAngle), y: Math.sin(dirAngle) };
    for (const seg of track.segments) {
      for (let i = 0; i < seg.observationIds.length; i++) {
        const obs = obsByFrameTrack.get(seg.observationIds[i]);
        const frameId = seg.frameIds[i];
        if (!obs) continue;
        const tilt = tiltOf.get(frameId);
        entries.push({
          obsId: obs.observationId,
          frameId,
          frameIndex: frameIndex.get(frameId) ?? 0,
          trackId: track.trackId,
          pos: obs.position.frame,
          sinTilt: tilt === null ? 0 : Math.sin((tilt * Math.PI) / 180),
          trackCenter: line.center,
          trackDir: dir,
        });
      }
    }
  }
  return entries;
}

function estimateZ(entries: ObsEntry[], frameAllowed: Set<string>): Map<string, number> {
  const acc = new Map<string, { num: number; den: number }>();
  for (const e of entries) {
    if (!frameAllowed.has(e.frameId)) continue;
    const q = (e.pos.x - e.trackCenter.x) * e.trackDir.x + (e.pos.y - e.trackCenter.y) * e.trackDir.y;
    const a = acc.get(e.trackId) ?? { num: 0, den: 0 };
    a.num += q * e.sinTilt;
    a.den += e.sinTilt * e.sinTilt;
    acc.set(e.trackId, a);
  }
  const z = new Map<string, number>();
  for (const [trackId, a] of acc) z.set(trackId, a.den < 1e-12 ? 0 : a.num / a.den);
  return z;
}

function predicted(e: ObsEntry, z: Map<string, number>): Vec2 {
  const zk = z.get(e.trackId) ?? 0;
  return {
    x: e.trackCenter.x + zk * e.sinTilt * e.trackDir.x,
    y: e.trackCenter.y + zk * e.sinTilt * e.trackDir.y,
  };
}

function fitRigid(entries: ObsEntry[], allowed: Set<string>): { shifts: Map<string, Vec2>; z: Map<string, number> } {
  const z = estimateZ(entries, allowed);
  const sums = new Map<string, { sx: number; sy: number; n: number }>();
  for (const e of entries) {
    if (!allowed.has(e.frameId)) continue;
    const pred = predicted(e, z);
    const s = sums.get(e.frameId) ?? { sx: 0, sy: 0, n: 0 };
    s.sx += e.pos.x - pred.x;
    s.sy += e.pos.y - pred.y;
    s.n += 1;
    sums.set(e.frameId, s);
  }
  const shifts = new Map<string, Vec2>();
  for (const [frameId, s] of sums) shifts.set(frameId, { x: s.sx / s.n, y: s.sy / s.n });
  return { shifts, z };
}

function fitLocalWarp(
  entries: ObsEntry[],
  allowed: Set<string>,
): { shifts: Map<string, Vec2>; z: Map<string, number>; drift: Map<string, Vec2> } {
  // 每帧平移 + 每标记恒定漂移（2F + 2M 个线性参数），用交替最小二乘求解。
  const { shifts, z } = fitRigid(entries, allowed);
  const trackIds = [...new Set(entries.map((e) => e.trackId))];
  const drift = new Map<string, Vec2>(trackIds.map((t) => [t, { x: 0, y: 0 }]));
  for (let iter = 0; iter < 12; iter++) {
    const sums = new Map<string, { sx: number; sy: number; n: number }>();
    for (const e of entries) {
      if (!allowed.has(e.frameId)) continue;
      const pred = predicted(e, z);
      const d = drift.get(e.trackId)!;
      const s = sums.get(e.frameId) ?? { sx: 0, sy: 0, n: 0 };
      s.sx += e.pos.x - pred.x - d.x;
      s.sy += e.pos.y - pred.y - d.y;
      s.n += 1;
      sums.set(e.frameId, s);
    }
    shifts.clear();
    for (const [frameId, s] of sums) shifts.set(frameId, { x: s.sx / s.n, y: s.sy / s.n });
    const dsums = new Map<string, { sx: number; sy: number; n: number }>();
    for (const e of entries) {
      if (!allowed.has(e.frameId)) continue;
      const pred = predicted(e, z);
      const sh = shifts.get(e.frameId)!;
      const d = dsums.get(e.trackId) ?? { sx: 0, sy: 0, n: 0 };
      d.sx += e.pos.x - pred.x - sh.x;
      d.sy += e.pos.y - pred.y - sh.y;
      d.n += 1;
      dsums.set(e.trackId, d);
    }
    drift.clear();
    const mean = { x: 0, y: 0 };
    const raw = new Map<string, Vec2>();
    for (const [trackId, d] of dsums) {
      const v = { x: d.sx / d.n, y: d.sy / d.n };
      raw.set(trackId, v);
      mean.x += v.x;
      mean.y += v.y;
    }
    mean.x /= Math.max(1, raw.size);
    mean.y /= Math.max(1, raw.size);
    for (const [trackId, v] of raw) drift.set(trackId, { x: v.x - mean.x, y: v.y - mean.y });
  }
  return { shifts, z, drift };
}

interface FittedCandidate {
  model: RegistrationCandidate['model'];
  label: string;
  effectiveFrameIds: string[];
  effectiveObservationIds: string[];
  perFrameShift: Record<string, Vec2>;
  ownRmsPx: number;
  cvRmsPx: number;
  perFrame: PerFrameResidual[];
  residualOf: Map<string, Vec2>;
}

function residualsWith(
  entries: ObsEntry[],
  allowed: Set<string>,
  shifts: Map<string, Vec2>,
  z: Map<string, number>,
  drift?: Map<string, Vec2>,
): { residualOf: Map<string, Vec2>; perEntry: { e: ObsEntry; d: Vec2 }[] } {
  const residualOf = new Map<string, Vec2>();
  const perEntry: { e: ObsEntry; d: Vec2 }[] = [];
  for (const e of entries) {
    if (!allowed.has(e.frameId)) continue;
    const pred = predicted(e, z);
    const sh = shifts.get(e.frameId) ?? { x: 0, y: 0 };
    const dr = drift?.get(e.trackId) ?? { x: 0, y: 0 };
    const d = { x: e.pos.x - pred.x - sh.x - dr.x, y: e.pos.y - pred.y - sh.y - dr.y };
    residualOf.set(e.obsId, d);
    perEntry.push({ e, d });
  }
  return { residualOf, perEntry };
}

function summarize(entries: ObsEntry[], allFrames: RawFrame[], allowed: Set<string>, perEntry: { e: ObsEntry; d: Vec2 }[]): {
  ownRmsPx: number;
  perFrame: PerFrameResidual[];
} {
  const byFrame = new Map<string, { ss: number; n: number }>();
  for (const { e, d } of perEntry) {
    const b = byFrame.get(e.frameId) ?? { ss: 0, n: 0 };
    b.ss += d.x * d.x + d.y * d.y;
    b.n += 1;
    byFrame.set(e.frameId, b);
  }
  const perFrame: PerFrameResidual[] = allFrames
    .slice()
    .sort((a, b) => a.acquisitionIndex - b.acquisitionIndex)
    .map((f) => {
      const stat = byFrame.get(f.frameId);
      return {
        frameId: f.frameId,
        used: allowed.has(f.frameId) && !!stat && stat.n > 0,
        rmsPx: stat && stat.n > 0 ? Math.sqrt(stat.ss / stat.n) : null,
        nPoints: stat?.n ?? 0,
      };
    });
  const ss = perEntry.reduce((s, { d }) => s + d.x * d.x + d.y * d.y, 0);
  return { ownRmsPx: Math.sqrt(ss / Math.max(1, perEntry.length * 2)), perFrame };
}

function lofoCvRms(entries: ObsEntry[], allowed: Set<string>, model: 'rigid' | 'localWarp'): number {
  const foldFrames = [...new Set(entries.filter((e) => allowed.has(e.frameId)).map((e) => e.frameId))];
  let ss = 0;
  let n = 0;
  for (const holdout of foldFrames) {
    const trainAllowed = new Set([...allowed].filter((f) => f !== holdout));
    const fit = model === 'rigid' ? fitRigid(entries, trainAllowed) : fitLocalWarp(entries, trainAllowed);
    for (const e of entries) {
      if (e.frameId !== holdout) continue;
      const pred = predicted(e, fit.z);
      const dr = model === 'localWarp' ? fit.drift.get(e.trackId)! : { x: 0, y: 0 };
      const d = { x: e.pos.x - pred.x - dr.x, y: e.pos.y - pred.y - dr.y };
      ss += d.x * d.x + d.y * d.y;
      n += 2;
    }
  }
  return Math.sqrt(ss / Math.max(1, n));
}

function buildCandidate(
  model: FittedCandidate['model'],
  label: string,
  entries: ObsEntry[],
  frames: RawFrame[],
  allowed: Set<string>,
): FittedCandidate {
  const fit = model === 'localWarp' ? fitLocalWarp(entries, allowed) : fitRigid(entries, allowed);
  const { residualOf, perEntry } = residualsWith(entries, allowed, fit.shifts, fit.z, 'drift' in fit ? fit.drift : undefined);
  const { ownRmsPx, perFrame } = summarize(entries, frames, allowed, perEntry);
  const cvRmsPx = lofoCvRms(entries, allowed, model === 'badFrameExclusion' ? 'rigid' : model);
  const perFrameShift: Record<string, Vec2> = {};
  for (const [frameId, sh] of fit.shifts) perFrameShift[frameId] = sh;
  return {
    model,
    label,
    effectiveFrameIds: frames.filter((f) => allowed.has(f.frameId)).map((f) => f.frameId),
    effectiveObservationIds: entries.filter((e) => allowed.has(e.frameId)).map((e) => e.obsId),
    perFrameShift,
    ownRmsPx,
    cvRmsPx,
    perFrame,
    residualOf,
  };
}

export interface CandidateBundle {
  candidates: RegistrationCandidate[];
  axes: AxisHypothesis[];
  diagnostics: CandidateDiagnostic[];
}

function diag(code: CandidateDiagnostic['code'], severity: CandidateDiagnostic['severity'], message: string, evidence: Record<string, unknown> = {}): CandidateDiagnostic {
  return { code, severity, message, evidence };
}

export function proposeCandidates(input: DeriveInput, axes: AxisHypothesis[]): CandidateBundle {
  const obsByFrame = indexObservations(input);
  const lines = input.tracks
    .map((t) => fitTrackLine(t, obsByFrame))
    .filter((l): l is TrackLine => l !== null);
  const entries = buildEntries(input, lines);
  const frames = input.frames.slice().sort((a, b) => a.acquisitionIndex - b.acquisitionIndex);

  const rigidAllowed = new Set(frames.filter((f) => !input.excludedFrameIds.has(f.frameId)).map((f) => f.frameId));
  const badAllowed = new Set(
    frames
      .filter((f) => !input.excludedFrameIds.has(f.frameId) && !input.badFrameIds.has(f.frameId))
      .map((f) => f.frameId),
  );

  const rigid = buildCandidate('rigid', '刚体配准（每帧二维平移）', entries, frames, rigidAllowed);
  const warp = buildCandidate('localWarp', '局部形变配准（每帧平移+标记漂移）', entries, frames, rigidAllowed);
  const badFrame = buildCandidate('badFrameExclusion', '排除坏帧后的刚体配准', entries, frames, badAllowed);
  const fitted = [rigid, warp, badFrame];

  // 公平比较口径：所有候选共同有效的观测集合
  const commonObs = intersectAll(fitted.map((c) => new Set(c.effectiveObservationIds)));
  const commonFrames = intersectAll(fitted.map((c) => new Set(c.effectiveFrameIds)));
  const commonRms = fitted.map((c) => {
    let ss = 0;
    let n = 0;
    for (const obsId of commonObs) {
      const d = c.residualOf.get(obsId);
      if (d) {
        ss += d.x * d.x + d.y * d.y;
        n += 2;
      }
    }
    return Math.sqrt(ss / Math.max(1, n));
  });

  const diagnostics: CandidateDiagnostic[] = [];
  const ambiguityGroup = axes.length > 1 ? `ambig_${axes[0].axisId || 'axes'}` : undefined;
  if (axes.length > 1) {
    diagnostics.push(
      diag('MULTIPLE_SOLUTIONS', 'warn', `存在 ${axes.length} 个拟合残差相当的合法轴线/身份解，已全部保留等待人工裁定`, {
        axisAnglesDeg: axes.map((a) => a.angleDeg),
      }),
    );
  }
  for (const axis of axes) {
    if (axis.eccentricityPx > 2) {
      diagnostics.push(
        diag('AXIS_OFF_CENTER', 'info', `倾转轴穿过点偏离图像中心 ${axis.eccentricityPx.toFixed(2)} px，禁止回退到中心默认值`, {
          eccentricityPx: axis.eccentricityPx,
          axisPoint: axis.axisPoint,
        }),
      );
    }
  }
  for (const track of input.tracks) {
    if (track.segments.length > 1) {
      diagnostics.push(diag('TRACK_BROKEN', 'info', `轨迹 ${track.physicalMarkerRef} 断裂为 ${track.segments.length} 段，按分段参与拟合`, { trackId: track.trackId }));
    }
    if (track.swapWithTrackId) {
      diagnostics.push(diag('TRACK_IDENTITY_SWAP', 'warn', `轨迹 ${track.trackId} 与 ${track.swapWithTrackId} 发生身份交换，检测器编号不等于物理身份`, { trackId: track.trackId, swapWithTrackId: track.swapWithTrackId }));
    }
  }
  if (input.missingHighTilt) {
    diagnostics.push(
      diag('MISSING_HIGH_TILT_FRAME', 'warn', '缺少高倾角帧：轴线角与局部形变的可观测量下降，候选必须按相同有效点集比较', {
        thresholdDeg: input.highTiltDeg,
        missingAcquisitionIndices: input.missingAcquisitionIndices,
      }),
    );
  }

  const candidates: RegistrationCandidate[] = fitted.map((c, i) => {
    const cdiags: CandidateDiagnostic[] = [];
    if (c.model === 'badFrameExclusion') {
      const removed = frames.filter((f) => input.badFrameIds.has(f.frameId));
      cdiags.push(
        diag('BAD_FRAME_EXCLUDED', 'info', `排除 ${removed.length} 帧：${removed.map((f) => f.sourceLabel).join(', ')}；在共同有效点集上比较，少帧本身不构成优势`, {
          removedFrameIds: removed.map((f) => f.frameId),
          ownRmsPx: c.ownRmsPx,
          commonSetRmsPx: commonRms[i],
        }),
      );
      if (c.ownRmsPx + 1e-9 < rigid.ownRmsPx && commonRms[i] >= commonRms[0] - 1e-9) {
        cdiags.push(
          diag('FEWER_FRAMES_LOWER_RESIDUAL', 'fail', '该候选仅因使用更少帧得到更低自身残差；在共同有效点集上并无优势，不得采纳', {
            ownRmsPx: { rigid: rigid.ownRmsPx, badFrame: c.ownRmsPx },
            commonSetRmsPx: { rigid: commonRms[0], badFrame: commonRms[i] },
          }),
        );
      }
    }
    if (c.model === 'localWarp') {
      const ratio = rigid.cvRmsPx < 1e-9 ? Infinity : c.cvRmsPx / rigid.cvRmsPx;
      if (c.cvRmsPx > rigid.cvRmsPx * OVERFIT_CV_RATIO + 1e-9) {
        cdiags.push(
          diag('LOCAL_WARP_OVERFIT', 'fail', `局部形变留一帧交叉验证残差为刚体的 ${ratio.toFixed(2)} 倍，判定过拟合；自由度被用来吸收噪声`, {
            cvRmsPx: { rigid: rigid.cvRmsPx, localWarp: c.cvRmsPx },
            ratio,
          }),
        );
      }
    }
    if (c.model === 'rigid' && diagnostics.every((d) => d.code !== 'MULTIPLE_SOLUTIONS')) {
      cdiags.push(diag('FAIR_SET_OK', 'info', '刚体基准；各候选最终排序仅使用共同有效点集残差', { commonSetRmsPx: commonRms[i] }));
    }
    return {
      kind: 'RegistrationCandidate',
      candidateId: '',
      model: c.model,
      label: c.label,
      effectiveFrameIds: c.effectiveFrameIds,
      effectiveObservationIds: c.effectiveObservationIds,
      perFrameShift: c.perFrameShift,
      ownRmsPx: c.ownRmsPx,
      commonSetRmsPx: commonRms[i],
      perFrame: c.perFrame,
      diagnostics: cdiags,
      ambiguityGroupId: ambiguityGroup,
    };
  });

  diagnostics.push(
    diag('FAIR_SET_OK', 'info', '共同有效点集比较口径', {
      commonObservationCount: commonObs.size,
      commonFrameIds: [...commonFrames],
      commonSetRmsPx: Object.fromEntries(candidates.map((c) => [c.model, c.commonSetRmsPx])),
    }),
  );
  return { candidates, axes, diagnostics };
}

function intersectAll<T>(sets: Set<T>[]): Set<T> {
  if (sets.length === 0) return new Set();
  const out = new Set(sets[0]);
  for (const s of sets.slice(1)) for (const v of [...out]) if (!s.has(v)) out.delete(v);
  return out;
}
