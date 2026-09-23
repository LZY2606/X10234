/**
 * 领域量一律携带单位/坐标基准，并保留导入时的原始表示。
 * 规范化只发生在派生层；无法转换的值留在原位置并附诊断，而不是被丢弃。
 */
export interface Quantity {
  value: number | null;
  unit: string;
  raw: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  atField: string;
}

const ANGLE_TO_RADIAN: Record<string, number> = {
  radian: 1,
  rad: 1,
  degree: Math.PI / 180,
  deg: Math.PI / 180,
  "°": Math.PI / 180,
  mrad: 1e-3,
};

const SCALE_TO_NM_PER_PIXEL: Record<string, number> = {
  "nm/pixel": 1,
  "nm/pix": 1,
  "A/pixel": 0.1,
  "A/pix": 0.1,
  "angstrom/pixel": 0.1,
  "um/pixel": 1000,
  "µm/pixel": 1000,
};

const DOSE_TO_E_PER_A2: Record<string, number> = {
  "e/A^2": 1,
  "electron/A^2": 1,
  "e/nm^2": 0.01,
};

function convert(q: Quantity, table: Record<string, number>, target: string): { value: number } | null {
  if (q.value === null || !Number.isFinite(q.value)) return null;
  const f = table[q.unit];
  const g = table[target];
  if (f === undefined || g === undefined) return null;
  return { value: (q.value * f) / g };
}

export function normalizeAngle(q: Quantity): number | null {
  return convert(q, ANGLE_TO_RADIAN, "radian")?.value ?? null;
}
export function angleInDegrees(q: Quantity): number | null {
  const rad = normalizeAngle(q);
  return rad === null ? null : (rad * 180) / Math.PI;
}
export function normalizePixelScale(q: Quantity): number | null {
  return convert(q, SCALE_TO_NM_PER_PIXEL, "nm/pixel")?.value ?? null;
}
export function normalizeDose(q: Quantity): number | null {
  return convert(q, DOSE_TO_E_PER_A2, "e/A^2")?.value ?? null;
}

export function diagnoseQuantity(q: Quantity, atField: string, kind: "angle" | "scale" | "dose"): Diagnostic | null {
  if (q.value === null || !Number.isFinite(q.value)) {
    return { code: "UNPARSEABLE_VALUE", message: `无法解析的数值，保留原始表示: ${q.raw}`, atField };
  }
  const table = kind === "angle" ? ANGLE_TO_RADIAN : kind === "scale" ? SCALE_TO_NM_PER_PIXEL : DOSE_TO_E_PER_A2;
  if (table[q.unit] === undefined) {
    return { code: "UNKNOWN_UNIT", message: `未知单位 ${q.unit}，原始表示保留在原处`, atField };
  }
  return null;
}

export function qty(value: number | null, unit: string, raw?: string): Quantity {
  return { value, unit, raw: raw ?? String(value === null ? "" : value) };
}
