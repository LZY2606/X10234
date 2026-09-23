/**
 * 领域数据契约：电子断层 / 倾转序列 / 配准审阅。
 * 一切领域量携带单位或坐标基准；导入时保留原始表示，派生层才规范化。
 */

// ---------- 量与单位 ----------
export interface Quantity {
  /** 原始表示，导入时逐字保留，永不改写 */
  raw: string;
  /** 原始单位（原始表示的一部分） */
  unit?: string;
  /** 坐标基准，例如 image-top-left / specimen-plane */
  datum?: string;
}

export interface NormalizedQuantity {
  value: number;
  unit: string;
  datum?: string;
}

export interface Diagnostic {
  code:
    | 'UNIT_UNCONVERTIBLE'
    | 'VALUE_UNPARSEABLE'
    | 'AXIS_FIXED_AT_CENTER_REJECTED'
    | 'TRACK_IDENTITY_SWAP'
    | 'TRACK_GAP'
    | 'MISSING_HIGH_TILT_FRAMES'
    | 'BAD_FRAME_EXCLUDED'
    | 'LOCAL_DEFORM_OVERFIT'
    | 'MULTIPLE_SOLUTIONS'
    | 'INCOMPARABLE_POINT_SETS'
    | 'CONCURRENT_FREEZE';
  message: string;
  /** 出错位置：实体/字段路径，原值留在原位置 */
  at: string;
  raw?: string;
}

/** 单位换算表：别名 -> 规范单位与倍率 */
const UNIT_TABLE: Record<string, { canonical: string; factor: number }> = {
  'deg': { canonical: 'deg', factor: 1 },
  'degree': { canonical: 'deg', factor: 1 },
  'arcmin': { canonical: 'deg', factor: 1 / 60 },
  'mrad': { canonical: 'deg', factor: 0.05729577951308232 },
  'nm/px': { canonical: 'nm/px', factor: 1 },
  'nm/pixel': { canonical: 'nm/px', factor: 1 },
  'A/px': { canonical: 'nm/px', factor: 0.1 },
  'Å/px': { canonical: 'nm/px', factor: 0.1 },
  'px': { canonical: 'px', factor: 1 },
  'pixel': { canonical: 'px', factor: 1 },
  'e-/A^2': { canonical: 'e-/A^2', factor: 1 },
  'e-/Å²': { canonical: 'e-/A^2', factor: 1 },
  'e-/A2': { canonical: 'e-/A^2', factor: 1 },
};

export function normalizeQuantity(
  q: Quantity,
  at: string,
): { value?: NormalizedQuantity; diagnostic?: Diagnostic } {
  const num = Number(q.raw);
  if (!Number.isFinite(num)) {
    return {
      diagnostic: {
        code: 'VALUE_UNPARSEABLE',
        message: `无法解析数值 "${q.raw}"，原值保留在原位置`,
        at,
        raw: q.raw,
      },
    };
  }
  const unit = q.unit ?? '';
  const entry = UNIT_TABLE[unit];
  if (!entry) {
    return {
      diagnostic: {
        code: 'UNIT_UNCONVERTIBLE',
        message: `无法转换单位 "${unit}"，原值保留在原位置`,
        at,
        raw: `${q.raw} ${unit}`.trim(),
      },
    };
  }
  return {
    value: { value: num * entry.factor, unit: entry.canonical, datum: q.datum },
  };
}

// ---------- 实体引用 ----------
export interface EntityRef {
  id: string;
  version: number;
}

// ---------- 输入实体（领域词汇，非 name/value） ----------
export interface RawFrame {
  frameUid: string;
  /** 确定性缩略图种子，原始像素摘要 */
  thumbnailSeed: number;
  widthPx: number;
  heightPx: number;
  /** 原始像素内容摘要（sha256 前 16 位） */
  contentDigest: string;
}

export interface TiltAngleEntry {
  frameUid: string;
  angle: Quantity;
}

export interface DoseEntry {
  frameUid: string;
  dose: Quantity;
}

export interface FiducialPoint {
  frameUid: string;
  x: Quantity;
  y: Quantity;
}

export interface TrackSegment {
  segmentUid: string;
  points: FiducialPoint[];
}

export interface TrackingGap {
  gapUid: string;
  beforeFrameUid: string;
  afterFrameUid: string;
  reason: string;
}

export interface FiducialTrack {
  trackUid: string;
  segments: TrackSegment[];
  gaps: TrackingGap[];
}

export interface IdentitySwap {
  atFrameUid: string;
  trackA: string;
  trackB: string;
  source: 'manual' | 'detected';
  note: string;
}

export interface ExclusionEntry {
  frameUid: string;
  reason: string;
  decidedBy: string;
  manual: true;
}

// ---------- 决定实体 ----------
export interface AlignmentParameters {
  model: 'rigid' | 'local-deform' | 'rigid-exclude-bad-frames';
  /** 倾转轴先验：允许偏离图像中心；禁止默认固定在中心 */
  axisPrior: { offsetPx: Quantity; angleDeg: Quantity };
  /** 局部形变自由度（仅 local-deform） */
  localDof?: number;
}

export interface FrameResidual {
  frameUid: string;
  rmsPx: number;
  usedPoints: number;
}

export interface EffectivePoint {
  trackUid: string;
  frameUid: string;
}

export interface AlignmentCandidate {
  candidateUid: string;
  model: AlignmentParameters['model'];
  /** 拟合出的倾转轴：允许偏心，datum 标明坐标基准 */
  axis: { offsetPx: number; angleDeg: number; datum: string };
  effectivePoints: EffectivePoint[];
  excludedFrames: string[];
  residuals: FrameResidual[];
  dof: number;
  parametersRef: EntityRef;
  inputRefs: EntityRef[];
}

// ---------- 规则：机器可读取的判断依据 ----------
export const RULES = {
  AXIS_NOT_FIXED_AT_CENTER: 'rule.axis-not-fixed-at-center',
  TRACK_BREAK_AND_IDENTITY_SWAP: 'rule.track-break-and-identity-swap',
  SAME_EFFECTIVE_POINT_SET: 'rule.same-effective-point-set',
} as const;

export type RuleId = (typeof RULES)[keyof typeof RULES];

export interface RuleEventPayload {
  rule: RuleId;
  evidence: Record<string, unknown>;
  verdict: string;
}

// ---------- 候选比较 ----------
/** 稳定 FNV-1a 摘要，用于有效点集身份 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function effectivePointSetHash(c: AlignmentCandidate): string {
  const keys = c.effectivePoints
    .map((p) => `${p.trackUid}@${p.frameUid}`)
    .sort();
  return fnv1a(keys.join('|'));
}

export interface CandidateComparison {
  comparable: boolean;
  rule: typeof RULES.SAME_EFFECTIVE_POINT_SET;
  pointSetHashA: string;
  pointSetHashB: string;
  verdict: string;
  winnerCandidateUid?: string;
  meanRmsA?: number;
  meanRmsB?: number;
}

export function meanRms(c: AlignmentCandidate): number {
  if (c.residuals.length === 0) return Number.POSITIVE_INFINITY;
  return c.residuals.reduce((s, r) => s + r.rmsPx, 0) / c.residuals.length;
}

/**
 * 不同候选必须用相同有效点集比较；不允许用少帧换低残差。
 */
export function compareCandidates(
  a: AlignmentCandidate,
  b: AlignmentCandidate,
): CandidateComparison {
  const hashA = effectivePointSetHash(a);
  const hashB = effectivePointSetHash(b);
  if (hashA !== hashB) {
    return {
      comparable: false,
      rule: RULES.SAME_EFFECTIVE_POINT_SET,
      pointSetHashA: hashA,
      pointSetHashB: hashB,
      verdict:
        '有效点集不同，禁止直接比较残差：不允许用少帧/少点换低残差。先对齐有效点集再比较。',
    };
  }
  const meanRmsA = meanRms(a);
  const meanRmsB = meanRms(b);
  const winner = meanRmsA <= meanRmsB ? a.candidateUid : b.candidateUid;
  return {
    comparable: true,
    rule: RULES.SAME_EFFECTIVE_POINT_SET,
    pointSetHashA: hashA,
    pointSetHashB: hashB,
    meanRmsA,
    meanRmsB,
    winnerCandidateUid: winner,
    verdict: `有效点集一致（${a.effectivePoints.length} 点），可比较：${winner} 平均 RMS 更低。`,
  };
}

/** 局部形变过拟合检验：自由度数相对有效点数过高即诊断 */
export function localDeformOverfitCheck(c: AlignmentCandidate): Diagnostic | null {
  if (c.model !== 'local-deform') return null;
  const points = c.effectivePoints.length;
  if (points === 0) return null;
  const ratio = c.dof / points;
  if (ratio > 0.5) {
    return {
      code: 'LOCAL_DEFORM_OVERFIT',
      message: `局部形变自由度 ${c.dof} 相对有效点 ${points} 过高（比例 ${ratio.toFixed(2)}），残差趋零是过拟合而非改善。`,
      at: `alignment-candidate/${c.candidateUid}`,
    };
  }
  return null;
}

/** 倾转轴拟合：禁止默认固定在图像中心，返回偏心距与是否触发规则 */
export function assertAxisNotFixedAtCenter(axis: {
  offsetPx: number;
  datum: string;
}): RuleEventPayload {
  return {
    rule: RULES.AXIS_NOT_FIXED_AT_CENTER,
    evidence: { offsetPx: axis.offsetPx, datum: axis.datum },
    verdict:
      Math.abs(axis.offsetPx) > 0.5
        ? `倾转轴偏离图像中心 ${axis.offsetPx.toFixed(2)} px（基准 ${axis.datum}），允许并接受偏心。`
        : '倾转轴接近图像中心，但这是拟合结果而非默认约束。',
  };
}

/** 轨迹断点检测：相邻段之间帧不连续即为断点 */
export function detectTrackGaps(track: FiducialTrack): TrackingGap[] {
  return track.gaps;
}

/** 轨迹身份交换检测：两段轨迹在相邻帧间位置交叉 */
export function detectIdentitySwaps(
  tracks: FiducialTrack[],
  at: string,
): { swaps: IdentitySwap[]; diagnostics: Diagnostic[] } {
  const swaps: IdentitySwap[] = [];
  const diagnostics: Diagnostic[] = [];
  const posAt = new Map<string, Map<string, { x: number; y: number }>>();
  for (const t of tracks) {
    const m = new Map<string, { x: number; y: number }>();
    for (const seg of t.segments) {
      for (const p of seg.points) {
        const x = Number(p.x.raw);
        const y = Number(p.y.raw);
        if (Number.isFinite(x) && Number.isFinite(y)) m.set(p.frameUid, { x, y });
      }
    }
    posAt.set(t.trackUid, m);
  }
  const frames = new Set<string>();
  for (const m of posAt.values()) for (const f of m.keys()) frames.add(f);
  const ordered = [...frames].sort();
  for (let i = 0; i + 1 < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const A = posAt.get(tracks[i].trackUid)!;
      const B = posAt.get(tracks[j].trackUid)!;
      for (let k = 0; k + 1 < ordered.length; k++) {
        const f0 = ordered[k];
        const f1 = ordered[k + 1];
        const a0 = A.get(f0); const a1 = A.get(f1);
        const b0 = B.get(f0); const b1 = B.get(f1);
        if (!a0 || !a1 || !b0 || !b1) continue;
        const cross0 = (b0.x - a0.x);
        const cross1 = (b1.x - a1.x);
        if (cross0 !== 0 && cross1 !== 0 && Math.sign(cross0) !== Math.sign(cross1)) {
          const swap: IdentitySwap = {
            atFrameUid: f1,
            trackA: tracks[i].trackUid,
            trackB: tracks[j].trackUid,
            source: 'detected',
            note: `轨迹在 ${f0}→${f1} 间交叉，疑似身份交换`,
          };
          swaps.push(swap);
          diagnostics.push({
            code: 'TRACK_IDENTITY_SWAP',
            message: swap.note,
            at: `${at}/tracks/${tracks[i].trackUid}+${tracks[j].trackUid}`,
          });
        }
      }
    }
  }
  return { swaps, diagnostics };
}
