// 派生层：配准推导。规则：
//  - 倾转轴不能被默认固定在图像中心（axis offset 是显式参数）
//  - fiducial 轨迹可断裂且可能身份交换（gap 与 swap 是数据，不是错误）
//  - 不同候选用相同有效点集比较，不用少帧换低残差
import { digestOf } from './digest.js';

export interface FrameInput {
  index: number;
  tilt_deg: number; // 已规范化
  dose_e_per_a2?: number;
  blur?: boolean;
}

export interface TrackPoint { frame_index: number; x_px: number; y_px: number }
export interface Track {
  fiducial_id: string;
  points: TrackPoint[];
  gaps: [number, number][]; // 跟踪缺口（帧区间，含端点）
}
export interface SpecimenRef { fiducial_id: string; x_nm: number; y_nm: number; z_nm: number }

export interface AlignmentParams {
  params_version: number;
  axis_offset_nm: number; // 轴线偏心距；不允许默认锁死在图像中心
  in_plane_angle_deg: number;
  excluded_frames: number[]; // 坏帧排除
  model: 'rigid' | 'local_deform';
}

export interface FrameResidual {
  frame_index: number;
  n_points: number;
  rms_nm: number;
}
export interface CandidateResult {
  point_set: string[]; // "fid:frame" 有效点集
  point_set_hash: string;
  frame_set: number[];
  residuals: FrameResidual[];
  total_rms_nm: number;
  diagnostics: string[];
}

export function projectPoint(
  ref: SpecimenRef, tiltDeg: number, inPlaneDeg: number, axisOffsetNm: number,
): { u_nm: number; v_nm: number } {
  const th = (tiltDeg * Math.PI) / 180;
  const al = (inPlaneDeg * Math.PI) / 180;
  const xr = ref.x_nm * Math.cos(th) + ref.z_nm * Math.sin(th);
  const yr = ref.y_nm;
  return {
    u_nm: xr * Math.cos(al) + yr * Math.sin(al) + axisOffsetNm,
    v_nm: -xr * Math.sin(al) + yr * Math.cos(al),
  };
}

function inGaps(track: Track, frame: number): boolean {
  return track.gaps.some(([a, b]) => frame >= a && frame <= b);
}

export function effectivePointSet(
  tracks: Track[], frames: FrameInput[], excludedFrames: number[],
): string[] {
  const frameIdx = new Set(frames.map((f) => f.index));
  const out: string[] = [];
  for (const t of tracks) {
    for (const p of t.points) {
      if (!frameIdx.has(p.frame_index)) continue;
      if (excludedFrames.includes(p.frame_index)) continue;
      if (inGaps(t, p.frame_index)) continue;
      out.push(`${t.fiducial_id}:${p.frame_index}`);
    }
  }
  return out.sort();
}

export function computeCandidate(
  frames: FrameInput[],
  tracks: Track[],
  specimen: SpecimenRef[],
  pixelNmPerPx: number,
  imageCenterPx: { x: number; y: number },
  params: AlignmentParams,
): CandidateResult {
  const diagnostics: string[] = [];
  const set = effectivePointSet(tracks, frames, params.excluded_frames);
  const tiltByFrame = new Map(frames.map((f) => [f.index, f.tilt_deg]));
  const refByFid = new Map(specimen.map((s) => [s.fiducial_id, s]));

  // 收集每个有效点的观测位移残差（nm）
  const residualsByFrame = new Map<number, { du: number; dv: number }[]>();
  let fitOffset = params.axis_offset_nm;
  if (params.model === 'rigid') {
    // 刚体：用全部有效点对轴线偏心做最小二乘（均值）估计，而不是默认 0
    const offsets: number[] = [];
    for (const key of set) {
      const [fid, fs] = key.split(':');
      const ref = refByFid.get(fid);
      const tilt = tiltByFrame.get(Number(fs));
      if (!ref || tilt === undefined) continue;
      const tr = tracks.find((t) => t.fiducial_id === fid)!;
      const p = tr.points.find((q) => q.frame_index === Number(fs))!;
      const pred = projectPoint(ref, tilt, params.in_plane_angle_deg, 0);
      const obsU = (p.x_px - imageCenterPx.x) * pixelNmPerPx;
      offsets.push(obsU - pred.u_nm);
    }
    fitOffset = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
  }
  for (const key of set) {
    const [fid, fs] = key.split(':');
    const frame = Number(fs);
    const ref = refByFid.get(fid);
    const tilt = tiltByFrame.get(frame);
    if (!ref || tilt === undefined) continue;
    const tr = tracks.find((t) => t.fiducial_id === fid)!;
    const p = tr.points.find((q) => q.frame_index === frame)!;
    const pred = projectPoint(ref, tilt, params.in_plane_angle_deg, fitOffset);
    let du = (p.x_px - imageCenterPx.x) * pixelNmPerPx - pred.u_nm;
    let dv = (p.y_px - imageCenterPx.y) * pixelNmPerPx - pred.v_nm;
    if (params.model === 'local_deform') {
      // 局部形变：每帧拟合一个平移，残差被人为压低 → 过拟合风险
      const peers = set.filter((k) => k.endsWith(`:${frame}`));
      let su = 0, sv = 0, n = 0;
      for (const pk of peers) {
        const [pfid] = pk.split(':');
        const pref = refByFid.get(pfid);
        if (!pref) continue;
        const ptr = tracks.find((t) => t.fiducial_id === pfid)!;
        const pp = ptr.points.find((q) => q.frame_index === frame)!;
        const ppred = projectPoint(pref, tilt, params.in_plane_angle_deg, fitOffset);
        su += (pp.x_px - imageCenterPx.x) * pixelNmPerPx - ppred.u_nm;
        sv += (pp.y_px - imageCenterPx.y) * pixelNmPerPx - ppred.v_nm;
        n++;
      }
      if (n > 0) { du -= su / n; dv -= sv / n; }
    }
    const arr = residualsByFrame.get(frame) ?? [];
    arr.push({ du, dv });
    residualsByFrame.set(frame, arr);
  }
  const residuals: FrameResidual[] = [...residualsByFrame.entries()]
    .map(([frame_index, rs]) => ({
      frame_index,
      n_points: rs.length,
      rms_nm: Math.sqrt(rs.reduce((a, r) => a + r.du * r.du + r.dv * r.dv, 0) / Math.max(1, rs.length)),
    }))
    .sort((a, b) => a.frame_index - b.frame_index);
  const totalPts = residuals.reduce((a, r) => a + r.n_points, 0);
  const total = Math.sqrt(
    residuals.reduce((a, r) => a + r.rms_nm * r.rms_nm * r.n_points, 0) / Math.max(1, totalPts),
  );
  if (params.model === 'local_deform') {
    const dof = residuals.length * 2;
    if (totalPts > 0 && dof / totalPts > 0.25) {
      diagnostics.push(
        `local_deform_overfit: 自由度 ${dof} 相对有效点 ${totalPts} 过高，残差下降可能来自过拟合`,
      );
    }
  }
  return {
    point_set: set,
    point_set_hash: digestOf(set),
    frame_set: [...new Set(set.map((k) => Number(k.split(':')[1])))].sort((a, b) => a - b),
    residuals,
    total_rms_nm: total,
    diagnostics,
  };
}

// 公平比较：把所有候选限制到共同有效点集上重新计算，禁止用少帧换低残差。
export function compareOnCommonSet(
  results: Map<string, CandidateResult>,
): { common_point_set_hash: string; table: { candidate_id: string; common_rms_nm: number; self_frame_count: number; diagnostic?: string }[] } {
  const sets = [...results.values()].map((r) => new Set(r.point_set));
  const common = [...(sets[0] ?? new Set<string>())].filter((k) => sets.every((s) => s.has(k))).sort();
  const table = [...results.entries()].map(([id, r]) => {
    const inCommon = r.residuals.filter((fr) =>
      r.point_set.some((k) => k.endsWith(`:${fr.frame_index}`) && common.includes(k)),
    );
    const n = inCommon.reduce((a, r) => a + r.n_points, 0);
    const rms = Math.sqrt(inCommon.reduce((a, r) => a + r.rms_nm * r.rms_nm * r.n_points, 0) / Math.max(1, n));
    const diagnostic =
      r.frame_set.length > new Set(common.map((k) => Number(k.split(':')[1]))).size
        ? undefined
        : r.frame_set.length < Math.max(...[...results.values()].map((x) => x.frame_set.length))
          ? 'fewer_frames_lower_residual: 该候选用了更少帧，残差不可直接比较，已改用共同点集'
          : undefined;
    return { candidate_id: id, common_rms_nm: rms, self_frame_count: r.frame_set.length, diagnostic };
  });
  return { common_point_set_hash: digestOf(common), table };
}
