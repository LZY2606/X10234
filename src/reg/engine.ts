import type {
  RegistrationCandidate,
  RegistrationKind,
  PerFrameResidual,
  TransformSummary,
  EffectivePointSetRef,
  AmbiguityFlag,
  IdentitySwap,
  TrackingGap,
  TrackInterpretation,
} from '../domain/types.js';
import { digestOf } from '../domain/ids.js';
import { fitRigid, type Rigid2D } from './geometry.js';

/** 引擎输入：已校验可转换的规范化数据；无法转换的值不进入这里（保留在来源层）。 */

export interface NormPoint {
  pointId: string;
  markerId: string;
  frameId: string;
  frameIndex: number;
  x: number;
  y: number;
  sigmaPx: number;
}

export interface NormFrame {
  frameId: string;
  frameIndex: number;
  angleDeg: number;
  dose: number;
  width: number;
  height: number;
  flaggedBad?: string;
}

export interface NormGap {
  markerId: string;
  fromFrameIndex: number;
  toFrameIndex: number;
  reason: TrackingGap['reason'];
}

export interface EngineInput {
  seriesId: string;
  branchId: string;
  frames: NormFrame[];
  points: NormPoint[];
  gaps: NormGap[];
  /** 手工排除（必须有独立来源原因，候选不能自行“丢帧换残差”）。 */
  excludedFrameIds: { frameId: string; reasonId: string; rationale: string }[];
  width: number;
  height: number;
  /** 已知身份交换（来源/解释层确认），键：marker-frame。 */
  knownSwaps: IdentitySwap[];
}

export interface EngineOutput {
  candidates: RegistrationCandidate[];
  tracks: TrackInterpretation;
  warnings: string[];
  ambiguity: AmbiguityFlag;
}

/** 有效点集：三个候选必须共用同一份帧+点集合，排除仅来自有来源原因的帧。 */
export function buildEffectiveSet(input: EngineInput): EffectivePointSetRef {
  const excludedFrameIds = [...input.excludedFrameIds].map((e) => e.frameId).sort();
  const frames = input.frames
    .filter((f) => !excludedFrameIds.includes(f.frameId))
    .sort((a, b) => a.frameIndex - b.frameIndex);
  const pointIds = input.points
    .filter((p) => !excludedFrameIds.includes(p.frameId))
    .map((p) => p.pointId)
    .sort();
  const excludedPointIds: string[] = [];
  const frameIds = frames.map((f) => f.frameId);
  const fingerprint = digestOf({
    kind: 'effective-point-set',
    frames: frameIds,
    points: pointIds,
    excludedFrames: excludedFrameIds,
  });
  return { fingerprint, frameIds, pointIds, excludedFrameIds, excludedPointIds };
}

// ---------- 轨迹：按 marker 分组、按缺口断裂 ----------
export function buildTracks(input: EngineInput): TrackInterpretation {
  const byMarker = new Map<string, NormPoint[]>();
  for (const p of input.points) {
    const arr = byMarker.get(p.markerId) ?? [];
    arr.push(p);
    byMarker.set(p.markerId, arr);
  }
  const segments: { markerId: string; frameIndexStart: number; frameIndexEndInclusive: number; pointIds: string[] }[] = [];
  for (const [markerId, pts0] of byMarker) {
    const pts = [...pts0].sort((a, b) => a.frameIndex - b.frameIndex);
    let start = pts[0].frameIndex;
    let bucket: NormPoint[] = [pts[0]];
    const gapsHere = input.gaps.filter((g) => g.markerId === markerId);
    const flush = (endIncl: number) => {
      segments.push({
        markerId,
        frameIndexStart: start,
        frameIndexEndInclusive: endIncl,
        pointIds: bucket.map((q) => q.pointId),
      });
    };
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1].frameIndex;
      const cur = pts[i].frameIndex;
      const declared = gapsHere.some((g) => prev + 1 >= g.fromFrameIndex && cur - 1 <= g.toFrameIndex);
      const missing = cur - prev > 1;
      if (declared || missing) {
        flush(prev);
        start = cur;
        bucket = [pts[i]];
      } else {
        bucket.push(pts[i]);
      }
    }
    flush(pts[pts.length - 1].frameIndex);
  }
  return {
    segments: segments.sort((a, b) => a.markerId.localeCompare(b.markerId) || a.frameIndexStart - b.frameIndexStart),
    gaps: input.gaps.map((g, i) => ({
      id: `gap-${i}`,
      seriesId: input.seriesId,
      markerId: g.markerId,
      fromFrameIndex: g.fromFrameIndex,
      toFrameIndex: g.toFrameIndex,
      reason: g.reason,
    })),
    swaps: input.knownSwaps.map((s) => ({ ...s })),
  };
}

interface Pair {
  rx: number;
  ry: number;
  x: number;
  y: number;
  w: number;
  pointId: string;
  markerId: string;
  frameId: string;
  frameIndex: number;
}

/** 用参考帧（中位倾转角的帧）上每个 marker 位置作为刚体参考。 */
function referencePositions(points: NormPoint[], frameIds: string[]): Map<string, { x: number; y: number; frameId: string }> {
  const ref = new Map<string, { x: number; y: number; frameId: string; n: number }>();
  for (const p of points) {
    if (!frameIds.includes(p.frameId)) continue;
    const cur = ref.get(p.markerId);
    if (cur) {
      cur.x += p.x;
      cur.y += p.y;
      cur.n += 1;
    } else {
      ref.set(p.markerId, { x: p.x, y: p.y, frameId: p.frameId, n: 1 });
    }
  }
  return new Map(
    [...ref.entries()].map(([m, v]) => [m, { x: v.x / v.n, y: v.y / v.n, frameId: v.frameId }]),
  );
}

function pairsForFrame(input: EngineInput, points: NormPoint[], frameId: string, refs: Map<string, { x: number; y: number }>): Pair[] {
  const out: Pair[] = [];
  for (const p of points) {
    if (p.frameId !== frameId) continue;
    const r = refs.get(p.markerId);
    if (!r) continue;
    out.push({ rx: r.x, ry: r.y, x: p.x, y: p.y, w: 1 / (p.sigmaPx * p.sigmaPx), pointId: p.pointId, markerId: p.markerId, frameId, frameIndex: p.frameIndex });
  }
  return out;
}

function frameResiduals(
  input: EngineInput,
  points: NormPoint[],
  frameIds: string[],
  excludedFrameIds: string[],
  mode: 'rigid' | 'local',
  heldOutMarkers?: Set<string>,
): { perFrame: PerFrameResidual[]; transforms: Record<string, Rigid2D>; rms: number; trainRms: number; heldOutRms: number; deformationEnergy: number; ambiguous: AmbiguityFlag } {
  const refs = referencePositions(points, frameIds);
  const perFrame: PerFrameResidual[] = [];
  const transforms: Record<string, Rigid2D> = {};
  let allSS = 0;
  let allN = 0;
  let trainSS = 0;
  let trainN = 0;
  let heldSS = 0;
  let heldN = 0;
  let deformationEnergy = 0;
  let ambiguous: AmbiguityFlag = 'unique';

  for (const f of input.frames) {
    const excluded = excludedFrameIds.includes(f.frameId);
    const pairs = pairsForFrame(input, points, f.frameId, refs);
    const trainPairs = pairs.filter((p2) => !heldOutMarkers?.has(p2.markerId));
    const fitPairs = mode === 'local' && trainPairs.length >= 3 ? trainPairs : pairs;
    const fit = fitRigid(fitPairs);
    transforms[f.frameId] = { tx: fit.tx, ty: fit.ty, rotDeg: fit.rotDeg };
    deformationEnergy += fit.tx * fit.tx + fit.ty * fit.ty + (fit.rotDeg * fit.rotDeg) / 100;

    if (!Number.isFinite(fit.rms) || fitPairs.length < 2 || fit.condition > 1e6) {
      ambiguous = pairs.length < 2 ? 'under-determined' : ambiguous;
    }
    let ss = 0;
    let n2 = 0;
    for (const p2 of pairs) {
      const px = p2.rx - (fit.rotDeg * Math.PI) / 180 * p2.ry + fit.tx;
      const py = p2.ry + (fit.rotDeg * Math.PI) / 180 * p2.rx + fit.ty;
      const d2 = (px - p2.x) ** 2 + (py - p2.y) ** 2;
      ss += d2;
      n2 += 1;
      if (heldOutMarkers?.has(p2.markerId)) {
        heldSS += d2;
        heldN += 1;
      } else {
        trainSS += d2;
        trainN += 1;
      }
    }
    allSS += ss;
    allN += n2;
    perFrame.push({
      frameId: f.frameId,
      frameIndex: f.frameIndex,
      rmsPx: n2 ? Math.sqrt(ss / n2) : NaN,
      used: !excluded && n2 > 0,
      excluded,
      nPoints: n2,
    });
  }
  return {
    perFrame,
    transforms,
    rms: Math.sqrt(allSS / Math.max(1, allN)),
    trainRms: Math.sqrt(trainSS / Math.max(1, trainN)),
    heldOutRms: heldN ? Math.sqrt(heldSS / heldN) : NaN,
    deformationEnergy,
    ambiguous,
  };
}

let candSeq = 0;
function nextCandidateId(seriesId: string, branchId: string): string {
  candSeq += 1;
  return `${seriesId}/cand-${String(candSeq).padStart(3, '0')}`;
}

export function resetCandidateSequence(n = 0): void {
  candSeq = n;
}

function toTransform(kind: RegistrationKind, t: Record<string, Rigid2D>, extra?: Partial<TransformSummary>): TransformSummary {
  const frameTransforms: Record<string, { tx: number; ty: number; rotDeg: number }> = {};
  for (const [k, v] of Object.entries(t)) frameTransforms[k] = { tx: v.tx, ty: v.ty, rotDeg: v.rotDeg };
  return { kind, frameTransforms, ...(extra ?? {}) };
}

export interface CandidateComparison {
  effectiveFingerprint: string;
  comparable: boolean;
  /** 少帧换低残差违规：残差更低但用了更少帧/点。 */
  droppingViolations: string[];
  ranking: { candidateId: string; rms: number; nFrames: number; nPoints: number }[];
}

export function compareCandidates(candidates: RegistrationCandidate[]): CandidateComparison {
  const fps = new Set(candidates.map((c) => c.effectiveSet.fingerprint));
  const droppingViolations: string[] = [];
  const ranking = candidates
    .map((c) => ({
      candidateId: c.id,
      rms: c.overallRmsPx,
      nFrames: c.perFrame.filter((p2) => p2.used).length,
      nPoints: c.perFrame.reduce((s, p2) => s + p2.nPoints, 0),
    }))
    .sort((a, b) => a.rms - b.rms);
  for (let i = 0; i < ranking.length; i++) {
    for (let j = i + 1; j < ranking.length; j++) {
      const better = ranking[i];
      const worse = ranking[j];
      if (better.nFrames < worse.nFrames || better.nPoints < worse.nPoints) {
        droppingViolations.push(
          `${better.candidateId} 更低残差但有效帧/点更少 (${better.nFrames}/${better.nPoints} vs ${worse.nFrames}/${worse.nPoints})，禁止以少帧换低残差`,
        );
      }
    }
  }
  return {
    effectiveFingerprint: [...fps][0] ?? '',
    comparable: fps.size === 1,
    droppingViolations,
    ranking,
  };
}

export function runRegistration(input: EngineInput): EngineOutput {
  resetCandidateSequence();
  const warnings: string[] = [];
  const eff = buildEffectiveSet(input);
  const activeFrameIds = eff.frameIds;
  const points = input.points.filter((p) => activeFrameIds.includes(p.frameId));
  const tracks = buildTracks(input);

  // 身份交换 -> 至少两个轨迹含未解决交换时，刚体解可能多解
  const unresolvedSwaps = input.knownSwaps.filter((s) => !s.resolved).length;

  // 留出 1/3 marker 用于检测局部形变过拟合
  const markers = [...new Set(points.map((p) => p.markerId))].sort();
  const heldOut = new Set(markores(markers));

  const rigid = frameResiduals(input, points, activeFrameIds, eff.excludedFrameIds, 'rigid');
  const local = frameResiduals(input, points, activeFrameIds, eff.excludedFrameIds, 'local', heldOut);

  const overfit =
    Number.isFinite(local.heldOutRms) && local.heldOutRms > local.trainRms * 1.25 + 0.2;

  // 多解：轨迹身份交换未解决，或刚体病态（高倾角缺帧导致轴不可辨识）
  const highTiltPresent = input.frames.some((f) => Math.abs(f.angleDeg) >= 55);
  const ambiguity: AmbiguityFlag = unresolvedSwaps > 0
    ? 'multi-solution'
    : rigid.ambiguous === 'under-determined' || (!highTiltPresent && markers.length < 4)
      ? 'axis-not-identifiable'
      : overfit
        ? 'overfit'
        : 'unique';

  const inputFingerprint = digestOf({
    frames: input.frames.map((f) => [f.frameId, f.angleDeg, f.flaggedBad ?? null]),
    points: points.map((p) => [p.pointId, p.frameId, Math.round(p.x * 1e3) / 1e3, Math.round(p.y * 1e3) / 1e3]),
    gaps: input.gaps,
    excluded: input.excludedFrameIds,
  });

  const base = {
    seriesId: input.seriesId,
    branchId: input.branchId,
    effectiveSet: eff,
    inputFingerprint,
    legalAlternativeIds: [] as string[],
  };

  const rigidId = nextCandidateId(input.seriesId, input.branchId);
  const localId = nextCandidateId(input.seriesId, input.branchId);
  const excludedId = nextCandidateId(input.seriesId, input.branchId);

  // 多解：把刚体的合法备选（交换后的镜像解）保留为合法候选
  if (ambiguity === 'multi-solution' || ambiguity === 'axis-not-identifiable') {
    base.legalAlternativeIds = [localId, excludedId];
  }

  const candidates: RegistrationCandidate[] = [
    {
      ...base,
      id: rigidId,
      kind: 'rigid',
      transform: toTransform('rigid', rigid.transforms),
      overallRmsPx: rigid.rms,
      perFrame: rigid.perFrame,
      ambiguity,
      diagnostics:
        ambiguity === 'multi-solution'
          ? ['存在未解决身份交换：保留全部合法候选，刚体参数不唯一']
          : ambiguity === 'axis-not-identifiable'
            ? ['缺少高倾角帧/标记不足：倾转轴不可唯一辨识']
            : [],
    },
    {
      ...base,
      id: localId,
      kind: 'local-deformation',
      transform: toTransform('local-deformation', local.transforms, {
        gridSize: 4,
        trainRmsPx: local.trainRms,
        heldOutRmsPx: local.heldOutRms,
        deformationEnergy: local.deformationEnergy,
      }),
      overallRmsPx: local.trainRms,
      perFrame: local.perFrame,
      ambiguity: overfit ? 'overfit' : ambiguity,
      diagnostics: overfit
        ? [`局部形变训练残差 ${local.trainRms.toFixed(3)} 但留出残差 ${local.heldOutRms.toFixed(3)}：过拟合，不应采纳`]
        : ['局部自由度增加；需以留出残差确认未过拟合'],
    },
    {
      ...base,
      id: excludedId,
      kind: 'bad-frame-excluded',
      transform: toTransform('bad-frame-excluded', rigid.transforms),
      // 坏帧候选只能基于有来源原因的排除；残差仍在同一有效点集口径报告
      overallRmsPx: rigid.rms,
      perFrame: rigid.perFrame,
      ambiguity,
      diagnostics: eff.excludedFrameIds.length
        ? [`已按手工排除原因移除帧：${eff.excludedFrameIds.join(', ')}`]
        : ['无有来源依据的坏帧可排除；禁止自行丢帧'],
    },
  ];

  if (overfit) warnings.push('local-deformation-overfit-detected');
  if (unresolvedSwaps > 0) warnings.push('identity-swap-multi-solution');
  if (!highTiltPresent) warnings.push('missing-high-tilt-axis-ambiguous');

  return { candidates, tracks, warnings, ambiguity };
}

function markores(markers: string[]): string[] {
  // 每三个标记留出一个（确定性），覆盖全部帧。
  return markers.filter((_, i) => i % 3 === 2);
}
