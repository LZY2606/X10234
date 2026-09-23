// 离线案例包的数据契约（仓库自带，非通用表格）
export type ScenarioCode =
  | "axis-offset"
  | "identity-swap"
  | "missing-high-tilt"
  | "bad-frame"
  | "local-overfit"
  | "multi-solution";

export interface PackObservation {
  segmentId: string;
  frameId: string;
  x: number;
  y: number;
  uncertaintyPx: number;
  rawText: string;
}

export interface PackGap {
  gapId: string;
  segmentId: string;
  missingFrameId: string;
  reason: "occluded" | "outside-field" | "tracker-lost" | "manual";
  rawText: string;
}

export interface PackFrameMeta {
  frameId: string;
  order: number;
  angleRaw: string;
  angleDeg: number;
  doseRaw: string;
  dose: number | null;
  quality: "ok" | "motion-blur" | "over-exposed";
  fragmentHash: string;
  include: boolean; // 最小输入只引用共享片段的一个子集
}

export interface PackLink {
  linkId: string;
  leftSegmentId: string;
  rightSegmentId: string;
  note: string;
}

export interface PackLinkSet {
  linkSetId: string;
  label: string;
  links: PackLink[];
  note: string;
}

export interface PackAxis {
  axisId: string;
  version: number;
  offsetXPx: number | null;
  offsetYPx: number | null;
  directionDeg: number;
  centeredAssumption: boolean;
  note: string;
}

export interface PackExclusion {
  frameId: string;
  reason: string;
  rawText: string;
  decidedBy: string;
}

export interface PackInterpretation {
  interpretationId: string;
  label: string;
  axisId: string;
  axisVersion: number;
  linkSetId: string;
  excludedFrameIds: string[];
  overrides?: Array<{ segmentId: string; frameId: string; x: number; y: number; rawText: string }>;
  extraObservation?: PackObservation;
  note: string;
}

export interface InputSidecar {
  sidecarId: string;
  description: string;
  pixelScaleRaw: string;
  frames: PackFrameMeta[];
  segments: Array<{ segmentId: string; observedFrameIds: string[] }>;
  observations: PackObservation[];
  gaps: PackGap[];
  exclusions: PackExclusion[];
  linkSets: PackLinkSet[];
  axes: PackAxis[];
  interpretations: PackInterpretation[];
  diagnostics: Array<{ code: string; at: string; rawText: string; message: string }>;
}

export interface ReplayAction {
  id: string;
  kind:
    | "import-baseline"
    | "import-variant"
    | "revise-axis"
    | "compute-candidates"
    | "adjudicate"
    | "lock"
    | "concurrent-conflict"
    | "resolve-freeze";
  summary: string;
  variant?: "minimal" | "combined";
  interpretationId?: string;
  candidateKind?: "rigid" | "local-deformation" | "rigid-excluded";
  candidateId?: string;
  verdict?: "accepted" | "rejected";
  reason?: string;
  axis?: PackAxis;
  parentActionId?: string;
  clientId?: string;
}

export interface Expectation {
  must: Array<{ code: string; evidence: string }>;
  adoptedCandidateKind?: "rigid" | "local-deformation" | "rigid-excluded";
  rejectedCandidateKinds: Array<"rigid" | "local-deformation" | "rigid-excluded">;
  frozenAtEnd?: boolean;
  invalidatedCandidates?: string[];
}

export interface VariantPack {
  scenarioCode: ScenarioCode;
  scenarioTitle: string;
  variant: "minimal" | "combined";
  directSourceChange: string; // 每次只改动一个直接来源
  sidecar: InputSidecar;
  replay: ReplayAction[];
  expectations: Expectation;
}

export interface CaseManifest {
  packId: string;
  title: string;
  basis: { basisId: string; widthPx: number; heightPx: number };
  baselineSidecarId: string;
  fragmentFiles: Array<{ frameId: string; hash: string; file: string }>;
  scenarios: Array<{
    code: ScenarioCode;
    title: string;
    ruleId: string;
    minimalSidecarId: string;
    combinedSidecarId: string;
  }>;
}

export interface CasePack {
  manifest: CaseManifest;
  baseline: InputSidecar;
  baselineReplay: ReplayAction[];
  baselineExpectations: Expectation;
  variants: VariantPack[];
  fragmentBinaries: Record<string, Buffer>; // hash -> bytes
}
