/**
 * 领域数据契约：直接采用电子断层 / 倾转序列 / 配准的词汇，
 * 不把一切压成 name/value。
 */

export type SourceKind =
  | "raw_frames"
  | "tilt_angles"
  | "pixel_scale"
  | "dose"
  | "fiducial_tracks"
  | "tracking_gaps"
  | "manual_exclusions";

export const SOURCE_KINDS: SourceKind[] = [
  "raw_frames",
  "tilt_angles",
  "pixel_scale",
  "dose",
  "fiducial_tracks",
  "tracking_gaps",
  "manual_exclusions",
];

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  raw_frames: "原始帧",
  tilt_angles: "倾角",
  pixel_scale: "像素尺度",
  dose: "曝光剂量",
  fiducial_tracks: "fiducial 点轨迹",
  tracking_gaps: "跟踪缺口",
  manual_exclusions: "手工排除原因",
};

/**
 * 所有领域量携带原始表示；value/unit 是派生层规范化结果。
 * 无法转换时 value 缺省，diagnostic 说明原因，原值留在原位置。
 */
export interface DomainQuantity {
  raw: string;
  value?: number;
  unit?: string;
  basis?: string;
  diagnostic?: string;
}

export interface TiltAngleRecord {
  frameIndex: number;
  angle: DomainQuantity;
}

export interface DoseRecord {
  frameIndex: number;
  dose: DomainQuantity;
}

export interface PixelScaleRecord {
  pixelScale: DomainQuantity;
}

export interface FiducialPoint {
  frameIndex: number;
  x: DomainQuantity;
  y: DomainQuantity;
}

export interface FiducialTrack {
  markerId: string;
  points: FiducialPoint[];
}

export interface FiducialTracksRecord {
  tracks: FiducialTrack[];
}

export interface TrackingGap {
  markerId: string;
  fromFrame: number;
  toFrame: number;
  reason: string;
}

export interface TrackingGapsRecord {
  gaps: TrackingGap[];
}

export interface ManualExclusion {
  frameIndex: number;
  reason: string;
  decidedBy: string;
  at: string;
}

export interface ManualExclusionsRecord {
  exclusions: ManualExclusion[];
}

/** 原始帧：宽度、高度、8 位灰度字节（一帧），像素基准 origin-top-left。 */
export interface RawFrame {
  frameIndex: number;
  width: number;
  height: number;
  bytes: Buffer;
  sha256: string;
}

export interface RawFramesRecord {
  frames: RawFrame[];
}

export interface SourceVersionRef {
  id: string;
  version: number;
}

export interface Provenance {
  importedBy: string;
  importedAt: string;
  note?: string;
}

export interface SourceRecord {
  id: string;
  version: number;
  kind: SourceKind;
  blobId: string;
  provenance: Provenance;
  supersedes: SourceVersionRef | null;
  createdAt: string;
}

export interface AxisCenter {
  xPx: number;
  yPx: number;
  /** 拟合/假设来源，例如 fitted / fixed-image-center。 */
  origin: string;
}

export interface TiltAxisEstimate {
  center: AxisCenter;
  angleDeg: number;
  imageCenterPx: [number, number];
  /** 相对图像中心的偏心距离（px），为 0 才是“固定在图像中心”。 */
  eccentricityPx: number;
}

export type AlignmentModel = "rigid" | "local_warp";

export interface PerFrameResidual {
  frameIndex: number;
  tiltDeg: number | null;
  rmsNm: number;
  used: boolean;
  reason?: string;
}

export interface CandidateParams {
  model: AlignmentModel;
  axis: TiltAxisEstimate;
  driftPx: Array<[number, number]>;
  markerGeomNm: Array<{ markerId: string; uNm: number; vNm: number; zNm: number; zUncertainty?: number }>;
  warpAffines?: number[][];
  fixedAtImageCenter?: boolean;
}

export type DiagnosticCode =
  | "AXIS_FIXED_AT_CENTER"
  | "AXIS_ECCENTRIC_FITTED"
  | "TRACK_IDENTITY_SWAP_SUSPECT"
  | "MISSING_HIGH_TILT"
  | "Z_DEPTH_UNCONSTRAINED"
  | "OVERFIT_SUSPECT"
  | "MULTI_SOLUTION"
  | "EFFECTIVE_SET_MISMATCH"
  | "BAD_FRAME_HIGH_RESIDUAL"
  | "TRACK_GAP_PRESENT"
  | "UNCONVERTIBLE_QUANTITY";

export interface CandidateDiagnostic {
  code: DiagnosticCode;
  message: string;
  detail?: Record<string, unknown>;
  ruleCodes?: string[];
}

export type CandidateStatus = "proposed" | "accepted" | "rejected";

export interface AlignmentCandidate {
  id: string;
  interpretationId: string;
  label: string;
  model: AlignmentModel;
  effectiveSetKey: string;
  frameCount: number;
  pointCount: number;
  meanResidualNm: number;
  perFrameResiduals: PerFrameResidual[];
  params: CandidateParams;
  diagnostics: CandidateDiagnostic[];
  status: CandidateStatus;
  createdEventSeq: number;
}

export interface RuleStatement {
  code: string;
  text: string;
}

export interface RulePack {
  id: string;
  version: number;
  statements: RuleStatement[];
  params: {
    expectedMaxTiltDeg: number;
    axisCenterSearchHalfPx: number;
    axisAngleSearchHalfDeg: number;
    overfitGainThreshold: number;
    swapResidualGain: number;
    multiSolutionResidualTolerance: number;
    badFrameResidualFactor: number;
  };
}

export interface Interpretation {
  id: string;
  branchId: string;
  rulePackId: string;
  rulePackVersion: number;
  refs: Partial<Record<SourceKind, SourceVersionRef>>;
  params: {
    /** fitted = 不固定轴线；fixed-image-center = 故意固定在图像中心（反例）。 */
    axisMode: "fitted" | "fixed-image-center";
    trackHypothesis?: "as_tracked" | "swap_suffix";
    swapPair?: [string, string];
    swapFromFrame?: number;
    note?: string;
  };
  createdAt: string;
  createdEventSeq: number;
}

export interface Branch {
  id: string;
  name: string;
  parentId: string | null;
  parentEventSeq: number | null;
  headSeq: number;
  createdAt: string;
}

export interface EventBasis {
  rulePackId: string;
  rulePackVersion: number;
  refs: Partial<Record<SourceKind, SourceVersionRef>>;
  ruleCodes?: string[];
}

export type EventType =
  | "casepack.loaded"
  | "rule.declared"
  | "branch.created"
  | "source.imported"
  | "source.superseded"
  | "interpretation.created"
  | "candidate.proposed"
  | "candidate.invalidated"
  | "rulepack.revised"
  | "diagnostic.raised"
  | "adjudication.accepted"
  | "adjudication.rejected"
  | "adjudication.undone"
  | "alignment.locked"
  | "alignment.unlocked"
  | "scenario.completed";

export interface Event<PayloadT = Record<string, unknown>> {
  seq: number;
  id: string;
  type: EventType;
  branchId: string;
  at: string;
  payload: PayloadT;
  basis: EventBasis | null;
}

export interface LockedAlignment {
  branchId: string;
  candidateId: string;
  eventSeq: number;
  lockId: string;
  lockedBy: string;
  at: string;
  /** 供重建引用的稳定身份，例如 reconref:branch_main:cand_...@evt_42_xxx。 */
  reconstructionRef: string;
}

export interface ScenarioVerdict {
  scenarioId: string;
  title: string;
  inputKind: "minimal" | "combined";
  branchId: string;
  interpretationId: string;
  candidateIds: string[];
  diagnostics: DiagnosticCode[];
  affectedObjects: string[];
  assertionNotes: string[];
}
