import { createHash } from 'node:crypto';

export function sha256Hex(buf: Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

export function stableId(prefix: string, unique: string): string {
  return `${prefix}_${sha256Hex(unique).slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function approxEqual(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}
