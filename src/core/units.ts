/**
 * 导入时保留原始表示；只有能明确转换的值才规范化。
 * 无法转换的值留在原位置（value=null）并附诊断，绝不为画图而丢弃。
 */
import type { AngleUnit, DoseUnit, LengthUnit, Measure } from './types';

const ANGLE_TO_DEG: Record<AngleUnit, number> = { deg: 1, rad: 180 / Math.PI, grad: 0.9 };
const LENGTH_TO_NM: Record<LengthUnit, number> = { nm: 1, um: 1000, angstrom: 0.1, pixel: NaN };
const DOSE_TO_E_PER_A2: Record<DoseUnit, number> = { 'e-/A^2': 1, 'e-/nm^2': 0.01 };

export function measure(rawValue: unknown, unit: string, datum?: string): Measure {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue);
  const num = Number(raw);
  return { raw, value: Number.isFinite(num) ? num : null, unit, datum, ...(Number.isFinite(num) ? {} : { diagnostic: 'unparseable-numeric-value' }) };
}

export function normalizeAngle(measure: Measure): Measure {
  if (measure.value === null) return measure;
  const factor = ANGLE_TO_DEG[measure.unit as AngleUnit];
  if (!factor) return { ...measure, diagnostic: measure.diagnostic ?? `unknown-angle-unit:${measure.unit}` };
  return { ...measure, value: measure.value * factor, unit: 'deg' };
}

export function normalizePixelScale(measure: Measure): Measure {
  if (measure.value === null) return measure;
  const factor = LENGTH_TO_NM[measure.unit as LengthUnit];
  if (!Number.isFinite(factor)) {
    return { ...measure, diagnostic: measure.diagnostic ?? 'pixel-scale-requires-known-length-unit' };
  }
  return { ...measure, value: measure.value * factor, unit: 'nm/px' };
}

export function normalizeDose(measure: Measure): Measure {
  if (measure.value === null) return measure;
  const factor = DOSE_TO_E_PER_A2[measure.unit as DoseUnit];
  if (!factor) return { ...measure, diagnostic: measure.diagnostic ?? `unknown-dose-unit:${measure.unit}` };
  return { ...measure, value: measure.value * factor, unit: 'e-/A^2' };
}

export function isUnconverted(measure: Measure): boolean {
  return measure.value === null || !!measure.diagnostic;
}
