import type { Quantity } from '../shared/types.js';

// 角度统一到 degree
export function normalizeAngle(q: Quantity<number, string>): Quantity<number, string> {
  if (q.normalized !== undefined) return q;
  if (typeof q.raw !== 'number' || Number.isNaN(q.raw)) {
    return { ...q, diagnostic: `unconvertible angle: ${String(q.raw)}` };
  }
  if (q.unit === 'degree') return { ...q, normalized: q.raw, normalizedUnit: 'degree' };
  if (q.unit === 'radian') {
    return { ...q, normalized: (q.raw * 180) / Math.PI, normalizedUnit: 'degree' };
  }
  return { ...q, diagnostic: `unknown angle unit: ${q.unit}` };
}

// 像素尺度统一到 nm/px
export function normalizePixelSize(q: Quantity<number, string>): Quantity<number, string> {
  if (q.normalized !== undefined) return q;
  if (typeof q.raw !== 'number' || Number.isNaN(q.raw)) {
    return { ...q, diagnostic: `unconvertible pixel size: ${String(q.raw)}` };
  }
  switch (q.unit) {
    case 'nm': return { ...q, normalized: q.raw, normalizedUnit: 'nm/px' };
    case 'angstrom': return { ...q, normalized: q.raw / 10, normalizedUnit: 'nm/px' };
    case 'um': return { ...q, normalized: q.raw * 1000, normalizedUnit: 'nm/px' };
    default: return { ...q, diagnostic: `unknown length unit: ${q.unit}` };
  }
}

// 剂量统一到 e/A^2；无法转换（null / 未知单位）留在原位附诊断，不丢值
export function normalizeDose(
  q: Quantity<number | null, string>
): Quantity<number | null, string> {
  if (q.normalized !== undefined) return q;
  if (q.raw === null || q.raw === undefined || Number.isNaN(q.raw as number)) {
    return { ...q, raw: q.raw ?? null, diagnostic: 'dose reading missing; retained in place' };
  }
  if (q.unit === 'e/A^2') return { ...q, normalized: q.raw as number, normalizedUnit: 'e/A^2' };
  if (q.unit === 'e/nm^2') {
    return { ...q, normalized: (q.raw as number) / 100, normalizedUnit: 'e/A^2' };
  }
  return { ...q, diagnostic: `unknown dose unit: ${q.unit}` };
}
