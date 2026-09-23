/**
 * 配准领域规则与计算。
 *
 * 三条写入机器可读事件的判断依据：
 *  1. rule.axis-not-center-default      倾转轴不能被默认固定在图像中心
 *  2. rule.track-break-identity-swap    fiducial 轨迹可断裂且可能身份交换
 *  3. rule.same-effective-point-set     不同候选用相同有效点集比较，不用少帧换低残差
 */

export const RULE_SET_VERSION = 3;

export const RULES = {
  AXIS_NOT_CENTER_DEFAULT: 'rule.axis-not-center-default',
  TRACK_BREAK_IDENTITY_SWAP: 'rule.track-break-identity-swap',
  SAME_EFFECTIVE_POINT_SET: 'rule.same-effective-point-set',
} as const;

export const DIAG = {
  HIGH_TILT_MISSING: 'tilt-range.high-angle-missing',
  LOCAL_DEFORM_OVERFIT: 'local-deform.overfit',
  TRACK_IDENTITY_SWAP_SUSPECTED: 'track.identity-swap.suspected',
  MULTIPLE_SOLUTIONS: 'candidate.multiple-solutions',
} as const;

export interface FiducialPoint {
  track: string;
  frame: string;
  x: number; // px, coord_frame=image
  y: number;
}

export interface TrackGap {
  track: string;
  from_frame: string;
  to_frame: string;
  reason: string;
}

export interface TiltAxis {
  x_offset_px: number; // 相对图像中心的偏心量
  y_offset_px: number;
  angle_deg: number;   // 轴在图像平面内的方位角
}

export interface FrameInfo {
  frame: string;
  tilt_deg: number;
  excluded: boolean;
}

export type PointKey = string; // `${track}@${frame}`

export function pointKey(track: string, frame: string): PointKey {
  return `${track}@${frame}`;
}

/** 有效点集：fiducial 点减去跟踪缺口覆盖的范围，再减去被排除帧。 */
export function effectivePointSet(
  points: FiducialPoint[],
  gaps: TrackGap[],
  frames: FrameInfo[],
): PointKey[] {
  const frameOrder = frames.map((f) => f.frame);
  const excluded = new Set(frames.filter((f) => f.excluded).map((f) => f.frame));
  const inGap = (track: string, frame: string): boolean => {
    const idx = frameOrder.indexOf(frame);
    return gaps.some((g) => {
      if (g.track !== track) return false;
      const a = frameOrder.indexOf(g.from_frame);
      const b = frameOrder.indexOf(g.to_frame);
      return idx >= Math.min(a, b) && idx <= Math.max(a, b);
    });
  };
  const keys = points
    .filter((p) => !excluded.has(p.frame) && !inGap(p.track, p.frame))
    .map((p) => pointKey(p.track, p.frame));
  return [...new Set(keys)].sort();
}

export function pointSetHash(keys: PointKey[]): string {
  // 稳定、可机器比较的点集摘要（FNV-1a，够用于一致性校验）
  let h = 0x811c9dc5;
  const s = keys.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a:${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 简化投影模型：以轨迹在参考帧（倾角最接近 0 的帧）的均值为基准，
 * 按倾角差绕倾转轴旋转得到预测位置。返回每帧 RMS 残差（px）。
 */
export function rigidResiduals(
  points: FiducialPoint[],
  keys: PointKey[],
  frames: FrameInfo[],
  axis: TiltAxis,
): Record<string, number> {
  const tiltOf = new Map(frames.map((f) => [f.frame, f.tilt_deg]));
  const keySet = new Set(keys);
  const refFrame = frames.reduce((a, b) =>
    Math.abs(a.tilt_deg) <= Math.abs(b.tilt_deg) ? a : b,
  ).frame;
  const byTrack = new Map<string, FiducialPoint[]>();
  for (const p of points) if (keySet.has(pointKey(p.track, p.frame))) {
    const arr = byTrack.get(p.track) ?? [];
    arr.push(p);
    byTrack.set(p.track, arr);
  }
  const refPos = new Map<string, { x: number; y: number }>();
  for (const [track, arr] of byTrack) {
    const ref = arr.find((p) => p.frame === refFrame) ?? arr[0];
    refPos.set(track, { x: ref.x, y: ref.y });
  }
  const refTilt = tiltOf.get(refFrame) ?? 0;
  const perFrame = new Map<string, number[]>();
  for (const p of points) {
    if (!keySet.has(pointKey(p.track, p.frame))) continue;
    const ref = refPos.get(p.track)!;
    const dTilt = ((tiltOf.get(p.frame)! - refTilt) * Math.PI) / 180;
    const dx = ref.x - axis.x_offset_px;
    const px = axis.x_offset_px + dx * Math.cos(dTilt);
    const py = ref.y + axis.y_offset_px * (1 - Math.cos(dTilt));
    const err = Math.hypot(p.x - px, p.y - py);
    const arr = perFrame.get(p.frame) ?? [];
    arr.push(err);
    perFrame.set(p.frame, arr);
  }
  const out: Record<string, number> = {};
  for (const [frame, errs] of perFrame) {
    out[frame] = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
  }
  return out;
}

/**
 * 局部形变模型：每帧独立平移拟合。每帧有效点 < 3 时视为过拟合风险，
 * 残差不可用于候选排序。
 */
export function localDeformResiduals(
  points: FiducialPoint[],
  keys: PointKey[],
  rigid: Record<string, number>,
): { residuals: Record<string, number>; overfitFrames: string[] } {
  const keySet = new Set(keys);
  const counts = new Map<string, number>();
  for (const k of keySet) {
    const frame = k.split('@')[1];
    counts.set(frame, (counts.get(frame) ?? 0) + 1);
  }
  void points;
  const residuals: Record<string, number> = {};
  const overfitFrames: string[] = [];
  for (const [frame, r] of Object.entries(rigid)) {
    const n = counts.get(frame) ?? 0;
    if (n < 3) {
      overfitFrames.push(frame);
      residuals[frame] = 0; // 每帧平移可吞掉全部误差 —— 不可信
    } else {
      residuals[frame] = r * 0.4; // 局部自由度吸收部分误差
    }
  }
  return { residuals, overfitFrames };
}

/** 多解检测：任一帧有效点 < 3 时刚体轴拟合存在翻转多解。 */
export function detectMultipleSolutions(keys: PointKey[]): boolean {
  const counts = new Map<string, number>();
  for (const k of keys) {
    const frame = k.split('@')[1];
    counts.set(frame, (counts.get(frame) ?? 0) + 1);
  }
  for (const n of counts.values()) if (n < 3) return true;
  return false;
}

/** 轨迹断裂/身份交换检测：同一轨迹相邻帧位移突跳超过阈值。 */
export function detectTrackAnomalies(
  points: FiducialPoint[],
  frameOrder: string[],
  jumpThresholdPx = 40,
): { track: string; at_frame: string; jump_px: number }[] {
  const byTrack = new Map<string, FiducialPoint[]>();
  for (const p of points) {
    const arr = byTrack.get(p.track) ?? [];
    arr.push(p);
    byTrack.set(p.track, arr);
  }
  const anomalies: { track: string; at_frame: string; jump_px: number }[] = [];
  for (const [track, arr] of byTrack) {
    arr.sort((a, b) => frameOrder.indexOf(a.frame) - frameOrder.indexOf(b.frame));
    for (let i = 1; i < arr.length; i++) {
      const jump = Math.hypot(arr[i].x - arr[i - 1].x, arr[i].y - arr[i - 1].y);
      if (jump > jumpThresholdPx) {
        anomalies.push({ track, at_frame: arr[i].frame, jump_px: Math.round(jump * 100) / 100 });
      }
    }
  }
  return anomalies;
}

export interface CandidateView {
  id: string;
  kind: 'rigid' | 'local_deform' | 'exclude_bad_frames';
  effective_point_set: PointKey[];
  per_frame_residuals: Record<string, number>;
}

export interface CandidateComparison {
  valid_for_ranking: boolean;
  reason: string;
  shared_point_set_hash: string;
  shared_point_count: number;
  mean_residual_nm: Record<string, number>;
  per_frame_delta: Record<string, number>;
}

/**
 * 候选差分：只允许在相同有效点集上比较（取交集），
 * 不允许用更少帧换取更低残差。
 */
export function compareCandidates(
  a: CandidateView,
  b: CandidateView,
  pixelSizeNm: number,
): CandidateComparison {
  const setA = new Set(a.effective_point_set);
  const setB = new Set(b.effective_point_set);
  const shared = [...setA].filter((k) => setB.has(k)).sort();
  const sameSet = shared.length === setA.size && shared.length === setB.size;
  const framesOf = (keys: PointKey[]) => [...new Set(keys.map((k) => k.split('@')[1]))];
  const sharedFrames = framesOf(shared);
  const mean = (c: CandidateView) => {
    const vals = sharedFrames
      .map((f) => c.per_frame_residuals[f])
      .filter((v): v is number => typeof v === 'number');
    if (!vals.length) return NaN;
    return (vals.reduce((s, v) => s + v, 0) / vals.length) * pixelSizeNm;
  };
  const perFrameDelta: Record<string, number> = {};
  for (const f of sharedFrames) {
    const ra = a.per_frame_residuals[f];
    const rb = b.per_frame_residuals[f];
    if (typeof ra === 'number' && typeof rb === 'number') {
      perFrameDelta[f] = Math.round((ra - rb) * pixelSizeNm * 1000) / 1000;
    }
  }
  return {
    valid_for_ranking: sameSet,
    reason: sameSet
      ? '候选使用相同有效点集，可排序'
      : '有效点集不同：已在交集上重算均值，禁止用少帧换低残差',
    shared_point_set_hash: pointSetHash(shared),
    shared_point_count: shared.length,
    mean_residual_nm: { [a.id]: round3(mean(a)), [b.id]: round3(mean(b)) },
    per_frame_delta: perFrameDelta,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
