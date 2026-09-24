import type {
  AffineTransform, EffectivePoint, FiducialSegment, FiducialTrack,
  FrameResidual, PixelPoint, RegistrationCandidate, RegistrationParams,
  TiltSeriesInput
} from '../shared/types.js';
import { applyAffine, dist, fitAffine, fitSimilarity, identity, rms } from './geometry.js';
import { canonicalJson, round, structuralId } from '../shared/ids.js';

export const DEFAULT_RULES_VERSION = 'rules-v1';

export interface AlignmentOptions {
  rulesVersion?: string;
  holdoutTrackIds?: string[];
  ambiguityTolerancePx?: number;
  dofPenalty?: number;
  warpDof?: number;
}

type Assignment = Record<string, string>; // segmentId -> trackId

// 枚举关联假设：含 candidateIdentity 的断裂段可能身份交换，保留全部合法关联
export function enumerateAssociations(fiducials: FiducialTrack[]): Assignment[] {
  const groups: { segment: FiducialSegment; candidateTrackIds: string[] }[][] = [];
  const fixed = new Map<string, string>();
  for (const track of fiducials) {
    for (const seg of track.segments) {
      if (seg.candidateIdentity) {
        let bucket = groups.find((g) =>
          g.some((entry) => entry.candidateTrackIds.includes(seg.candidateIdentity!)));
        if (!bucket) { bucket = []; groups.push(bucket); }
        const candidateTrackIds = Array.from(new Set(
          fiducials
            .flatMap((t) => t.segments)
            .filter((s) => s.candidateIdentity === seg.candidateIdentity)
            .map(() => track.trackId)
        ));
        bucket.push({ segment: seg, candidateTrackIds: dedupe(candidateTrackIds.concat(track.trackId)) });
      } else {
        fixed.set(seg.segmentId, track.trackId);
      }
    }
  }
  const ambiguous = groups.filter((g) => g.length > 1);
  let assignments: Assignment[] = [{ ...Object.fromEntries(fixed) }];
  for (const group of ambiguous) {
    const next: Assignment[] = [];
    const permutations = permute(group.map((g) => g.candidateTrackIds));
    for (const base of assignments) {
      for (const perm of permutations) {
        const cand: Assignment = { ...base };
        group.forEach((entry, i) => { cand[entry.segment.segmentId] = perm[i]; });
        next.push(cand);
      }
    }
    assignments = next;
  }
  return dedupeAssignments(assignments);
}

function dedupe<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }
function permute<T>(input: T[][]): T[][] {
  // 每组各取一个，并要求本组取值互不相同（一一对应）
  const result: T[][] = [];
  const chosen: T[] = [];
  const used = new Set<T>();
  const recurse = (idx: number) => {
    if (idx === input.length) { result.push([...chosen]); return; }
    for (const opt of input[idx]) {
      if (used.has(opt)) continue;
      used.add(opt); chosen.push(opt);
      recurse(idx + 1);
      chosen.pop(); used.delete(opt);
    }
  };
  recurse(0);
  return result;
}
function dedupeAssignments(a: Assignment[]): Assignment[] {
  const seen = new Set<string>();
  const out: Assignment[] = [];
  for (const assn of a) {
    const key = canonicalJson(assn);
    if (!seen.has(key)) { seen.add(key); out.push(assn); }
  }
  return out;
}

interface FrameObs { frameId: string; trackId: string; point: PixelPoint }

function observationsFor(
  input: TiltSeriesInput, assignment: Assignment
): FrameObs[] {
  const obs: FrameObs[] = [];
  for (const track of input.fiducials) {
    for (const seg of track.segments) {
      const assignedTrackId = assignment[seg.segmentId] ?? track.trackId;
      for (const o of seg.observations) {
        obs.push({ frameId: o.frameId, trackId: assignedTrackId, point: o.point.raw });
      }
    }
  }
  return obs;
}

function presentFrameIds(input: TiltSeriesInput): Set<string> {
  return new Set(input.frames.filter((f) => f.raw).map((f) => f.frameId));
}
function excludedByHand(input: TiltSeriesInput): Set<string> {
  return new Set(
    input.exclusions.filter((e) => e.kind === 'bad-frame').map((e) => e.frameId)
  );
}

function referenceFrameId(input: TiltSeriesInput): string {
  const present = input.frames.filter((f) => f.raw);
  return present.reduce((best, f) =>
    Math.abs(deg(f.exposure.tilt)) < Math.abs(deg(best.exposure.tilt)) ? f : best
  ).frameId;
}
function deg(t: { raw: number; unit: string }): number {
  return t.unit === 'radian' ? (t.raw * 180) / Math.PI : t.raw;
}

interface FitResult {
  perFrame: FrameResidual[];
  transforms: Record<string, AffineTransform>;
  rmsUsed: number;
}

function fitOne(
  input: TiltSeriesInput,
  obs: FrameObs[],
  params: RegistrationParams
): FitResult {
  const present = presentFrameIds(input);
  const hand = excludedByHand(input);
  const extra = new Set(params.extraExcludedFrameIds);
  const holdout = new Set(params.holdoutTrackIds);
  const refId = referenceFrameId(input);
  const byFrame = new Map<string, FrameObs[]>();
  for (const o of obs) {
    if (!byFrame.has(o.frameId)) byFrame.set(o.frameId, []);
    byFrame.get(o.frameId)!.push(o);
  }
  const refObs = (byFrame.get(refId) ?? []).filter((o) => !holdout.has(o.trackId));
  const refPos = new Map(refObs.map((o) => [o.trackId, o.point]));

  const perFrame: FrameResidual[] = [];
  const transforms: Record<string, AffineTransform> = {};
  const usedResiduals: number[] = [];

  for (const frame of input.frames) {
    const fid = frame.frameId;
    const frameObs = (byFrame.get(fid) ?? []);
    if (!present.has(fid)) {
      perFrame.push({ frameId: fid, rms: 0, usedPoints: 0, role: 'not-present' });
      continue;
    }
    if (fid === refId) {
      transforms[fid] = identity();
      perFrame.push({ frameId: fid, rms: 0, usedPoints: frameObs.length, role: 'reference' });
      continue;
    }
    if (params.fitScheme === 'badframe-excluded' && (hand.has(fid) || extra.has(fid))) {
      perFrame.push({ frameId: fid, rms: NaN, usedPoints: 0, role: 'excluded' });
      continue;
    }
    const train = frameObs
      .filter((o) => !holdout.has(o.trackId))
      .filter((o) => refPos.has(o.trackId))
      .map((o) => ({ src: o.point, dst: refPos.get(o.trackId)! }));
    let transform: AffineTransform;
    if (train.length >= 3 && params.fitScheme === 'local-warp') {
      transform = fitAffine(train);
    } else if (train.length >= 2) {
      transform = fitSimilarity(train);
    } else {
      transform = identity();
    }
    if (params.fitScheme === 'center-assumed-axis') {
      // 错误方案：强制轴线穿过图像中心（忽略偏心），表现为去掉平移项
      transform = { ...transform, tx: 0, ty: 0 };
    }
    transforms[fid] = transform;
    const all = frameObs.filter((o) => refPos.has(o.trackId));
    const residuals = all.map((o) => dist(applyAffine(transform, o.point), refPos.get(o.trackId)!));
    const frameRms = rms(residuals);
    if (params.fitScheme !== 'badframe-excluded' || !(hand.has(fid) || extra.has(fid))) {
      usedResiduals.push(...residuals);
    }
    perFrame.push({ frameId: fid, rms: round(frameRms), usedPoints: all.length, role: 'fitted' });
  }
  return { perFrame, transforms, rmsUsed: round(rms(usedResiduals)) };
}

interface BuiltScheme {
  scheme: RegistrationParams['fitScheme'];
  params: RegistrationParams;
  fit: FitResult;
  holdoutRms: number | null;
  effective: EffectivePoint[];
  excluded: string[];
  diagnostics: string[];
}

function buildScheme(
  input: TiltSeriesInput,
  obs: FrameObs[],
  scheme: RegistrationParams['fitScheme'],
  opt: AlignmentOptions
): BuiltScheme {
  const present = presentFrameIds(input);
  const hand = excludedByHand(input);
  const params: RegistrationParams = {
    rulesVersion: opt.rulesVersion ?? DEFAULT_RULES_VERSION,
    fitScheme: scheme,
    holdoutTrackIds: opt.holdoutTrackIds ?? [],
    extraExcludedFrameIds: [],
    warpDegreesOfFreedom: scheme === 'local-warp' ? (opt.warpDof ?? 6) : 4,
    ambiguityTolerancePx: opt.ambiguityTolerancePx ?? 0.5,
    dofPenalty: opt.dofPenalty ?? 0.0,
    centerAssumed: scheme === 'center-assumed-axis'
  };
  const fit = fitOne(input, obs, params);
  const refId = referenceFrameId(input);
  const byFrame = new Map<string, FrameObs[]>();
  for (const o of obs) {
    if (!byFrame.has(o.frameId)) byFrame.set(o.frameId, []);
    byFrame.get(o.frameId)!.push(o);
  }
  const refPos = new Map((byFrame.get(refId) ?? []).map((o) => [o.trackId, o.point]));
  const holdoutSet = new Set(params.holdoutTrackIds);
  const holdoutRes: number[] = [];
  const effective: EffectivePoint[] = [];
  for (const [frameId, list] of byFrame) {
    if (!present.has(frameId)) continue;
    for (const o of list) {
      const q = refPos.get(o.trackId);
      if (!q) continue;
      effective.push({ frameId, trackId: o.trackId, p: o.point, q });
      if (holdoutSet.has(o.trackId) && fit.transforms[frameId]) {
        holdoutRes.push(dist(applyAffine(fit.transforms[frameId], o.point), q));
      }
    }
  }
  effective.sort((x, y) =>
    x.frameId.localeCompare(y.frameId) || x.trackId.localeCompare(y.trackId));
  const excluded = input.frames
    .filter((f) => scheme === 'badframe-excluded' && hand.has(f.frameId))
    .map((f) => f.frameId);
  const diagnostics: string[] = [];
  if (scheme === 'center-assumed-axis' && !input.axis.centerAssumed) {
    diagnostics.push(
      'tilt axis is eccentric: fixing it at image center discards the measured offset'
    );
  }
  if (scheme === 'local-warp') {
    diagnostics.push('high-DoF local warp can fit noise; check held-out residual');
  }
  return {
    scheme, params, fit,
    holdoutRms: holdoutRes.length ? round(rms(holdoutRes)) : null,
    effective, excluded, diagnostics
  };
}

// 计算每个候选在“共同有效点集”上的 RMS；被排除帧用全局刚体基线变换补回，
// 从而禁止“用少帧换低残差”。
function fairCommonRms(
  input: TiltSeriesInput,
  obs: FrameObs[],
  built: BuiltScheme,
  commonKeys: Set<string>
): number {
  const present = presentFrameIds(input);
  const refId = referenceFrameId(input);
  const byFrame = new Map<string, FrameObs[]>();
  for (const o of obs) {
    if (!byFrame.has(o.frameId)) byFrame.set(o.frameId, []);
    byFrame.get(o.frameId)!.push(o);
  }
  const refPos = new Map((byFrame.get(refId) ?? []).map((o) => [o.trackId, o.point]));

  // 全局刚体基线（含被排除帧、含 holdout 轨迹），被排除帧用它补回以公平计分
  const baseline = new Map<string, AffineTransform>();
  for (const frame of input.frames) {
    const fid = frame.frameId;
    if (!present.has(fid) || fid === refId) continue;
    const pairs = (byFrame.get(fid) ?? [])
      .filter((o) => refPos.has(o.trackId))
      .map((o) => ({ src: o.point, dst: refPos.get(o.trackId)! }));
    baseline.set(fid, pairs.length >= 2 ? fitSimilarity(pairs) : identity());
  }

  const residuals: number[] = [];
  for (const key of commonKeys) {
    const [frameId, trackId] = key.split('|');
    const o = (byFrame.get(frameId) ?? []).find((x) => x.trackId === trackId);
    const q = refPos.get(trackId);
    if (!o || !q) continue;
    const role = built.fit.perFrame.find((pr) => pr.frameId === frameId)?.role;
    const transform = role === 'excluded' || !built.fit.transforms[frameId]
      ? (baseline.get(frameId) ?? identity())
      : built.fit.transforms[frameId];
    residuals.push(dist(applyAffine(transform, o.point), q));
  }
  return round(rms(residuals));
}

const SCHEMES: RegistrationParams['fitScheme'][] = [
  'rigid', 'local-warp', 'badframe-excluded', 'center-assumed-axis'
];

export function buildCandidates(
  input: TiltSeriesInput,
  opt: AlignmentOptions = {}
): RegistrationCandidate[] {
  const assignments = enumerateAssociations(input.fiducials);
  const built: { scheme: BuiltScheme; obs: FrameObs[] }[] = [];
  for (const assn of assignments) {
    const obs = observationsFor(input, assn);
    for (const scheme of SCHEMES) {
      built.push({ scheme: buildScheme(input, obs, scheme, opt), obs });
    }
  }

  // 共同有效点集键：取所有候选的并集键（身份交换后键随 trackId 变化），再逐个公平评分
  const allKeys = new Set<string>();
  for (const b of built) for (const e of b.scheme.effective) allKeys.add(`${e.frameId}|${e.trackId}`);
  const commonSetId = structuralId('effset', {
    keys: Array.from(allKeys).sort(), scheme: 'common-union-keys'
  });

  const candidates = built.map(({ scheme: b, obs }) => {
    const fairRms = fairCommonRms(input, obs, b, allKeys);
    const axisPenalty = b.scheme === 'center-assumed-axis'
      ? round(Math.hypot(input.axis.offsetPx.dx, input.axis.offsetPx.dy) * 0.1)
      : 0;
    const dofPenalty = round((b.params.warpDegreesOfFreedom - 4) * (opt.dofPenalty ?? 0.0));
    const holdoutPenalty = b.holdoutRms != null ? b.holdoutRms : 0;
    const score = round(
      fairRms + dofPenalty + axisPenalty + holdoutPenalty,
      6
    );
    const effectiveSetId = structuralId('effset', {
      keys: b.effective.map((e) => `${e.frameId}|${e.trackId}`).sort()
    });
    const candidateId = structuralId('cand', {
      scheme: b.scheme,
      params: {
        rules: b.params.rulesVersion,
        holdout: b.params.holdoutTrackIds,
        tol: b.params.ambiguityTolerancePx,
        center: b.params.centerAssumed
      },
      effective: effectiveSetId,
      transforms: Object.fromEntries(Object.entries(b.fit.transforms)
        .map(([k, v]) => [k, Object.values(v).map((n) => round(n, 4))]))
    });
    return {
      candidateId,
      scheme: b.scheme,
      params: b.params,
      axisId: input.axis.axisId,
      effectiveSetId: fair.commonSetId,
      effectiveSet: b.effective,
      commonSetRms: fairRms,
      trainRms: b.fit.rmsUsed,
      holdoutRms: b.holdoutRms,
      dofPenalty,
      score,
      axisPenalty,
      excludedFrameIds: b.excluded,
      perFrame: b.fit.perFrame,
      transforms: b.fit.transforms,
      diagnostics: b.diagnostics
    } as RegistrationCandidate;
  });

  // 多解检测：同 scheme、相同有效点集、分数在容差内的不同变换 => 全部保留并互相链接
  const tolPx = opt.ambiguityTolerancePx ?? 0.5;
  for (let i = 0; i < candidates.length; i++) {
    const ties: string[] = [];
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const a = candidates[i]; const b = candidates[j];
      if (a.scheme !== b.scheme) continue;
      if (a.effectiveSetId !== b.effectiveSetId) continue;
      if (Math.abs(a.score - b.score) <= tolPx && a.candidateId !== b.candidateId) {
        ties.push(b.candidateId);
      }
    }
    if (ties.length) candidates[i].ambiguousWith = dedupe(ties);
  }
  // 去重（不同关联假设可能产生同一确定性变换）
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.candidateId)) return false;
    seen.add(c.candidateId);
    return true;
  }).sort((a, b) => a.score - b.score);
}

export function recommendedCandidate(cands: RegistrationCandidate[]): RegistrationCandidate {
  // 不自动替审阅者裁定多解；仅在无歧义候选中给最低分者排序，UI 仍需人工锁定
  return cands.slice().sort((a, b) => a.score - b.score)[0];
}
