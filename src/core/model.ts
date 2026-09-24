// Domain model vocabulary for the tilt-series registration review chamber.
// Units and coordinate bases travel with every quantity.

export type Unit = 'degree' | 'radian' | 'angstrom/pixel' | 'e-/A^2' | 'e-/nm^2' | 'unknown';

export interface TiltFrame {
  ordinal: number;
  imageName: string;
  widthPx?: number;
  heightPx?: number;
}

export interface AngleRecord {
  frameOrdinal: number;
  rawValue: string;
  unit: string;
  valueDeg?: number;
  direction: string;
  diagnostic?: string;
}

export interface PixelScaleRecord {
  rawValue: string;
  rawUnit: string;
  angstromPerPx?: number;
  coordinateBasis: string;
  binning?: number;
  diagnostic?: string;
}

export interface DoseRecord {
  frameOrdinal: number;
  rawValue: string;
  rawUnit: string;
  electronsPerAngstrom2?: number;
  diagnostic?: string;
}

export interface FiducialObservation {
  label: string;
  frameOrdinal: number;
  xPx: number;
  yPx: number;
}

export interface GapRecord {
  label: string;
  frameOrdinal: number;
  reasonCode: string;
}

export interface SwapRecord {
  labelA: string;
  labelB: string;
  betweenOrdinal: number;
  confidence: 'confirmed' | 'ambiguous';
}

export interface ExclusionRecord {
  frameOrdinal: number;
  reasonCode: string;
  reasonDetail: string;
  author: string;
}

export interface AxisRecord {
  angleDeg: number;
  pivotXPx?: number;
  pivotYPx?: number;
  assumedCenter: boolean;
  eccentricityKnown: boolean;
  rawRepr: string;
  diagnostic?: string;
}

export interface ParsedPlate {
  seriesSlug: string;
  title: string;
  coordinateFrame: string;
  frames: TiltFrame[];
  angles: AngleRecord[];
  pixelScale?: PixelScaleRecord;
  doses: DoseRecord[];
  fiducials: FiducialObservation[];
  gaps: GapRecord[];
  swaps: SwapRecord[];
  exclusions: ExclusionRecord[];
  axis?: AxisRecord;
  unconvertible: { lineNo: number; line: string; diagnostic: string }[];
}

export interface BundleFile {
  name: string;
  bytes: Uint8Array;
}

export type CandidateKind = 'rigid' | 'local_deformable' | 'rigid_excluding_bad_frames';

export interface FrameResidual {
  frameEntityId: string;
  frameOrdinal: number;
  residualPx: number;
  usedFiducials: number;
  excluded: boolean;
}

export interface CandidateView {
  candidateId: string;
  kind: CandidateKind;
  label: string;
  branchId: string;
  paramSetId: string;
  axisVersionId: string | null;
  effectivePointSetHash: string;
  frameCountTotal: number;
  frameCountUsed: number;
  excludedFrames: number[];
  rmsResidualPx: number;
  maxResidualPx: number;
  overfitScore: number;
  ambiguityGroupId: string | null;
  status: string;
  transforms: unknown;
  residuals: FrameResidual[];
  findings: FindingView[];
}

export interface FindingView {
  findingId: string;
  ruleCode: string;
  severity: string;
  message: string;
  evidence: unknown;
}

export interface VersionRef {
  entityType: string;
  entityId: string;
  versionId: string;
  versionNo: number;
  contentSummary: string;
}

export interface EntityReport {
  entityId: string;
  entityType: string;
  currentVersionId: string | null;
  versions: {
    versionId: string;
    versionNo: number;
    contentSummary: Record<string, unknown>;
    references: VersionRef[];
    blobSha256?: string;
  }[];
}

export const RULE_CODES = {
  axisNotCenter: 'R_AXIS_NOT_CENTER',
  fiducialSwap: 'R_FIDUCIAL_SWAP',
  missingHighTilt: 'R_MISSING_HIGH_TILT',
  badFrame: 'R_BAD_FRAME',
  localOverfit: 'R_LOCAL_OVERFIT',
  multipleSolutions: 'R_MULTIPLE_SOLUTIONS',
  concurrentFreeze: 'R_CONCURRENT_FREEZE',
  fairPointSet: 'R_FAIR_POINT_SET',
  noFrameTrading: 'R_NO_FRAME_TRADING'
} as const;
