// 派生层的单位/坐标基准规范化。导入层保留原始表示；无法转换的值留在原位置并附诊断。
export interface Quantity {
  value: number;
  unit: string;
  basis?: string;
}

export interface UnitDiagnostic {
  field: string;
  reason: string;
  raw: Quantity;
}

type Normalized =
  | { ok: true; value: number; normalizedUnit: string }
  | { ok: false; diagnostic: UnitDiagnostic };

const ANGLE_TO_RAD: Record<string, number> = { deg: Math.PI / 180, rad: 1, mrad: 1e-3 };
const LENGTH_TO_NM_PER_PX: Record<string, number> = { 'nm/pixel': 1, 'A/pixel': 0.1, 'pm/pixel': 0.001 };
const DOSE_TO_E_PER_A2: Record<string, number> = { 'e-/A^2': 1, 'e-/nm^2': 0.01 };

function convert(q: Quantity, table: Record<string, number>, normalizedUnit: string, field: string): Normalized {
  const factor = table[q.unit];
  if (factor === undefined) {
    return {
      ok: false,
      diagnostic: { field, reason: `无法转换的单位: ${q.unit}（目标 ${normalizedUnit}），原始值保留在原位置`, raw: q },
    };
  }
  return { ok: true, value: q.value * factor, normalizedUnit };
}

export function normalizeAngle(q: Quantity, field = 'tiltAngle'): Normalized {
  return convert(q, ANGLE_TO_RAD, 'rad', field);
}

export function normalizePixelSize(q: Quantity, field = 'pixelSize'): Normalized {
  return convert(q, LENGTH_TO_NM_PER_PX, 'nm/pixel', field);
}

export function normalizeDose(q: Quantity, field = 'accumulatedDose'): Normalized {
  return convert(q, DOSE_TO_E_PER_A2, 'e-/A^2', field);
}
