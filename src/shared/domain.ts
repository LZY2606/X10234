/**
 * 领域量规范化：导入时保留原始表示；规范化只发生在派生层。
 * 无法转换的值留在原位置并附诊断，绝不为画图丢弃。
 */
import type { DimensionedQuantity, Unit } from './types';

export function parseDQ(raw: string, expected: Unit): DimensionedQuantity {
  const text = String(raw ?? '').trim();
  const numMatch = text.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  if (!numMatch) {
    return { raw: text, unit: expected, diagnostic: `UNCONVERTIBLE: 无法从「${text}」解析数值` };
  }
  const unitWord = text.toLowerCase();
  let unit: Unit = expected;
  let value = Number(numMatch[0]);
  if (/rad/.test(unitWord)) unit = 'radian';
  else if (/°|deg|度/.test(unitWord)) unit = 'degree';
  else if (/nm\/px|nm\/pixel|纳米/.test(unitWord)) unit = 'nm_per_pixel';
  else if (/ang|Å|埃/.test(unitWord)) unit = 'angstrom_per_pixel';
  else if (/e\/(?:Å|ang|a2|angstrom|nm|n2)/.test(unitWord)) {
    unit = /nm/.test(unitWord) ? 'e_per_nm_sq' : 'e_per_angstrom_sq';
  }
  if (unit === 'radian') value = (value * 180) / Math.PI;
  if (unit === 'angstrom_per_pixel') value = value / 10;
  if (unit === 'e_per_nm_sq') value = value / 100;
  return { raw: text, value, unit: expected === 'degree' ? 'degree' : expected === 'nm_per_pixel' ? 'nm_per_pixel' : 'e_per_angstrom_sq', diagnostic: undefined };
}

export function toDegrees(dq: DimensionedQuantity | undefined): number | null {
  if (!dq || dq.value === undefined) return null;
  if (dq.unit === 'radian') return (dq.value * 180) / Math.PI;
  return dq.value;
}

export function toNmPerPixel(dq: DimensionedQuantity | undefined): number | null {
  if (!dq || dq.value === undefined) return null;
  if (dq.unit === 'angstrom_per_pixel') return dq.value / 10;
  return dq.value;
}

export function toEPerAngstrom2(dq: DimensionedQuantity | undefined): number | null {
  if (!dq || dq.value === undefined) return null;
  if (dq.unit === 'e_per_nm_sq') return dq.value / 100;
  return dq.value;
}
