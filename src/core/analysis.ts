import { fitRegistration, perFrameRms, rmsOnSubset, rotateToAxis, type FitResult, type Observation3DInput } from './geometry.ts';

export interface BadFrameReport {
  frame: number;
  rms: number;
  medianRms: number;
  ratio: number;
  suggested: boolean;
}

/** 坏帧：该帧 RMS 相对中位帧显著偏高（不是靠“少帧”换低残差，须证据驱动） */
export function detectBadFrames(
  observations: Observation3DInput[],
  options: { thresholdRatio?: number } = {}
): BadFrameReport[] {
  const fit = fitRegistration({ axis: { axisAngleDeg: 0, offset: 0 }, observations, variant: 'rigid' });
  const byFrame = perFrameRms(fit);
  const entries = [...byFrame.entries()].sort((a, b) => a[0] - b[0]);
  const values = entries.map(([, r]) => r).sort((a, b) => a - b);
  const median = values.length ? values[Math.floor(values.length / 2)] : 0;
  const threshold = options.thresholdRatio ?? 2.2;
  return entries.map(([frame, rms]) => ({
    frame,
    rms,
    medianRms: median,
    ratio: median ? rms / median : 1,
    suggested: median ? rms / median > threshold : false
  }));
}

export interface OverfitReport {
  /** 训练轨迹（bead）上的 RMS */
  trainRms: number;
  /** 留出轨迹上的 RMS */
  heldOutRms: number;
  /** 自由度 */
  dof: number;
  overfit: boolean;
  diagnostic: string;
}

/**
 * 局部形变过拟合：留出一部分轨迹（bead）不参与拟合，
 * 比较训练与留出 RMS。局部自由参数多但留出更差 => 过拟合。
 */
export function overfitReport(
  observations: Observation3DInput[],
  axis: { axisAngleDeg: number; offset: number },
  options: { holdOutBeads?: number[]; lambda?: number } = {}
): OverfitReport {
  const beads = [...new Set(observations.map((o) => o.bead))].sort((a, b) => a - b);
  const hold = new Set(options.holdOutBeads ?? beads.filter((_, i) => i % 3 === 2));
  const train = observations.filter((o) => !hold.has(o.bead));
  const held = observations.filter((o) => hold.has(o.bead));

  const rigid = fitRegistration({ axis, observations: train, variant: 'rigid' });
  const local = fitRegistration({
    axis,
    observations: train,
    variant: 'localDeform',
    localLambda: options.lambda ?? 0
  });

  const heldKeys = held.map((o) => ({ bead: o.bead, frame: o.frame }));
  const rigidHeld = evaluateOnHeld(rigid, held);
  const localHeld = evaluateOnHeld(local, held);

  const overfit =
    local.rms < rigid.rms * 0.98 &&
    localHeld > rigidHeld * 1.05;

  return {
    trainRms: local.rms,
    heldOutRms: localHeld,
    dof: local.degreesOfFreedom,
    overfit,
    diagnostic: overfit
      ? `局部形变训练 RMS=${local.rms.toFixed(3)} 低于刚体 ${rigid.rms.toFixed(3)}，但留出 ${heldKeys.length} 点 RMS=${localHeld.toFixed(
          3
        )} 高于刚体 ${rigidHeld.toFixed(3)}；自由度 ${local.degreesOfFreedom}，判为过拟合`
      : `训练/留出 RMS 未见显著背离（局部 ${local.rms.toFixed(3)}/${localHeld.toFixed(3)} vs 刚体 ${rigid.rms.toFixed(
          3
        )}/${rigidHeld.toFixed(3)}）`
  };
}

function evaluateOnHeld(fit: FitResult, held: Observation3DInput[]): number {
  // 留出 bead 没有参与拟合：用刚体/局部模型对 held bead 单独做“只解 3D 点”的评估，
  // 帧参数固定为 fit 结果。这里采用子集重拟合并只比较帧参数推广能力的近似：
  // 直接用已有 bead 坐标无法外推，因此在 held 数据上以相同帧参数重解 3D 点。
  const heldAxis = held.map((h) => {
    const rp = rotateToAxis({ u: h.x, v: h.y }, fit.axis);
    return { ...h, x: rp.u, y: rp.v };
  });
  const p3: Record<number, [number, number, number]> = {};
  let acc = 0;
  let n = 0;
  for (const bead of new Set(heldAxis.map((h) => h.bead))) {
    const rows = heldAxis.filter((h) => h.bead === bead);
    const A: number[][] = [];
    const y: number[] = [];
    for (const r of rows) {
      const [su, sv] = fit.localScale[r.frame] ?? [0, 0];
      const [tu, tv] = fit.translations[r.frame] ?? [0, 0];
      const c = Math.cos(r.theta);
      const s = Math.sin(r.theta);
      A.push([r.w * (1 + su), 0, 0]);
      y.push(r.w * (r.x - tu));
      A.push([0, r.w * (1 + sv) * c, r.w * (1 + sv) * -s]);
      y.push(r.w * (r.y - tv));
    }
    const sol = solve3(A, y);
    p3[bead] = sol;
  }
  for (const r of heldAxis) {
    const [Pu, Pv, Pz] = p3[r.bead];
    const [su, sv] = fit.localScale[r.frame] ?? [0, 0];
    const [tu, tv] = fit.translations[r.frame] ?? [0, 0];
    const predU = (1 + su) * Pu + tu;
    const predV = (1 + sv) * (Math.cos(r.theta) * Pv - Math.sin(r.theta) * Pz) + tv;
    acc += (r.x - predU) ** 2 + (r.y - predV) ** 2;
    n++;
  }
  return n ? Math.sqrt(acc / n) : Number.POSITIVE_INFINITY;
}

function solve3(A: number[][], y: number[]): [number, number, number] {
  const n = 3;
  const M = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const v = new Array<number>(n).fill(0);
  for (let i = 0; i < A.length; i++) {
    for (let a = 0; a < n; a++) {
      v[a] += A[i][a] * y[i];
      for (let b = 0; b < n; b++) M[a][b] += A[i][a] * A[i][b];
    }
  }
  for (let a = 0; a < n; a++) M[a][a] += 1e-9;
  const S = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < n; col++) {
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = S[r][col] / S[col][col];
      for (let c = col; c <= n; c++) S[r][c] -= f * S[col][c];
    }
  }
  return [S[0][3] / S[0][0], S[1][3] / S[1][1], S[2][3] / S[2][2]];
}

export interface SwapReport {
  keyA: string;
  keyB: string;
  between: [number, number];
  residualGain: number;
  suggested: boolean;
}

/**
 * 轨迹身份交换检测：在指定帧区间交换两个轨迹身份后，
 * 全局重投影 RMS 是否显著下降。
 */
export function detectIdentitySwap(
  observations: Observation3DInput[],
  keyA: string,
  keyB: string,
  keyOf: (bead: number) => string,
  beadOfKey: (key: string) => number,
  between: [number, number]
): SwapReport {
  const before = fitRegistration({ axis: { axisAngleDeg: 0, offset: 0 }, observations, variant: 'rigid' });
  const swapped = observations.map((o) => {
    if (o.frame < between[0] || o.frame > between[1]) return o;
    const key = keyOf(o.bead);
    if (key === keyA) return { ...o, bead: beadOfKey(keyB) };
    if (key === keyB) return { ...o, bead: beadOfKey(keyA) };
    return o;
  });
  const after = fitRegistration({ axis: { axisAngleDeg: 0, offset: 0 }, observations: swapped, variant: 'rigid' });
  const gain = before.rms - after.rms;
  return {
    keyA,
    keyB,
    between,
    residualGain: gain,
    suggested: gain > 0.5
  };
}

/** 共同有效点集：候选间公平比较的基准 */
export function commonPointSet(
  variants: { excludedFrames: number[]; observations: Observation3DInput[] }[]
): { bead: number; frame: number }[] {
  let common: { bead: number; frame: number }[] | null = null;
  for (const v of variants) {
    const ex = new Set(v.excludedFrames);
    const set = v.observations
      .filter((o) => o.w > 0 && !ex.has(o.frame))
      .map((o) => ({ bead: o.bead, frame: o.frame }));
    if (!common) {
      common = set;
    } else {
      const have = new Set(set.map((s) => `${s.bead}:${s.frame}`));
      common = common.filter((s) => have.has(`${s.bead}:${s.frame}`));
    }
  }
  return common ?? [];
}

export { rmsOnSubset };
