import { createHash } from 'node:crypto';
import type { Quantity, EventRef } from './types.ts';

export function sha256Hex(buf: Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 内容寻址：原始字节内容 id 稳定且跨导出/导入保持。 */
export function contentId(prefix: string, buf: Uint8Array): string {
  return `${prefix}_${sha256Hex(buf).slice(0, 32)}`;
}

export function fingerprint(parts: (string | number | boolean | null | undefined)[]): string {
  return sha256Hex(parts.map((p) => String(p ?? '∅')).join('|')).slice(0, 20);
}

export function eventRef(
  kind: string,
  id: string,
  version: number,
  data: unknown,
): EventRef {
  return {
    kind,
    id,
    version,
    contentSummary: sha256Hex(canonicalJson(data)).slice(0, 16),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

const ANGLE_UNITS = new Set(['deg', 'degree', '°', 'rad']);
const LENGTH_UNITS = new Set(['nm', 'um', 'µm', 'angstrom', 'Å', 'px', 'pixel']);
const DOSE_UNITS = new Set(['e/A^2', 'e/Å^2', 'e/nm^2']);
const TIME_UNITS = new Set(['s', 'sec', 'ms']);

/**
 * 解析领域量并保留原始表示。
 * 无法转换时 value=null、附 diagnostic，原始 raw 原样留在实体里。
 */
export function parseQuantity(
  raw: string,
  unit: string,
  basis: string,
  expected?: 'angle' | 'length' | 'dose' | 'time',
): Quantity {
  const text = raw.trim();
  const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.exec(text);
  if (!match) {
    return {
      raw,
      value: null,
      unit,
      basis,
      diagnostic: `unconvertible-quantity: 无法从原始表示「${raw}」解析数值（单位 ${unit}）`,
    };
  }
  const num = Number(text);
  const normalized = convertUnit(num, unit, expected);
  if (normalized === null) {
    return {
      raw,
      value: null,
      unit,
      basis,
      diagnostic: `unconvertible-quantity: 未知或不兼容单位「${unit}」（期望 ${expected ?? 'any'}）`,
    };
  }
  return { raw, value: normalized.value, unit: normalized.unit, basis };
}

function convertUnit(
  value: number,
  unit: string,
  expected?: 'angle' | 'length' | 'dose' | 'time',
): { value: number; unit: string } | null {
  const u = unit.trim();
  if (expected === 'angle') {
    if (u === 'rad') return { value: (value * 180) / Math.PI, unit: 'deg' };
    if (ANGLE_UNITS.has(u)) return { value, unit: 'deg' };
    return null;
  }
  if (expected === 'length') {
    if (!LENGTH_UNITS.has(u)) return null;
    if (u === 'angstrom' || u === 'Å') return { value, unit: 'Å' };
    return { value, unit: u };
  }
  if (expected === 'dose') {
    if (!DOSE_UNITS.has(u)) return null;
    if (u === 'e/nm^2') return { value: value * 0.01, unit: 'e/Å^2' };
    return { value, unit: 'e/Å^2' };
  }
  if (expected === 'time') {
    if (!TIME_UNITS.has(u)) return null;
    if (u === 'ms') return { value: value / 1000, unit: 's' };
    return { value, unit: 's' };
  }
  return { value, unit: u };
}

export function requireValue(q: Quantity): number {
  if (q.value === null) {
    throw new Error(q.diagnostic ?? `unconvertible quantity: ${q.raw} ${q.unit}`);
  }
  return q.value;
}
