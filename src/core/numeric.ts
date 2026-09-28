/** 确定性伪随机（mulberry32），保证案例包与测试可复放 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SolveResult {
  params: number[];
  residuals: number[];
  rms: number;
  iterations: number;
}

/**
 * Gauss-Newton 最小二乘（数值雅可比）。
 * residualFn 返回每个观测的残差向量分量。
 */
export function gaussNewton(
  initial: number[],
  residualFn: (p: number[]) => number[],
  maxIter = 24,
  stepDamping = 1,
): SolveResult {
  let p = initial.slice();
  let r = residualFn(p);
  let rms = Math.sqrt(r.reduce((s, v) => s + v * v, 0) / Math.max(r.length, 1));

  const EPS = 1e-6;
  let iterations = 0;
  for (iterations = 0; iterations < maxIter; iterations++) {
    const j: number[][] = Array.from({ length: r.length }, () => new Array(p.length).fill(0));
    for (let c = 0; c < p.length; c++) {
      const old = p[c]!;
      const h = Math.max(EPS, Math.abs(old) * EPS);
      p[c] = old + h;
      const rp = residualFn(p);
      p[c] = old;
      for (let row = 0; row < r.length; row++) j[row]![c] = (rp[row]! - r[row]!) / h;
    }
    // J'J, J'r
    const n = p.length;
    const jtj = Array.from({ length: n }, () => new Array(n + 1).fill(0));
    for (let row = 0; row < r.length; row++) {
      for (let a = 0; a < n; a++) {
        const ja = j[row]![a]!;
        if (ja === 0) continue;
        jtj[a]![n]! -= ja * r[row]!;
        for (let b = 0; b < n; b++) jtj[a]![b]! += ja * j[row]![b]!;
      }
    }
    // Marquardt 阻尼 + Cholesky 求解
    for (let a = 0; a < n; a++) jtj[a]![a]! += 1e-8 * (1 + Math.abs(jtj[a]![a]!));
    let delta: number[] | null = null;
    try {
      delta = solveLinear(jtj);
    } catch {
      break;
    }
    const trial = p.map((v, i) => v + stepDamping * delta![i]!);
    const rt = residualFn(trial);
    const rtRms = Math.sqrt(rt.reduce((s, v) => s + v * v, 0) / Math.max(rt.length, 1));
    if (rtRms < rms) {
      const gain = (rms - rtRms) / Math.max(rms, 1e-12);
      p = trial;
      r = rt;
      rms = rtRms;
      if (gain < 1e-5) break;
    } else {
      // 退化为 0.5 步长尝试一次
      const half = p.map((v, i) => v + 0.5 * stepDamping * delta![i]!);
      const rh = residualFn(half);
      const rhRms = Math.sqrt(rh.reduce((s, v) => s + v * v, 0) / Math.max(rh.length, 1));
      if (rhRms < rms) {
        p = half;
        r = rh;
        rms = rhRms;
      } else break;
    }
  }
  return { params: p, residuals: r, rms, iterations };
}

/** 解对称正定增广矩阵 [A|b]，返回 x */
export function solveLinear(aug: number[][]): number[] {
  const n = aug.length;
  const l = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = aug[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (sum <= 1e-14) throw new Error("singular-normal-equation");
        l[i]![j] = Math.sqrt(sum);
      } else {
        l[i]![j] = sum / l[j]![j]!;
      }
    }
  }
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = aug[i]![n]!;
    for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!;
    y[i] = sum / l[i]![i]!;
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= l[k]![i]! * x[k]!;
    x[i] = sum / l[i]![i]!;
  }
  return x;
}

export function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
