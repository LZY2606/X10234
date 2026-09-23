import type { Diagnostic, Quantity } from './types.ts';

// 单位规范化只在派生层进行；原始表示在导入时原样保留。
// 无法转换的值留在原位置并附诊断，绝不为了画图丢掉。

const ANGLE_TO_DEG: Record<string, number> = {
  deg: 1,
  degree: 1,
  degrees: 1,
  rad: 180 / Math.PI,
  mrad: 180 / (Math.PI * 1000)
};

const PIXEL_TO_NM: Record<string, number> = {
  'nm/px': 1,
  'A/px': 0.1,
  'angstrom/px': 0.1
};

const DOSE_TO_E_PER_A2: Record<string, number> = {
  'e-/A^2': 1,
  'e-/A2': 1,
  'e-/sqA': 1
};

export type Normalized = { quantity: Quantity | null; diagnostic: Diagnostic | null };

function convert(q: Quantity, table: Record<string, number>, targetUnit: string, at: string): Normalized {
  const factor = table[q.unit];
  if (factor === undefined) {
    return {
      quantity: null,
      diagnostic: {
        code: 'unit_unconvertible',
        message: `单位 "${q.unit}" 无法转换为 ${targetUnit}，原始值保留在原位置`,
        at,
        raw: q
      }
    };
  }
  return { quantity: { value: q.value * factor, unit: targetUnit }, diagnostic: null };
}

export function normalizeAngle(q: Quantity, at: string): Normalized {
  return convert(q, ANGLE_TO_DEG, 'deg', at);
}

export function normalizePixelScale(q: Quantity, at: string): Normalized {
  return convert(q, PIXEL_TO_NM, 'nm/px', at);
}

export function normalizeDose(q: Quantity, at: string): Normalized {
  return convert(q, DOSE_TO_E_PER_A2, 'e-/A^2', at);
}
