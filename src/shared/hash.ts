import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash('sha256');
  h.update(data);
  return h.digest('hex');
}

export function shortHash(data: string | Uint8Array): string {
  return sha256Hex(data).slice(0, 12);
}

/** 规范化 JSON（键排序），保证内容寻址在导入导出后稳定。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = sortValue((v as Record<string, unknown>)[key]);
    }
    return out;
  }
  return v;
}

export function digestOf(value: unknown): string {
  return shortHash(canonicalJson(value));
}
