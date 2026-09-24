import {
  type CandidateModel,
  type DiagnosticCode,
  type PerFrameResidual,
  type RegistrationCandidateContent,
  type RuleParams,
  type UID,
  type ComparisonRow
} from './types';
import { type Observation, fitRigid, rmse, axisVectors, type FitResult } from './geometry';
import { newUid } from './util';

export interface FrameMeta {
  frameUid: UID;
  acquisitionIndex: number;
  tiltDeg: number | null;
  widthPx: number;
  heightPx: number;
  excluded: boolean;
}

export interface TrackBuild {
  trackUid: UID;
  marks: Observation[];
  /** 身份交换处理后，该 track 在每一帧上观测到的 mark */
}

export interface AlignmentInput {
  interpretationUid: UID;
  pointSetUid: UID;
  pointSetHash: string;
  frames: FrameMeta[];
  observations: Observation[];
  /** 已知的 track 身份交换假设：键为 frameUid 之后的交换对 */
  swapHypothesis?: { frameUid: UID; trackA: UID; trackB: UID }[];
  params: RuleParams;
  imageCenter: { x: number; y: number };
}

export interface GeneratedCandidate {
  content: Omit<RegistrationCandidateContent, 'refs'>;
  diagnostics: { code: DiagnosticCode; severity: 'info' | 'warning' | 'error'; message: string; subjectUid?: UID }[];
}

export interface CandidateArtifact {
  candidate: GeneratedCandidate;
  model: CandidateModel;
}

function perFrameResiduals(
  obs: Observation[],
  params: ReturnType<typeof fitRigid>['params'],
  frames: FrameMeta[],
  excludedSet: Set<UID>
): PerFrameResidual[] {
  const byFrame = new Map<UID, Observation[]>();
  for (const o of obs) {
    if (!byFrame.has(o.frameUid)) byFrame.set(o.frameUid, []);
    byFrame.get(o.frameUid)!.push(o);
  }
  return frames
    .slice()
    .sort((a, b) => a.acquisitionIndex - b.acquisitionIndex)
    .map((f) => {
      const rows = byFrame.get(f.frameUid) ?? [];
      return {
        frameUid: f.frameUid,
        tiltDeg: f.tiltDeg,
        rmsePx: rows.length ? rmse(rows, params) : 0,
        observationCount: rows.length,
        excluded: excludedSet.has(f.frameUid)
      };
    });
}

function splitHeldout(obs: Observation[], seedSalt = 0): { train: Observation[]; held: Observation[] } {
  // 确定性留出：每个 track 每 5 个点留出 1 个（用于局部形变过拟合检验）
  const byTrack = new Map<string, Observation[]>();
  for (const o of obs) {
    if (!byTrack.has(o.trackUid)) byTrack.set(o.trackUid, []);
    byTrack.get(o.trackUid)!.push(o);
  }
  const train: Observation[] = [];
  const held: Observation[] = [];
  for (const rows of byTrack.values()) {
    rows.forEach((o, i) => ((i + seedSalt) % 5 === 4 ? held : train).push(o));
  }
  return { train, held };
}

function candidateFromFit(
  input: AlignmentInput,
  model: CandidateModel,
  label: string,
  params: ReturnType<typeof fitRigid>['params'],
  train: Observation[],
  held: Observation[],
  frames: FrameMeta[],
  excludedSet: Set<UID>,
  diagnostics: GeneratedCandidate['diagnostics'],
  opts: { legal: boolean; resolution: 'unique' | 'ambiguous' }
): GeneratedCandidate {
  const drift: Record<string, number> = {};
  for (const f of frames) drift[f.frameUid] = params.frames[f.frameUid]?.d ?? 0;
  const fit: FitResult = {
    axisAngleDeg: params.angle,
    c0: { x: params.c0x, y: params.c0y },
    perFrame: new Map(),
    trainRmse: train.length ? rmse(train, params) : Infinity,
    heldoutRmse: held.length ? rmse(held, params) : NaN,
    center: input.imageCenter
  };
  void fit;
  const diagnosticUids = diagnostics.map(() => newUid('diag'));
  const content = {
    kind: 'registration_candidate' as const,
    interpretationUid: input.interpretationUid,
    pointSetUid: input.pointSetUid,
    pointSetHash: input.pointSetHash,
    model,
    label,
    axisAngleDeg: params.angle,
    centerXPx: params.c0x,
    centerYPx: params.c0y,
    perFrameDriftAlongAxisPx: drift,
    perFrameResidual: perFrameResiduals(train, params, frames, excludedSet),
    trainRmsePx: train.length ? rmse(train, params) : Infinity,
    heldoutRmsePx: held.length ? rmse(held, params) : NaN,
    effectiveFrameCount: frames.filter((f) => !excludedSet.has(f.frameUid)).length,
    excludedFrameUids: frames.filter((f) => excludedSet.has(f.frameUid)).map((f) => f.frameUid),
    legal: opts.legal,
    resolution: opts.resolution,
    diagnosticUids
  };
  return { content, diagnostics };
}

export interface AlignmentResult {
  candidates: GeneratedCandidate[];
  /** 共同有效点集上的比较行 */
  comparison: Omit<ComparisonRow, never>[];
  /** 缺失高倾角诊断（与候选无关） */
  globalDiagnostics: GeneratedCandidate['diagnostics'];
}

/** 局部形变模型：每个 track 加独立 2x2 仿射 + 平移；参数多，用来演示过拟合。 */
function fitLocalWarp(train: Observation[]): { map: Map<string, { A: number[]; b: number[] }>; trainRmse: number } {
  // 对每个 track 独立拟合 p_obs ≈ A p_ref + b（最小二乘）
  const byTrack = new Map<string, Observation[]>();
  for (const o of train) {
    if (!byTrack.has(o.trackUid)) byTrack.set(o.trackUid, []);
    byTrack.get(o.trackUid)!.push(o);
  }
  const map = new Map<string, { A: number[]; b: number[] }>();
  let sse = 0;
  for (const [track, rows] of byTrack) {
    const X: number[][] = rows.map((o) => [o.refX, o.refY, 1]);
    const yx = rows.map((o) => o.observedX);
    const yy = rows.map((o) => o.observedY);
    const coefX = lstsq(X, yx);
    const coefY = lstsq(X, yy);
    map.set(track, { A: [coefX[0], coefX[1], coefY[0], coefY[1]], b: [coefX[2], coefY[2]] });
    rows.forEach((o, i) => {
      const px = X[i].reduce((s, v, k) => s + v * coefX[k], 0);
      const py = X[i].reduce((s, v, k) => s + v * coefY[k], 0);
      sse += (px - yx[i]) ** 2 + (py - yy[i]) ** 2;
    });
  }
  return { map, trainRmse: Math.sqrt(sse / Math.max(train.length, 1)) };
}

function localWarpRmse(obs: Observation[], map: Map<string, { A: number[]; b: number[] }>): number {
  let sse = 0;
  let n = 0;
  for (const o of obs) {
    const m = map.get(o.trackUid);
    if (!m) continue;
    const px = m.A[0] * o.refX + m.A[1] * o.refY + m.b[0];
    const py = m.A[2] * o.refX + m.A[3] * o.refY + m.b[1];
    sse += (px - o.observedX) ** 2 + (py - o.observedY) ** 2;
    n++;
  }
  return n ? Math.sqrt(sse / n) : Infinity;
}

function lstsq(X: number[][], y: number[]): number[] {
  // 正规方程 (X'X) c = X'y
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  X.forEach((row, i) => {
    for (let a = 0; a < p; a++) {
      Xty[a] += row[a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += row[a] * row[b];
    }
  });
  for (let k = 0; k < p; k++) XtX[k][k] += 1e-9;
  return gaussianSolve(XtX, Xty);
}

function gaussianSolve(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[piv], M[col]] = [M[col], M[piv]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i][i]);
}

/**
 * 为同一有效点集生成全部候选：
 * 刚体自由轴、刚体中心固定（显式假设）、坏帧排除、局部形变、身份交换。
 * 所有候选记录同一个 pointSetHash，比较时只取共同点。
 */
export function runAlignment(input: AlignmentInput): AlignmentResult {
  const activeFrames = input.frames.filter((f) => !f.excluded);
  const activeSet = new Set(activeFrames.map((f) => f.frameUid));
  const obs = input.observations.filter((o) => activeSet.has(o.frameUid));
  const { train, held } = splitHeldout(obs);
  const excludedSet = new Set(input.frames.filter((f) => f.excluded).map((f) => f.frameUid));
  const candidates: GeneratedCandidate[] = [];
  const globalDiagnostics: GeneratedCandidate['diagnostics'] = [];

  // 1) 刚体：自由轴线（轴线位置是拟合量，允许偏心）
  const free = fitRigid(train);
  const freeDiag: GeneratedCandidate['diagnostics'] = [];
  const offset = Math.hypot(free.params.c0x - input.imageCenter.x, free.params.c0y - input.imageCenter.y);
  if (offset > 3) {
    freeDiag.push({
      code: 'axis_not_center',
      severity: 'warning',
      message: `拟合轴线偏离图像中心 ${offset.toFixed(2)} px；不得默认轴线位于中心。`
    });
  }
  const freeCand = candidateFromFit(
    input, 'rigid_free_axis', '刚体 · 自由偏心轴', free.params, train, held, input.frames, excludedSet, freeDiag,
    { legal: true, resolution: 'unique' }
  );
  candidates.push(freeCand);

  // 2) 刚体：中心固定（仅作为对照候选，明确标注该假设）
  const pinned = fitRigid(train, { pinnedCenter: input.imageCenter });
  const pinnedDiag: GeneratedCandidate['diagnostics'] = [{
    code: 'axis_pinned_assumption',
    severity: 'info',
    message: '该候选显式把旋转中心固定在图像中心，仅用于与自由轴候选对比，不代表事实。'
  }];
  candidates.push(candidateFromFit(
    input, 'rigid_pinned_center', '刚体 · 中心固定（假设）', pinned.params, train, held, input.frames, excludedSet,
    pinnedDiag, { legal: true, resolution: 'unique' }
  ));

  // 3) 坏帧检测 + 排除候选：在自由轴解上按单帧残差阈值找坏帧
  const residualByFrame = new Map<UID, { rmse: number; n: number }>();
  const byFrame = new Map<UID, Observation[]>();
  for (const o of train) {
    if (!byFrame.has(o.frameUid)) byFrame.set(o.frameUid, []);
    byFrame.get(o.frameUid)!.push(o);
  }
  for (const [f, rows] of byFrame) residualByFrame.set(f, { rmse: rmse(rows, free.params), n: rows.length });
  const values = [...residualByFrame.values()].map((v) => v.rmse);
  const median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const mad = (() => {
    const d = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)] ?? 0;
  })();
  const sigma = mad * 1.4826 || 0.5;
  const badFrames = [...residualByFrame.entries()]
    .filter(([, v]) => v.n >= 1 && v.rmse > median + input.params.badFrameResidualSigma * sigma)
    .map(([f]) => f);

  if (badFrames.length > 0) {
    const newExcluded = new Set(excludedSet);
    badFrames.forEach((f) => newExcluded.add(f));
    const obs2 = train.filter((o) => !newExcluded.has(o.frameUid));
    const held2 = held.filter((o) => !newExcluded.has(o.frameUid));
    const bf = fitRigid(obs2);
    const bfDiag: GeneratedCandidate['diagnostics'] = badFrames.map((f) => ({
      code: 'bad_frame_residual' as DiagnosticCode,
      severity: 'warning' as const,
      message: `帧 ${f} 单帧残差 ${(residualByFrame.get(f)?.rmse ?? 0).toFixed(2)} px 超过 ${input.params.badFrameResidualSigma}σ 阈值。`,
      subjectUid: f
    }));
    candidates.push(candidateFromFit(
      input, 'rigid_badframe_excluded', `刚体 · 排除坏帧 ×${badFrames.length}`, bf.params, obs2, held2,
      input.frames, newExcluded, bfDiag, { legal: true, resolution: 'unique' }
    ));
  }
