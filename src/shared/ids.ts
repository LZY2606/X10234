import { createHash } from 'node:crypto';

/** 内容寻址：稳定身份来自内容哈希，导出/删除/重导入后保持一致。 */
export function contentHash(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 确定性 JSON（键排序）用于可复现的哈希与导出。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** 实体身份：种类 + 内容的哈希，跨导出/导入稳定。 */
export function entityId(kind: string, content: unknown): string {
  return `${kind}:${contentHash(canonicalJson(content)).slice(0, 24)}`;
}
