import { createHash } from 'node:crypto';

// 规范化 JSON（键排序）后取 sha256，作为内容摘要 / 内容寻址身份。
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      o[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
