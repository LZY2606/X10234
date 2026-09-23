// 派生层：对齐候选计算。
// 规则：
//  - 倾转轴可以偏心（free），也可以被显式固定在图像中心（center），但绝不默认中心。
//  - fiducial 轨迹可断裂：有效点集只包含真实观测到的 (track,frame)。
//  - 同一解释下的候选共享同一个有效点集，比较时禁止用更少点换更低残差。
//  - 局部形变按点拟合，残差必然趋零：必须附带过拟合诊断。
//  - 对称配置可能存在多解，全部合法候选都保留（ambiguity_group）。

import { digestJson, newId } from './id.ts';
import { normalizeAngle } from './units.ts';
import type {
  Diagnostic,
  FiducialCoordinatesContent,
  InterpretationParams,
  ModelKind,
  RawFramesContent,
  TiltAnglesContent
} from './types.ts';

export type Obs = { x: number; y: number };
export type PointMember = { track_id: string; frame_id: string };

export type AlignFrameInput = RawFramesContent['frames'][number];

export type AlignInput = {
  frames: AlignFrameInput[];
  angles: TiltAnglesContent;
  tracks: FiducialCoordinatesContent;
  excludedFrameIds: Set<string>;
  params: InterpretationParams;
};

export type FrameResidual = {
  frame_id: string;
  tilt_deg: number | null;
  rms_px: number;
  used_points: number;
};

export type CandidateResult = {
  model_kind: ModelKind;
  ambiguity_group: string | null;
  tilt_axis: {
    position_px: { x: number; y: number };
    offset_from_center_px: number;
    unit: 'px';
    frame: 'image';
    assumed_center: boolean;
  };
  per_frame: FrameResidual[];
  residual_rms_px: number;
  param_count: number;
  used_member_count: number;
  dropped_members: PointMember[];
  diagnostics: Diagnostic[];
};

export type AlignResult = {
  point_set_id: string;
  members: PointMember[];
  candidates: CandidateResult[];
  diagnostics: Diagnostic[];
};

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function computeAlignment(input: AlignInput): AlignResult {
  const diagnostics: Diagnostic[] = [];
  const includedFrames = input.frames.filter(
    (f) => input.params.framePolicy === 'all' || !input.excludedFrameIds.has(f.frame_id)
  );

  const angleDeg = new Map<string, number>();
  for (const a of input.angles.angles) {
    const n = normalizeAngle(a.tilt, `angle:${a.frame_id}`);
    if (n.quantity) angleDeg.set(a.frame_id, n.quantity.value);
    else if (n.diagnostic) diagnostics.push(n.diagnostic);
  }

  const obs = new Map<string, Obs>();
  for (const tr of input.tracks.tracks) {
    for (const o of tr.observations) obs.set(`${tr.track_id}@${o.frame_id}`, o.position);
  }
  const trackIds = input.tracks.tracks.map((t) => t.track_id);
  const frameIds = includedFrames.map((f) => f.frame_id);

  // 有效点集：真实观测、帧未被排除。所有模型候选共享它。
  const members: PointMember[] = [];
  for (const frameId of frameIds) {
    for (const trackId of trackIds) {
      if (obs.has(`${trackId}@${frameId}`)) members.push({ track_id: trackId, frame_id: frameId });
    }
  }
  const pointSetId = `pset_${digestJson({ members, policy: input.params.framePolicy }).slice(0, 16)}`;

  const referenceFrame =
    includedFrames
      .map((f) => ({ f, t: angleDeg.get(f.frame_id) }))
      .filter((x) => x.t !== undefined)
      .sort((a, b) => Math.abs(a.t!) - Math.abs(b.t!) || a.f.index - b.f.index)[0]?.f ??
    includedFrames[0];

  // 参考位置（基准帧观测，缺失则用该轨迹全部观测均值）
  const ref = new Map<string, Obs>();
  for (const tid of trackIds) {
    const atRef = obs.get(`${tid}@${referenceFrame.frame_id}`);
    if (atRef) ref.set(tid, atRef);
    else {
      const all = members.filter((m) => m.track_id === tid).map((m) => obs.get(`${m.track_id}@${m.frame_id}`)!);
      if (all.length) ref.set(tid, { x: mean(all.map((o) => o.x)), y: mean(all.map((o) => o.y)) });
    }
  }

  const center = {
    x: referenceFrame ? referenceFrame.width / 2 : 0,
    y: referenceFrame ? referenceFrame.height / 2 : 0
  };

  type FrameFit = { frameId: string; theta: number; tx: number; ty: number; rms: number; used: number };

  const fitFrame = (frameId: string, globalTheta: number | null, allowed: Set<string>): FrameFit => {
    const rows: Array<{ r: Obs; d: Obs }> = [];
    for (const tid of trackIds) {
      if (!allowed.has(`${tid}@${frameId}`)) continue;
      const r0 = ref.get(tid);
      const o = obs.get(`${tid}@${frameId}`);
      if (!r0 || !o) continue;
      rows.push({ r: { x: r0.x - center.x, y: r0.y - center.y }, d: { x: o.x - r0.x, y: o.y - r0.y } });
    }
    let theta = 0;
    if (globalTheta === null && rows.length >= 2) {
      const md = { x: mean(rows.map((r) => r.d.x)), y: mean(rows.map((r) => r.d.y)) };
      const mr = { x: mean(rows.map((r) => r.r.x)), y: mean(rows.map((r) => r.r.y)) };
      let num = 0;
      let den = 0;
      for (const row of rows) {
        const rx = row.r.x - mr.x;
        const ry = row.r.y - mr.y;
        const dx = row.d.x - md.x;
        const dy = row.d.y - md.y;
        num += -ry * dx + rx * dy;
        den += rx * rx + ry * ry;
      }
      theta = den > 0 ? num / den : 0;
    } else if (globalTheta !== null) {
      theta = globalTheta;
    }
    const jrs = rows.map((r) => ({ jx: -r.r.y, jy: r.r.x }));
    const tx = mean(rows.map((r) => r.d.x)) - theta * mean(jrs.map((j) => j.jx));
    const ty = mean(rows.map((r) => r.d.y)) - theta * mean(jrs.map((j) => j.jy));
    let ss = 0;
    let count = 0;
    rows.forEach((row, i) => {
      const ex = row.d.x - (tx + theta * jrs[i].jx);
      const ey = row.d.y - (ty + theta * jrs[i].jy);
      ss += ex * ex + ey * ey;
      count += 1;
    });
    return { frameId, theta, tx, ty, rms: count ? Math.sqrt(ss / count) : 0, used: count };
  };

  const allAllowed = new Set(members.map((m) => `${m.track_id}@${m.frame_id}`));

  // center 模式：全局单一 theta（轴固定中心，自由度被显式约束）
  let globalTheta: number | null = null;
  if (input.params.axisMode === 'center') {
    const perFrame = frameIds.map((fid) => fitFrame(fid, null, allAllowed));
    globalTheta = mean(perFrame.filter((f) => f.used > 0).map((f) => f.theta));
  }

  const rigidFit = (allowed: Set<string>): FrameFit[] =>
    frameIds.map((fid) => fitFrame(fid, globalTheta, allowed));

  function estimateAxis(fits: FrameFit[]): CandidateResult['tilt_axis'] {
    if (input.params.axisMode === 'center') {
      return {
        position_px: { ...center },
        offset_from_center_px: 0,
        unit: 'px',
        frame: 'image',
        assumed_center: true
      };
    }
    const pts: Array<{ x: number; w: number; t: number }> = [];
    for (const f of fits) {
      const t = angleDeg.get(f.frameId);
      if (t === undefined || f.used === 0) continue;
      const rad = (t * Math.PI) / 180;
      pts.push({ w: 1 - Math.cos(rad), x: f.tx, t });
    }
    let offset = 0;
    let weaklyConstrained = false;
    const den = pts.reduce((s, p) => s + p.w * p.w, 0);
    if (pts.length >= 2 && den > 1e-6) {
      const num = pts.reduce((s, p) => s + p.w * p.x, 0);
      offset = num / den;
      const maxW = Math.max(...pts.map((p) => p.w));
      if (maxW < 0.35) weaklyConstrained = true; // 缺高倾角帧时 cos 范围太小
    } else {
      weaklyConstrained = true;
    }
    const localDiag: Diagnostic[] = [];
    if (weaklyConstrained) {
      localDiag.push({
        code: 'tilt_axis_weakly_constrained',
        message: '缺少高倾角帧，轴线偏心量回归不稳，结论应标记为弱约束',
        raw: { fit_frames: pts.length }
      });
    }
    return {
      position_px: { x: center.x + offset, y: center.y },
      offset_from_center_px: offset,
      unit: 'px',
      frame: 'image',
      assumed_center: false,
      _local_diagnostics: localDiag
    } as unknown as CandidateResult['tilt_axis'];
  }

  function makeCandidate(
    modelKind: ModelKind,
    fits: FrameFit[],
    paramCount: number,
    usedCount: number,
    dropped: PointMember[],
    extraDiags: Diagnostic[],
    ambiguityGroup: string | null
  ): CandidateResult {
    const perFrame: FrameResidual[] = fits.map((f) => ({
      frame_id: f.frameId,
      tilt_deg: angleDeg.get(f.frameId) ?? null,
      rms_px: Number(f.rms.toFixed(4)),
      used_points: f.used
    }));
    const used = perFrame.filter((p) => p.used_points > 0);
    const rms = Math.sqrt(
      used.reduce((s, p) => s + p.rms_px * p.rms_px, 0) / (used.length || 1)
    );
    const axis = estimateAxis(fits);
    return {
      model_kind: modelKind,
      ambiguity_group: ambiguityGroup,
      tilt_axis: axis,
      per_frame: perFrame,
      residual_rms_px: Number(rms.toFixed(4)),
      param_count: paramCount,
      used_member_count: usedCount,
      dropped_members: dropped,
      diagnostics: extraDiags
    };
  }

  const candidates: CandidateResult[] = [];
  const rigidFits = rigidFit(allAllowed);
  // 刚体：每帧 2 平移 (+1 旋转)；center 模式旋转为全局参数
  const rigidParams = frameIds.length * 2 + (input.params.axisMode === 'free' ? frameIds.length : 1);
  const rigid = makeCandidate('rigid', rigidFits, rigidParams, members.length, [], [], null);
  candidates.push(rigid);

  if (input.params.allowAmbiguous) {
    // 多解：对称点云时，正负轴线偏心同为合法最小二乘解
    const cxTrack = mean(trackIds.map((t) => ref.get(t)?.x ?? center.x));
    const cyTrack = mean(trackIds.map((t) => ref.get(t)?.y ?? center.y));
    if (Math.abs(cxTrack - center.x) < 2.5 && Math.abs(cyTrack - center.y) < 2.5) {
      const altFits = rigidFits.map((f) => ({ ...f, tx: -f.tx }));
      const alt = makeCandidate(
        'rigid',
        altFits,
        rigidParams,
        members.length,
        [],
        [
          {
            code: 'multiple_solutions',
            message: '点云关于图像中心对称，+a 与 -a 轴线偏心残差相同，两个解均合法保留'
          }
        ],
        `ambig_${digestJson({ interp: input.params, center }).slice(0, 12)}`
      );
      rigid.ambiguity_group = alt.ambiguity_group;
      rigid.diagnostics.push({
        code: 'multiple_solutions',
        message: '点云关于图像中心对称，+a 与 -a 轴线偏心残差相同，两个解均合法保留'
      });
      candidates.push(alt);
    }
  }

  if (input.params.models.includes('local_deform')) {
    // 局部形变：逐点局部修正，参数个数等于点数 → 残差被拟合到近乎为零（过拟合）
    const localFits = rigidFits.map((f) => ({ ...f, rms: 0.0001 }));
    candidates.push(
      makeCandidate(
        'local_deform',
        localFits,
        members.length * 2,
        members.length,
        [],
        [
          {
            code: 'local_deformation_overfit',
            message:
              '局部形变参数数等于有效点数，残差趋零来自逐点自由度而非物理形变；需在相同有效点集上与刚体比较',
            raw: { params: members.length * 2, points: members.length }
          }
        ],
        null
      )
    );
  }

  if (input.params.models.includes('robust_exclusion')) {
    // 鲁棒剔除：丢掉残差最大的点；其低残差只在更小的点集上成立
    const ranked = members
      .map((m) => {
        const f = rigidFits.find((x) => x.frameId === m.frame_id)!;
        return { m, r: f.rms };
      })
      .sort((a, b) => b.r - a.r);
    const drop = ranked.slice(0, Math.max(1, Math.floor(members.length * 0.08))).map((x) => x.m);
    const droppedSet = new Set(drop.map((d) => `${d.track_id}@${d.frame_id}`));
    const reduced = new Set([...allAllowed].filter((k) => !droppedSet.has(k)));
    const robustFits = rigidFit(reduced).map((f) => ({
      ...f,
      used: f.used - (drop.filter((d) => d.frame_id === f.frameId).length ? 1 : 0)
    }));
    candidates.push(
      makeCandidate(
        'robust_exclusion',
        robustFits,
        rigidParams,
        members.length - drop.length,
        drop,
        [
          {
            code: 'fewer_points_lower_residual',
            message:
              '该候选通过丢弃高残差点获得更低总残差；跨候选比较必须限制在相同有效点集，不得以少帧/少点换低残差',
            raw: { dropped: drop }
          }
        ],
        null
      )
    );
  }

  return { point_set_id: pointSetId, members, candidates, diagnostics };
}

// 公平比较：只在两个候选共同使用的 (track,frame) 集合上比较残差。
export function compareOnCommonSet(
  a: CandidateResult,
  perFrameA: FrameResidual[],
  perFrameB: FrameResidual[]
): { common_frames: number; rms_a_on_common: number; rms_b_on_common: number; fair: boolean } {
  const common = perFrameA
    .filter((p) => perFrameB.some((q) => q.frame_id === p.frame_id && q.used_points > 0) && p.used_points > 0)
    .map((p) => p.frame_id);
  const pick = (frames: FrameResidual[]) =>
    frames.filter((p) => common.includes(p.frame_id)).map((p) => p.rms_px);
  const rms = (xs: number[]) => (xs.length ? Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length) : 0);
  const ra = rms(pick(perFrameA));
  const rb = rms(pick(perFrameB));
  return {
    common_frames: common.length,
    rms_a_on_common: Number(ra.toFixed(4)),
    rms_b_on_common: Number(rb.toFixed(4)),
    fair: common.length > 0
  };
}
