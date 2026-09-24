import { createHash } from 'node:crypto';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Json(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** 规范 JSON：键排序、无多余空白，保证内容摘要确定且可复算 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function digestPrefix(digest: string, len = 12): string {
  return digest.slice(0, len);
}
