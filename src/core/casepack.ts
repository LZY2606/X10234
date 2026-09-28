/**
 * 离线案例包格式（领域材料，不用通用表格替代）：
 *
 *   cases/<caseId>/case.json     该案例的输入材料（引用共享 blob）
 *   cases/shared/raw_frames/<sha256>.png   最小输入与组合输入共享的不可变帧字节，只存一份
 *
 * 一个案例 = 一个“最小输入”(minimalInputs 中一个反例) + 可选的“组合输入”。
 * 两者引用相同 blobId 时只在 shared/ 下存一份；各自的解释版本/诊断/人工决定独立。
 */
import type {
  CoordinateDatum,
  DoseUnit,
  PixelScaleUnit,
  TiltAngleConvention,
} from './domain.js';

export interface CaseBlobRef {
  blobId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  /** 相对案例包根的路径；最小/组合共享帧指向 shared/raw_frames */
  path: string;
}

export interface CaseFrameSpec {
  frameId: string;
  acquisitionIndex: number;
  widthPx: number;
  heightPx: number;
  /** 帧内容签名：相同签名 => 相同不可变字节（共享存储的依据） */
  contentSignature: string;
  blob: CaseBlobRef;
  role: 'normal' | 'bad' | 'missing-high-tilt';
  /** 坏帧类型（仅 role=bad） */
  badness?: 'crack' | 'drift-burst' | 'focus-loss' | 'ice-contamination';
  /** 组合输入标记该帧为高倾角缺失位（不导出帧文件，只保留缺口说明） */
  present: boolean;
}

export interface CaseAngleSpec {
  angleId: string;
  frameId: string;
  acquisitionIndex: number;
  rawValue: number;
  rawUnit: string;
  convention: TiltAngleConvention;
}

export interface CaseScaleSpec {
  scaleId: string;
  frameId: string | null;
  rawValue: number;
  rawUnit: PixelScaleUnit;
}

export interface CaseDoseSpec {
  doseId: string;
  frameId: string;
  acquisitionIndex: number;
  cumulativeRaw: number;
  perFrameRaw: number;
  rawUnit: DoseUnit;
}

export interface CaseObservationSpec {
  markerLabel: number;
  x: number;
  y: number;
  datum: CoordinateDatum;
  fitQuality?: number;
}

export interface CaseSegmentSpec {
  segmentId: string;
  indexFrom: number;
  indexTo: number;
  observations: CaseObservationSpec[];
}

export interface CaseIdentityLinkSpec {
  linkId: string;
  fromSegmentId: string;
  toSegmentId: string;
  gapFrameIndex: number;
  status: 'provisional' | 'accepted' | 'swapped' | 'rejected';
  reason?: string;
  swappedWithLinkId?: string;
}

export interface CaseTrackSpec {
  trackId: string;
  physicalBeadId: string;
  segments: CaseSegmentSpec[];
  identityLinks: CaseIdentityLinkSpec[];
}

export interface CaseGapSpec {
  gapId: string;
  frameId: string;
  acquisitionIndex: number;
  missingMarkerLabels: number[];
  reasonRaw: string | null;
}

export interface CaseExclusionSpec {
  exclusionId: string;
  target:
    | { scope: 'frame'; frameId: string }
    | { scope: 'track-segment'; trackId: string; segmentId: string }
    | { scope: 'observation'; trackId: string; frameId: string };
  reasonCode:
    | 'bad-frame/crack'
    | 'bad-frame/drift-burst'
    | 'bad-frame/focus-loss'
    | 'bad-frame/ice-contamination'
    | 'outlier-observation'
    | 'tracker-mislabel';
  note: string;
  decidedBy: string;
  decidedAt: string;
}

export interface CaseAxisTruth {
  pivot: { x: number; y: number };
  imageCenter: { x: number; y: number };
  directionDeg: number;
}

/** 导入后脚本化重放的事件（参数修订 / 局部源数据改动 / 冲突人工决定） */
export type CaseEventSpec =
  | {
      type: 'parameter-revision';
      eventId: string;
      at: string;
      by: string;
      /** 修订参数（如轴线初值是否假设中心、正则强度） */
      changes: Record<string, number | boolean | string>;
      note: string;
    }
  | {
      type: 'local-source-change';
      eventId: string;
      at: string;
      by: string;
      /** 只改动的单一直接来源（其余材料不变） */
      sourceEntityKind: string;
      sourceStableId: string;
      newVersion: number;
      note: string;
    }
  | {
      type: 'manual-decision';
      eventId: string;
      at: string;
      by: string;
      decision: 'accept' | 'reject' | 'parameter-revision' | 'lock';
      candidateLabel?: string;
      note: string;
      /** 与谁的决定冲突（重放并发冻结用） */
      conflictsWith?: string;
    };

export interface MinimalInput {
  /** 对应七类反例之一 */
  scenario:
    | 'axis-eccentricity'
    | 'track-identity-swap'
    | 'missing-high-tilt'
    | 'bad-frame-exclusion'
    | 'local-deform-overfit'
    | 'multiple-solutions'
    | 'concurrent-freeze';
  frames: CaseFrameSpec[];
  angles: CaseAngleSpec[];
  scales: CaseScaleSpec[];
  doses: CaseDoseSpec[];
  tracks: CaseTrackSpec[];
  gaps: CaseGapSpec[];
  exclusions: CaseExclusionSpec[];
  axisTruth: CaseAxisTruth;
  /** 期望：影响必须被限制在正确范围（受影响对象集合） */
  expectedAffected: string[];
  expectedDiagnostics: string[];
}

export interface CasePack {
  packFormat: 'tilt-assembly-room/case-pack/v1';
  title: string;
  seriesName: string;
  seriesId: string;
  coordinateDatum: CoordinateDatum;
  createdAt: string;
  minimalInputs: MinimalInput[];
  /** 组合输入：七类情形的边界组合，与 minimalInputs 共享相同帧签名字节 */
  combined: MinimalInput;
  /** 完整叙事重放脚本（初始导入→参数修订→局部源改动→冲突决定） */
  replay: {
    branchId: string;
    events: CaseEventSpec[];
  };
  domainNotes: string;
}
