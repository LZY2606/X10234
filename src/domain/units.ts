import type { Quantity } from './types';

const DEG = 'deg';
const ANGSTROM = `e-/\u00c5^2`;
/**
 * 导入层保留原始表示；派生层才做规范化。
 * 无法转换的值留在原位置并附诊断，绝不为画图而丢弃。
 */
const ANGLE_TO_DEG: Record<string, number> = {
  deg: 1, degree: 1, degrees: 1, ['\u00b0']: 1,
  rad: 180 / Math.PI, radian: 180 / Math.PI
};
const DOSE_PER_A2: Record<string, number> = {
  'e-/A^2': 1, 'e/A^2': 1, [ANGSTROM]: 1, ['e/\u00c5^2']: 1
};
const SCALE_TO_NM_PER_PX: Record<string, number> = {
  'nm/px': 1, 'A/px': 0.1, ['\u00c5/px']: 0.1, 'um/px': 1000
};

function make(raw: string, value: number | null, unit: string | null, basis: string | undefined,
             unconvertible: boolean, diagnostic?: string): Quantity {
  return { value, unit, basis, raw, unconvertible, diagnostic };
}

export function parseAngle(raw: string, signConvention: string): Quantity {
  const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*(\S+)\s*$/);
  if (!m) return make(raw, null, null, undefined, true, `unparseable-angle:${raw}`);
  const f = ANGLE_TO_DEG[m[2]];
  if (f === undefined) return make(raw, null, null, `angle:${signConvention}`, true, `unknown-angle-unit:${m[2]}`);
  return make(raw, Number(m[1]) * f, DEG, `angle:${signConvention}`, false);
}

export function parseDose(raw: string): Quantity {
  const m = raw.match(/^\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(\S+)\s*$/);
  if (!m) return make(raw, null, null, 'dose:specimen', true, `unparseable-dose:${raw}`);
  const f = DOSE_PER_A2[m[2]];
  if (f === undefined) return make(raw, null, null, 'dose:specimen', true, `unknown-dose-unit:${m[2]}`);
  return make(raw, Number(m[1]) * f, ANGSTROM, 'dose:specimen', false);
}

export function parsePixelScale(raw: string): Quantity {
  const m = raw.match(/^\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(\S+)\s*$/);
  if (!m) return make(raw, null, null, 'px->specimen', true, `unparseable-pixel-scale:${raw}`);
  const f = SCALE_TO_NM_PER_PX[m[2]];
  if (f === undefined) return make(raw, null, null, 'px->specimen', true, `unknown-scale-unit:${m[2]}`);
  return make(raw, Number(m[1]) * f, 'nm/px', 'px@originTopLeft->specimen', false);
}

export function quantitySummary(q: Quantity): string {
  return q.unconvertible ? `raw=${q.raw} (UNCONVERTIBLE:${q.diagnostic})`
    : `${q.value}${q.unit} [raw=${q.raw}]`;
}
