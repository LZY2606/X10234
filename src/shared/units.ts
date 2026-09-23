import type { MeasuredValue } from './domain';

// 派生层才做规范化；无法转换的值留在原位置并附诊断，绝不为画图而丢弃。
export function measured(rawText: string, unit: string, rawValue?: number | string): MeasuredValue {
  return { value: rawValue ?? rawText, rawText, unit };
}

function withDiag(m: MeasuredValue, diag: string): MeasuredValue {
  return { ...m, diagnostic: diag };
}

export function toAngleDeg(m: MeasuredValue): MeasuredValue {
  if (typeof m.value !== 'number' && typeof m.value !== 'string') return withDiag(m, 'non-numeric angle');
  const v = typeof m.value === 'number' ? m.value : Number(String(m.value).trim());
  if (!Number.isFinite(v)) return withDiag(m, `unparseable angle "${m.rawText}"`);
  const u = m.unit.trim().toLowerCase();
  if (u === 'deg' || u === 'degree' || u === 'degrees') return { ...m, canonical: v, canonicalUnit: 'deg' };
  if (u === 'rad') return { ...m, canonical: (v * 180) / Math.PI, canonicalUnit: 'deg' };
  return withDiag(m, `unknown angle unit "${m.unit}"`);
}

const LENGTH_TO_PIXEL: Record<string, number> = {
  nm: 1, a: 0.1, um: 1000, pixel: 1
};

/** 像素尺度：原始为 “长度/像素”，规范化为 nm/pixel。 */
export function toScaleNmPerPixel(m: MeasuredValue): MeasuredValue {
  const v = typeof m.value === 'number' ? m.value : Number(String(m.value).trim());
  if (!Number.isFinite(v)) return withDiag(m, `unparseable pixel scale "${m.rawText}"`);
  const u = m.unit.trim().toLowerCase().replace('²', '^2');
  const match = u.match(/^(nm|um|a|pixel)\s*\/?\s*pixel$/);
  if (!match) return withDiag(m, `unknown pixel-scale unit "${m.unit}"`);
  const factor = LENGTH_TO_PIXEL[match[1]];
  if (factor === undefined) return withDiag(m, `unconvertible length unit "${match[1]}"`);
  return { ...m, canonical: v * factor, canonicalUnit: 'nm/pixel' };
}

export function toDoseEA2(m: MeasuredValue): MeasuredValue {
  const v = typeof m.value === 'number' ? m.value : Number(String(m.value).trim());
  if (!Number.isFinite(v)) return withDiag(m, `unparseable dose "${m.rawText}"`);
  const u = m.unit.trim().toLowerCase().replace('²', '^2').replace('å', 'a').replace('²', '^2');
  if (u === 'e/a^2') return { ...m, canonical: v, canonicalUnit: 'e/A^2' };
  if (u === 'e/nm^2') return { ...m, canonical: v / 100, canonicalUnit: 'e/A^2' };
  return withDiag(m, `unknown dose unit "${m.unit}"`);
}

/** 标记点坐标规范化到像素；不同坐标基准必须显式声明。 */
export function toPixelCoord(m: MeasuredValue, basis: string, binning: number): MeasuredValue {
  const v = typeof m.value === 'number' ? m.value : Number(String(m.value).trim());
  if (!Number.isFinite(v)) return withDiag(m, `unparseable coordinate "${m.rawText}"`);
  if (basis === 'pixel-index') return { ...m, canonical: v, canonicalUnit: 'pixel' };
  if (basis === 'binned-pixel') return { ...m, canonical: v * binning, canonicalUnit: 'pixel' };
  return withDiag(m, `cannot convert basis "${basis}" to pixel without calibration`);
}
