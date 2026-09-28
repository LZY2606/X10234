import type {
  DoseUnit,
  PixelScaleUnit,
  Quantity,
  TiltAngleConvention,
} from './domain.js';

/**
 * 单位换算：只在派生层调用。
 * 无法转换时不抛掉值——返回 undefined + 诊断，原始 Quantity 保留原位。
 */

const ANGLE_TO_DEG: Record<string, number> = {
  deg: 1,
  degrees: 1,
  '°': 1,
  rad: 180 / Math.PI,
  radians: 180 / Math.PI,
};

export function normalizeAngle(q: Quantity<number>, convention: TiltAngleConvention): number {
  const factor = ANGLE_TO_DEG[q.rawUnit.trim()];
  if (factor === undefined) {
    q.conversionDiagnostic = `无法把倾角单位 ${q.rawUnit} 换算为 degrees；值保留原位`;
    return NaN;
  }
  let deg = q.rawValue * factor;
  if (convention === 'degrees/signed/geometric') {
    // 两种约定在案例中一致（显微镜台已给出带符号角）；保留显式分支便于扩展
    deg = deg;
  }
  q.normalized = { value: deg, unit: 'degrees' };
  return deg;
}

const SCALE_TO_A_PER_PX: Record<PixelScaleUnit, number> = {
  'A/pixel': 1,
  'nm/pixel': 10,
  'um/pixel': 10000,
};

export function normalizePixelScale(q: Quantity<number>): number | undefined {
  const key = q.rawUnit.trim() as PixelScaleUnit;
  const factor = SCALE_TO_A_PER_PX[key];
  if (factor === undefined) {
    q.conversionDiagnostic = `无法把像素尺度单位 ${q.rawUnit} 换算为 A/pixel；值保留原位`;
    return undefined;
  }
  const v = q.rawValue * factor;
  q.normalized = { value: v, unit: 'A/pixel' };
  return v;
}

const DOSE_TO_E_PER_A2: Record<DoseUnit, number | null> = {
  'e-/A^2': 1,
  'e-/nm^2': 0.01, // 1 e-/nm² = 0.01 e-/Å²
  'counts/frame': null, // 没有标定增益时不可换算
};

export function normalizeDose(q: Quantity<number>): number | undefined {
  const key = q.rawUnit.trim() as DoseUnit;
  if (!(key in DOSE_TO_E_PER_A2)) {
    q.conversionDiagnostic = `无法把剂量单位 ${q.rawUnit} 换算为 e-/A^2；值保留原位`;
    return undefined;
  }
  const factor = DOSE_TO_E_PER_A2[key];
  if (factor === null) {
    q.conversionDiagnostic =
      `剂量单位 ${q.rawUnit} 缺少计数->电子数标定，保留原始计数，不为画图而丢弃`;
    return undefined;
  }
  const v = q.rawValue * factor;
  q.normalized = { value: v, unit: 'e-/A^2' };
  return v;
}

/** binning 坐标基准 -> 相对 raw 的倍数 */
export function datumBinFactor(datum: string): number {
  const m = /binned:(\d+)/.exec(datum);
  if (m) return Number(m[1]);
  return 1; // unbinned / binned:1
}

export function toRawFramePx(x: number, datum: string): number {
  return x * datumBinFactor(datum);
}
