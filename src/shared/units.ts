import type { Diagnostic, Quantity, Unit } from './types.js';

/** 派生层规范化：把任意可识别单位换算到目标单位；无法转换的值留在原位置并附诊断。 */
const CONVERSIONS: Record<string, Record<string, number>> = {
  'mrad': { 'deg': 180 / Math.PI / 1000 },
  'deg': { 'mrad': 1000 * Math.PI / 180 },
  'A/px': { 'nm/px': 0.1 },
  'nm/px': { 'A/px': 10 },
  'e-/nm^2': { 'e-/A^2': 0.01 },
  'e-/A^2': { 'e-/nm^2': 100 },
};

export function canConvert(from: string, to: string): boolean {
  return from === to || !!CONVERSIONS[from]?.[to];
}

export function convert(value: number, from: string, to: string): number {
  if (from === to) return value;
  const factor = CONVERSIONS[from]?.[to];
  if (factor === undefined) throw new Error(`cannot convert ${from} -> ${to}`);
  return value * factor;
}

export interface NormalizeResult {
  normalized: Quantity | null;
  diagnostic: Diagnostic | null;
}

/** 规范化一个量；不可转换时返回 null + 诊断，调用方必须保留原始值在原位置。 */
export function normalizeQuantity(
  q: { value: number; unit: string },
  target: Unit,
  location: string,
): NormalizeResult {
  if (canConvert(q.unit, target)) {
    return { normalized: { value: convert(q.value, q.unit, target), unit: target }, diagnostic: null };
  }
  return {
    normalized: null,
    diagnostic: {
      code: 'UNIT_UNCONVERTIBLE',
      message: `单位 ${q.unit} 无法换算为 ${target}，原始值保留在原位置`,
      location,
      raw: q,
    },
  };
}
