/**
 * 配准几何。
 * 规则：
 *  - 倾转轴不会被默认固定在图像中心（pivot 必须显式测量或带占位标记）。
 *  - fiducial 轨迹可断裂且可能身份交换（observations 按 trackId 分组，断点由调用方提供）。
 *  - 不同候选必须用相同有效点集比较，不用少帧换低残差（比较函数强制点集一致）。
 */
import type { FiducialObservationContent, PerFrameResidual, PixelPoint } from './types.js';

export interface MatchedPoint {
  trackId: string;
  frameSequence: number;
  observed: PixelPoint;
  /** 同一 track 在参考帧上的基准位置（px）。 */
  reference: PixelPoint;
}

export interface RigidModel {
  /** 围绕 pivot 的二维刚体参数：平移（px）+ 面内旋转（deg）。 */
  txPx: number;
  tyPx: number;
  rotDeg: number;
}

export function applyRigid(p: PixelPoint, pivot: PixelPoint, m: RigidModel): PixelPoint {
  const a = (m.rotDeg * Math.PI) / 180;
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    x: pivot.x + m.txPx + dx * cos - dy * sin,
    y: pivot.y + m.tyPx + dx * sin + dy * cos,
    basis: 'image-toplevel-px',
  };
}

/**
 * 最小二乘拟合每帧刚体（关于给定 pivot 线性化：小角度 rot）。
 * 点不足时返回 null，调用方按多解/欠定处理，绝不偷偷补默认点。
 */
export function fitRigidFrame(points: MatchedPoint[], pivot: PixelPoint): RigidModel | null {
  const n = points.length;
  // 刚体 3 参数，少于 2 个非共线点不可解；我们保守要求 n>=3。
  if (n < 3) return null;
  let ata = Array.from({ length: 3 }, () => [0, 0, 0]);
  const atb = [0, 0, 0];
  for (const pt of points) {
    const dx = pt.observed.x - pivot.x;
    const dy = pt.observed.y - pivot.y;
    const rx = pt.reference.x - pt.observed.x;
    const ry = pt.reference.y - pt.observed.y;
    // 雅可比：dx_ref = tx - rot*dy ; dy_ref = ty + rot*dx
    const j = [
      [1, 0, -dy],
      [0, 1, dx],
    ];
    const b = [rx, ry];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        atb[c] += j[r][c] * b[r];
        for (let k = 0; k < 3; k++) ata[c][k] += j[r][c] * j[r][k];
      }
    }
  }
  const x = solve3(ata, atb);
  if (!x) return null;
  return { txPx: x[0], tyPx: x[1], rotDeg: (x[2] * 180) / Math.PI };
}

function solve3(a: number[][], b: number[]): [number, number, number] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-10) return null;
    [m[piv], m[col]] = [m[col], m[piv]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k <= 3; k++) m[r][k] -= f * m[col][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

export function pointResidualPx(pt: MatchedPoint, pivot: PixelPoint, m: RigidModel): number {
  const pred = applyRigid(pt.observed, pivot, m);
  return Math.hypot(pred.x - pt.reference.x, pred.y - pt.reference.y);
}

export interface FrameFitResult {
  frameSequence: number;
  valid: boolean;
  model: RigidModel | null;
  rmsPx: number;
  maxPx: number;
  nPoints: number;
}

export function fitFrames(
  observationsByFrame: Map<number, FiducialObservationContent[]>,
  referenceByTrack: Map<string, PixelPoint>,
  pivot: PixelPoint,
  validFrameSequences: number[],
): FrameFitResult[] {
  const out: FrameFitResult[] = [];
  for (const seq of validFrameSequences) {
    const obs = observationsByFrame.get(seq) ?? [];
    const matched: MatchedPoint[] = [];
    for (const o of obs) {
      const ref = referenceByTrack.get(o.trackId);
      if (!ref) continue; // 断裂/交换且未重接的身份不参与，但缺口被记录
      matched.push({ trackId: o.trackId, frameSequence: seq, observed: o.position, reference: ref });
    }
    const model = fitRigidFrame(matched, pivot);
    if (!model || matched.length < 3) {
      out.push({ frameSequence: seq, valid: false, model, rmsPx: NaN, maxPx: NaN, nPoints: matched.length });
      continue;
    }
    const res = matched.map((pt) => pointResidualPx(pt, pivot, model));
    const rms = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length);
    out.push({ frameSequence: seq, valid: true, model, rmsPx: rms, maxPx: Math.max(...res), nPoints: matched.length });
  }
  return out;
}

export function toPerFrameResidual(fits: FrameFitResult[], nmPerPx: number): PerFrameResidual[] {
  return fits.map((f) => ({
    frameSequence: f.frameSequence,
    valid: f.valid,
    residualNm: f.valid ? Number((f.rmsPx * nmPerPx).toPrecision(6)) : NaN,
    nPoints: f.nPoints,
  }));
}

export function summarizeNm(fits: FrameFitResult[], nmPerPx: number): { rmsNm: number; maxNm: number } {
  const valid = fits.filter((f) => f.valid);
  if (valid.length === 0) return { rmsNm: NaN, maxNm: NaN };
  const sumSq = valid.reduce((s, f) => s + (f.rmsPx * nmPerPx) ** 2, 0);
  return {
    rmsNm: Number(Math.sqrt(sumSq / valid.length).toPrecision(6)),
    maxNm: Number(Math.max(...valid.map((f) => f.maxPx * nmPerPx)).toPrecision(6)),
  };
}

/**
 * 候选比较前提：相同有效点集。
 * 返回违例原因列表；空数组表示可比较。
 * “不用少帧换低残差”：帧数/点集不同则不可直接比较。
 */
export function compareFairness(a: { validFrameSequences: number[]; usedObservationVersionIds: string[] }, b: { validFrameSequences: number[]; usedObservationVersionIds: string[] }): string[] {
  const problems: string[] = [];
  const fa = [...a.validFrameSequences].sort((x, y) => x - y).join(',');
  const fb = [...b.validFrameSequences].sort((x, y) => x - y).join(',');
  if (fa !== fb) problems.push(`valid-frame-set differs: [${fa}] vs [${fb}] — 不能用少帧换低残差`);
  const pa = [...a.usedObservationVersionIds].sort();
  const pb = [...b.usedObservationVersionIds].sort();
  if (pa.join('|') !== pb.join('|')) problems.push('observation version set differs — 不同候选必须引用相同有效点集版本');
  return problems;
}

export function centroid(points: PixelPoint[]): PixelPoint | null {
  if (points.length === 0) return null;
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
    basis: 'image-toplevel-px',
  };
}
