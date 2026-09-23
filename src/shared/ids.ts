import { createHash } from 'node:crypto';

/** 稳定、可读、跨导入保持的身份；前缀即领域实体类型 */
export function stableId(kind: string, materialKey: string, discriminator = ''): string {
  const h = createHash('sha256').update(`${kind}|${materialKey}|${discriminator}`).digest('hex').slice(0, 16);
  return `${kind}_${h}`;
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256Buf(buf: Buffer | string): Buffer {
  return createHash('sha256').update(buf).digest();
}

export function shortHash(s: string, n = 16): string {
  return createHash('sha256').update(s).digest('hex').slice(0, n);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
