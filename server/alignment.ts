import type {
  AlignmentCandidate,
  AlignmentParams,
  FiducialPoint,
  FrameResidual,
  TiltAxis,
  TiltSeriesSource,
  Vec2,
} from './types.ts';

export interface ResidualPoint {
  trackId: string;
  frameIndex: number;
  observed: Vec2;
  predicted: Vec2;
  residualPx: number;
}

const AXIS_GRID_MIN = -90;
const AXIS_GRID_MAX = 90;
const AXIS_GRID_STEP = 1.5;
const AMBIGUITY_REL_TOL = 0.01;

export function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Observed fiducial point for one (track, frame), after identity remap. */
interface PointObs {
  trackId: string;
  frameIndex: number;
  pos: Vec2;
}

function effectiveObservations(
  source: TiltSeriesSource,
  params: AlignmentParams,
  allowedFrames: Set<number>,
): { obs: PointObs[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const remap = params.identityRemap ?? {};
  const gapSet = new Set(source.trackGaps.map((g) => `${g.trackId}:${g.fromFrame}-${g.toFrame}`));
  const obs: PointObs[] = [];
  for (const p of source.fiducialPoints) {
    if (!allowedFrames.has(p.frameIndex)) continue;
    const broken = source.trackGaps.some(
      (g) => g.trackId === p.trackId && p.frameIndex > g.fromFrame && p.frameIndex < g.toFrame,
    );
    if (broken) {
      diagnostics.push(`track ${p.trackId} broken over frame ${p.frameIndex}; point not used`);
      continue;
    }
    const canonicalTrack = remap[p.trackId] ?? p.trackId;
    if (remap[p.trackId]) diagnostics.push(`identity ${p.trackId} remapped to ${canonicalTrack}`);
    obs.push({ trackId: canonicalTrack, frameIndex: p.frameIndex, pos: p.positionPx });
  }
  void gapSet;
  return { obs, diagnostics };
}
