import { createHash } from 'node:crypto';

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 稳定的规范化序列化：键排序，保证跨导入/重导入字节一致 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/** 由显式输入决定的确定性事件 id，使导出→删库→导入后 id 完全一致 */
export function deterministicId(prefix: string, material: unknown): string {
  return `${prefix}_${sha256Json(material).slice(0, 16)}`;
}
