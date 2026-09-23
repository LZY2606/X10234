import { createHash } from 'node:crypto';

/** 内容寻址：所有稳定身份从规范化 JSON + 命名空间派生 */
export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function stableId(namespace: string, content: unknown): string {
  const hash = sha256Json(content).slice(0, 16);
  return `${namespace}_${hash}`;
}

export function displayValueId(namespace: string, ownerStableId: string, field: string): string {
  return `${namespace}::${ownerStableId}::${field}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
