/**
 * 领域类型：电子断层 / 倾转序列 / 配准审阅。
 * 数据契约直接使用领域词汇（原始帧、倾角、像素尺度、剂量、标记点坐标、
 * 跟踪缺口、手工排除原因、倾转轴几何、轨迹身份交换、有效点集、配准候选、
 * 人工裁定、重建锁定），不使用通用 name/value 容器。
 */

// ---------- 单位与坐标基准 ----------
export interface Diagnostic {
  code: string;          // 例如 "unit-unparseable" / "value-out-of-range"
  message: string;
  rawExcerpt: string;    // 留在原位置的原始表示
}

export interface Quantity<TUnit extends string> {
  raw: string;           // 导入时的原始表示，永远保留
  value: number | null;  // 派生层规范化结果；无法转换为 null
  unit: TUnit | null;
  diagnostics: Diagnostic[];
}

export type PixelScaleUnit = "nm/px" | "Å/px";
export type DoseUnit = "e-/Å²";
export type AngleUnit = "deg";

/** 图像坐标基准：原点在左上角，x 向右，y 向下，单位 px。倾转轴不得默认固定在图像中心。 */
export const IMAGE_FRAME_CONVENTION = "image-origin-top-left-px" as const;

// ---------- 输入材料（全部版本化） ----------
export type MaterialKind =
  | "raw-frames"
  | "tilt-angles"
  | "pixel-scale"
  | "dose"
  | "marker-coordinates"
  | "tracking-gaps"
  | "manual-exclusions";

export interface RawFrame {
  frameIndex: number;
  tiltAngle: Quantity<AngleUnit>;
  widthPx: number;
  heightPx: number;
  pixelGrid: { encoding: "gray8-row-major"; dataBase64: string };
  sourceLabel: string;
}

export interface RawFramesContent { frames: RawFrame[]; }

export interface TiltAnglesContent {
  angles: { frameIndex: number; tiltAngle: Quantity<AngleUnit> }[];
}

export interface PixelScaleContent { pixelScale: Quantity<PixelScaleUnit>; }
export interface DoseContent { dose: Quantity<DoseUnit>; }

export interface MarkerObservation {
  frameIndex: number;
  xPx: number;
  yPx: number;
  raw: string; // 原始文本表示（保留导入原样）
}

export interface MarkerTrack {
  trackId: string;       // fiducial 轨迹身份；轨迹可断裂、可身份交换
  observations: MarkerObservation[];
}

export interface MarkerCoordinatesContent { tracks: MarkerTrack[]; }

export interface TrackingGap {
  trackId: string;
  frameIndex: number;
  reason: "occlusion" | "low-contrast" | "edge-of-frame";
}

export interface TrackingGapsContent { gaps: TrackingGap[]; }

export interface ManualExclusion {
  frameIndex: number;
  reason: string;        // 手工排除原因（如 "charging-jump"）
  decidedBy: string;
}

export interface ManualExclusionsContent { exclusions: ManualExclusion[]; }

export type MaterialContent =
  | RawFramesContent
  | TiltAnglesContent
  | PixelScaleContent
  | DoseContent
  | MarkerCoordinatesContent
  | TrackingGapsContent
  | ManualExclusionsContent;

export interface MaterialVersion {
  materialId: string;    // 稳定身份，如 "material:marker-coordinates"
  kind: MaterialKind;
  version: number;       // 从 1 递增
  contentHash: string;   // 内容摘要（sha256）
  content: MaterialContent;
  createdByEvent: string;
}

// ---------- 决定实体 ----------
/** 倾转轴几何：轴心可偏离图像中心，可整体倾斜；绝不默认固定在图像中心。 */
export interface TiltAxisGeometry {
  axisOffsetPx: number;  // 轴心相对图像中心的水平偏移（px）
  axisTiltDeg: number;   // 轴在图像平面内的倾角（deg）
  convention: typeof IMAGE_FRAME_CONVENTION;
}

/** 轨迹身份交换：两条 fiducial 轨迹在某一帧之后身份对调。 */
export interface TrackIdentitySwap {
  frameIndex: number;
  trackA: string;
  trackB: string;
}

export interface TrackIdentityAssignment {
  swaps: TrackIdentitySwap[];
}

/** 有效点集：候选之间必须用相同有效点集比较，不用少帧换低残差。 */
export interface EffectivePointSet {
  points: { trackId: string; frameIndex: number }[];
  excludedFrames: number[];
  gapPoints: { trackId: string; frameIndex: number }[];
  digest: string;
}

export interface AlignmentParams {
  paramSetId: string;
  version: number;
  modelKind: "rigid" | "local-warp";
  axisInit: TiltAxisGeometry;
  identityAssignment: TrackIdentityAssignment;
  excludedFrames: number[];       // 坏帧排除（来自手工排除原因）
  warpPerFrame: boolean;          // 局部形变：每帧独立仿射
}

// ---------- 复核实体 ----------
export type CandidateFlag =
  | "overfit-suspected"     // 局部形变过拟合
  | "multi-solution-tie"    // 多解并列
  | "fewer-frames-lower-rms"// 用少帧换低残差（违规迹象）
  | "axis-offset-detected"; // 轴线偏心被识别

export interface AlignmentCandidate {
  candidateId: string;
  branchId: string;
  modelKind: "rigid" | "local-warp";
  params: AlignmentParams;
  axis: TiltAxisGeometry;                 // 拟合得到的倾转轴
  effectivePointSet: EffectivePointSet;   // 与其他候选共享同一有效点集
  rmsPx: number;
  perFrameResidualsPx: Record<number, number>;
  perTrackShifts: Record<string, { dxPx: number; dyPx: number }[]>;
  model: FittedModel;
  flags: CandidateFlag[];
  dependsOn: DependencyRef[];
  status: "proposed" | "accepted" | "rejected" | "stale" | "locked";
  createdByEvent: string;
}

export interface DependencyRef {
  targetId: string;      // 引用的实体稳定身份
  targetVersion: number; // 引用的版本号
  kind: "material" | "params" | "candidate" | "adjudication";
}

export interface Adjudication {
  adjudicationId: string;
  branchId: string;
  candidateId: string;
  verdict: "accept" | "reject";
  rationale: string;
  baseSeq: number;       // 提交时基于的分支 head（乐观并发）
  atSeq: number;
  undoneByEvent: string | null;
}

export interface ReconstructionLock {
  lockId: string;
  candidateId: string;
  lockedAtSeq: number;
  note: string;
}

// ---------- 事件（机器可读取） ----------
export type PrincipleKind =
  | "axis-not-center-pinned"        // 倾转轴不能被默认固定在图像中心
  | "tracks-may-break-and-swap"     // fiducial 轨迹可断裂且可能身份交换
  | "same-effective-point-set";     // 不同候选用相同有效点集比较，不用少帧换低残差

export type EventPayload =
  | { type: "case-imported"; caseId: string; materialVersions: { materialId: string; version: number }[] }
  | { type: "material-versioned"; materialId: string; kind: MaterialKind; version: number; contentHash: string }
  | { type: "params-revised"; paramSetId: string; version: number; summary: string }
  | { type: "source-locally-changed"; materialId: string; version: number; affectedScope: string[] }
  | { type: "candidate-computed"; candidateId: string; modelKind: string; rmsPx: number; effectivePointSetDigest: string; flags: CandidateFlag[] }
  | { type: "principle-judged"; principle: PrincipleKind; subjectId: string; evidence: Record<string, string | number | boolean> }
  | { type: "multi-solution-preserved"; candidateIds: string[]; rmsValuesPx: number[] }
  | { type: "adjudication-recorded"; adjudicationId: string; candidateId: string; verdict: "accept" | "reject"; rationale: string }
  | { type: "adjudication-undone"; adjudicationId: string; restoredSeq: number }
  | { type: "alignment-locked"; lockId: string; candidateId: string }
  | { type: "conflict-detected"; branchId: string; baseSeq: number; headSeq: number; winnerEventId: string; loserPayloadSummary: string }
  | { type: "invalidation-computed"; triggerEventId: string; staleIds: string[] }
  | { type: "dossier-recorded"; dossierId: string; scenario: string; outcome: string }
  | { type: "import-rolled-back"; reason: string }
  | { type: "manual-decision-conflict"; topic: string; options: string[]; chosen: string; overridden: string };

export interface DomainEvent {
  seq: number;
  eventId: string;
  branchId: string;
  at: string;            // 逻辑时间戳（ISO）
  payload: EventPayload;
  prevHash: string;
  hash: string;
}

// ---------- 分支 ----------
export interface Branch {
  branchId: string;
  name: string;
  parentBranchId: string | null;
  baseSeq: number;
  headSeq: number;
}

// ---------- 反例档案 ----------
export type ScenarioKind =
  | "axis-offset"            // 轴线偏心
  | "identity-swap"          // 轨迹身份交换
  | "missing-high-tilt"      // 缺失高倾角帧
  | "bad-frame-exclusion"    // 坏帧排除
  | "local-warp-overfit"     // 局部形变过拟合
  | "multi-solution"         // 多解
  | "concurrent-freeze";     // 并发冻结

export interface DossierEntry {
  dossierId: string;
  scenario: ScenarioKind;
  minimalInputRef: string;    // 最小输入（内容寻址共享）
  combinedInputRef: string;   // 组合输入
  interpretationVersion: string;
  failureDiagnostics: Diagnostic[];
  humanDecision: string | null;
  adoptedCandidateId: string | null;      // 被采纳结果
  nonAdoptedCandidateIds: string[];       // 未采纳结果（同样保留）
  outcome: string;
}

// ---------- 拟合模型（候选携带，供相同有效点集上公平复评） ----------
export interface RigidModel {
  kind: "rigid";
  axis: TiltAxisGeometry;
  perFrameShift: { frameIndex: number; dxPx: number; dyPx: number }[];
  beadXYZ: { trackId: string; xPx: number; yPx: number; zPx: number }[];
}

export interface WarpModel {
  kind: "local-warp";
  base: RigidModel;
  perFrameAffine: { frameIndex: number; a11: number; a12: number; a21: number; a22: number; txPx: number; tyPx: number }[];
}

export type FittedModel = RigidModel | WarpModel;
