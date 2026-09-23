import type { Quantity } from './types';

// 派生层的规范化：原始表示在导入时保留，只有派生层做单位换算。
export type Dimension = 'angle' | 'length' | 'dose' | 'length-per-pixel';

export const CANONICAL_UNIT: Record<Dimension, string> = {
  angle: 'rad',
  length: 'nm',
  dose: 'e-/nm^2',
  'length-per-pixel': 'nm/pixel',
};

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  degree: Math.PI / 180,
  deg: Math.PI / 180,
  mrad: 1e-3,
};

const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  angstrom: 0.1,
  pm: 0.001,
};

const DOSE_TO_NM2: Record<string, number> = {
  'e-/nm^2': 1,
  'e-/A^2': 100,
  'e-/angstrom^2': 100,
};

const LPP_TO_NM: Record<string, number> = {
  'nm/pixel': 1,
  'angstrom/pixel': 0.1,
};

const TABLES: Record<Dimension, Record<string, number>> = {
  angle: ANGLE_TO_RAD,
  length: LENGTH_TO_NM,
  dose: DOSE_TO_NM2,
  'length-per-pixel': LPP_TO_NM,
};

export interface NormResult {
  ok: boolean;
  value?: number;
  unit?: string;
  diagnostic?: string;
}

export function normalize(q: Quantity, dimension: Dimension): NormResult {
  const table = TABLES[dimension];
  const factor = table[q.unit];
  if (factor === undefined) {
    return {
      ok: false,
      diagnostic: `无法把单位 "${q.unit}" 换算到 ${dimension} 的规范单位 "${CANONICAL_UNIT[dimension]}"，原始值保留在原位置`,
    };
  }
  return { ok: true, value: q.value * factor, unit: CANONICAL_UNIT[dimension] };
}
