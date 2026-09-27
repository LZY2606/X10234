import { fitSimilarity, applySimilarity, rms, distance, type Pt, type Similarity } from './geometry.ts';
import type { CandidateDiagnostic, ParameterSetValue, ScenarioCode } from './types.ts';

export interface EngineObservation {
  frameId: string; // 稳定帧 id（不是 ref）
  tiltDeg: number;
  doseENm2?: number;
  points: { trackId: string; fragmentId: string; x: number; y: number }[];
  excluded?: boolean;
  blur?: boolean;
  highTilt?: boolean;
  acquired: boolean;
}

export interface EngineIdentityLink {
  trackA: string; fragmentA: string; trackB: string; fragmentB: string;
}

export interface EngineInput {
  seriesId: string;
  width: number;
  height: number;
  frames: EngineObservation[];
  parameters: ParameterSetValue;
  /** 标定证据给出的轴交点（px）；无证据时为 null，绝不静默用图像中心 */
  axisEvidence: { x: number; y: number; angleDeg: number } | null;
  /** 身份交换假设：片段 A/B 在某处交换了 track 身份 */
  swapHypotheses?: EngineIdentityLink[];
}

export interface EngineCandidateResult {
  key: string;
  strategy: 'rigid' | 'rigid_with_exclusions' | 'local_warp' | 'rigid_identity_swapped';
  includedFrameIds: string[];
  excludedFrameIds: string[];
  pointSetKey: string;
  transforms: Record<string, Similarity>;
  perFrameResidual: Record<string, number>;
  pointResiduals: { frameId: string; trackId: string; residualPx: number; included: boolean }[];
  rmsPx: number;
  diagnostics: CandidateDiagnostic[];
  status: 'legal' | 'rejected_overfit' | 'ambiguous' | 'invalid';
}

export interface EngineResult {
  candidates: EngineCandidateResult[];
  diagnostics: CandidateDiagnostic[];
  scenarios: ScenarioCode[];
  axisIntersectionPx: Pt;
  axisAngleDeg: number;
  axisEccentricPx: number;
  axisCalibrated: boolean;
}

type PointRow = { frameId: string; trackId: string; fragmentId: string; x: number; y: number };

function collectPoints(input: EngineInput, frameIds: Set<string>): PointRow[] {
  const rows: PointRow[] = [];
  for (const f of input.frames) {
    if (!frameIds.has(f.frameId)) continue;
    for (const p of f.points) rows.push({ frameId: f.frameId, trackId: p.trackId, fragmentId: p.fragmentId, x: p.x, y: p.y });
  }
  return rows;
}

function pointSetKey(rows: PointRow[], frameIds: string[]): string {
  const points = rows
    .map((r) => `${r.frameId}:${r.trackId}:${r.fragmentId}:${r.x.toFixed(3)},${r.y.toFixed(3)}`)
    .sort()
    .join('|');
  return `ps:${[...frameIds].sort().join(',')}:${points.length}:${points}`;
}

function fitCandidate(
  input: EngineInput,
  included: string[],
  excluded: string[],
  strategy: EngineCandidateResult['strategy'],
  key: string,
  extraDiags: CandidateDiagnostic[] = [],
): EngineCandidateResult {
  const frameSet = new Set(included);
  const refId = included[0];
  const refById = new Map(input.frames.map((f) => [f.frameId, f]));
  const rows = collectPoints(input, frameSet);
  const transforms: Record<string, Similarity> = {};
  const pointResiduals: EngineCandidateResult['pointResiduals'] = [];
  const perFrameResidual: Record<string, number> = {};

  const refPoints = new Map<string, Pt>();
  for (const p of refById.get(refId)!.points) refPoints.set(p.trackId, { x: p.x, y: p.y });

  for (const frameId of included) {
    const frame = refById.get(frameId)!;
    const pairs: { p: Pt; q: Pt }[] = [];
    for (const p of frame.points) {
      const ref = refPoints.get(p.trackId);
      if (ref) pairs.push({ p: { x: p.x, y: p.y }, q: ref });
    }
    const sim = fitSimilarity(pairs);
    if (sim) transforms[frameId] = sim;
    const errs: number[] = [];
    for (const pair of pairs) {
      if (!sim) continue;
      const mapped = applySimilarity(sim, pair.p);
      const e = distance(mapped, pair.q);
      errs.push(e);
      pointResiduals.push({ frameId, trackId: frame.points.find((p) => p.x === pair.p.x)?.trackId ?? '', residualPx: e, included: true });
    }
    perFrameResidual[frameId] = rms(errs);
  }
  const allErrs = pointResiduals.filter((p) => p.included).map((p) => p.residualPx);
  const rmsPx = rms(allErrs);
  return {
    key, strategy,
    includedFrameIds: included, excludedFrameIds: excluded,
    pointSetKey: pointSetKey(rows, included),
    transforms, perFrameResidual, pointResiduals, rmsPx,
    diagnostics: extraDiags, status: 'legal',
  };
}
