// Domain vocabulary for the tilt-series fusion room.
// Input entities: raw frames, tilt angles, pixel scale, dose, marker
// coordinates, tracking gaps and manual exclusion reasons -- all versioned.
// Decision entities: tilt axis assumptions, fiducial track links, alignment
// candidates, review decisions and the locked reference used by reconstruction.

import type { Quantity, ImagePoint } from './units.js';
import type { Json } from './id.js';

export interface TiltSeriesInput {
  seriesId: string;
  label: string;
  frames: FrameInput[];
  pixelScale: Quantity;
  markerTracks: MarkerTrackInput[];
}

export interface FrameInput {
  frameId: string;
  index: number;
  tiltAngle: Quantity;
  dose: Quantity;
  pngBytes: Uint8Array;
  // Tracking gaps: which tracks have no observation on this frame.
  gaps?: GapRecord[];
  // Manual exclusion reason, if a human has already flagged the frame.
  exclusion?: ExclusionReason;
}

export interface GapRecord {
  trackId: string;
  reason: 'out-of-field' | 'low-contrast' | 'not-tracked' | 'occluded';
  note?: string;
}

export interface ExclusionReason {
  reason: 'motion-blur' | 'beam-damage' | 'tracking-loss' | 'too-high-tilt' | 'custom';
  note: string;
  decidedBy: string;
}

export interface MarkerTrackInput {
  trackId: string;
  // Observations keyed by frameId; a missing entry is a tracking gap.
  observations: Record<string, ImagePoint>;
}

// ---- Versioned entities (persistence shape) ----

export type EntityKind =
  | 'tilt_series'
  | 'frame'
  | 'marker_track'
  | 'observation'
  | 'tilt_axis_assumption'
  | 'alignment_candidate'
  | 'review_decision'
  | 'locked_reference'
  | 'conflict_record';

export interface EntityVersion {
  stableId: string;
  kind: EntityKind;
  version: number;
  branchId: string;
  supersedesVersion: number | null;
  createdAt: string;
  createdByEventId: string;
  payload: Json;
  digest: string;
}

// ---- Decision-layer payloads ----

export type AlignmentScheme = 'rigid' | 'local-deform' | 'rigid-exclude';

export interface TiltAxisAssumptionPayload {
  seriesId: string;
  // The axis is an oriented line.  An offset null means "not fixed"; the engine
  // must never silently place it at the image centre.
  directionRad: number;
  offsetPx: number | null;
  assumedCentre: boolean; // true only when a human/system explicitly chose centre
  basis: 'imported-metadata' | 'parameter-revision' | 'review-decision';
  ruleVersion: string;
  note?: string;
}

export interface PerFrameResidual {
  frameId: string;
  excluded: boolean;
  nCommonPoints: number;
  rmsNm: number;
}

export interface AlignmentCandidatePayload {
  seriesId: string;
  branchId: string;
  scheme: AlignmentScheme;
  axisRef: string; // version ref of tilt_axis_assumption
  excludedFrameIds: string[];
  effectivePointFingerprint: string;
  commonFrameIds: string[];
  perFrameResiduals: PerFrameResidual[];
  rmsResidualNm: number; // over the common effective point set only
  degreesOfFreedom: number;
  leaveOneOutNm: number | null;
  diagnostics: Diagnostic[];
  ruleVersion: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'ambiguous';
  tieGroupId?: string;
}

export interface Diagnostic {
  code:
    | 'axis/off-centre-required'
    | 'axis/centre-assumption-rejected'
    | 'track/identity-swap-suspected'
    | 'track/gap-present'
    | 'frame/missing-high-tilt'
    | 'frame/excluded-bad'
    | 'fit/local-deform-overfit'
    | 'fit/multi-solution'
    | 'compare/fewer-frames-cheating'
    | 'compare/effective-set-mismatch'
    | 'concurrency/stale-head'
    | 'quantity/unconvertible';
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidenceRefs: string[]; // entity version refs / raw ids
  ruleVersion: string;
}

export type DecisionKind = 'accept' | 'reject' | 'parameter-adjust' | 'revert';

export interface ReviewDecisionPayload {
  branchId: string;
  candidateRefs: string[];
  kind: DecisionKind;
  note: string;
  decidedBy: string;
  // revert points at the previous decision event, restoring that branch view.
  revertsEventId: string | null;
}

export interface LockedReferencePayload {
  seriesId: string;
  branchId: string;
  candidateRef: string;
  lockedBy: string;
  // Frozen dependency set: reconstruction reads exactly these versions.
  dependencyRefs: string[];
}

// ---- Events ----

export type EventType =
  | 'import.applied'
  | 'import.rolled_back'
  | 'source.parameter_revised'
  | 'source.local_change'
  | 'track.relinked'
  | 'frame.excluded'
  | 'axis.revised'
  | 'candidate.proposed'
  | 'candidate.ambiguous_set'
  | 'decision.recorded'
  | 'reference.locked'
  | 'decision.reverted'
  | 'conflict.detected'
  | 'dependency.invalidated';

export interface StoredEvent {
  eventId: string;
  branchId: string;
  seq: number;
  type: EventType;
  baseHeadEventId: string | null; // optimistic-concurrency base
  actor: string;
  createdAt: string;
  payload: Json;
  affectedRefs: string[];
  ruleVersion: string;
}

export interface BranchInfo {
  branchId: string;
  seriesId: string;
  label: string;
  headEventId: string | null;
  headSeq: number;
  scenario: string | null;
}
