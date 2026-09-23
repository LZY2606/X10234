import { createHash } from 'node:crypto';

/** 规范化 JSON：键排序、无空格，保证内容寻址跨导入一致 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 内容寻址版本号：同一内容任何时候都得到同一身份 */
export function contentVersionId(kind: string, stableId: string, content: unknown): string {
  const digest = sha256Hex(`${kind}|${stableId}|${canonicalJson(content)}`);
  return `ver_${digest.slice(0, 16)}`;
}

export function blobDigest(bytes: Uint8Array | string): string {
  return sha256Hex(bytes);
}

/** 短摘要，供查询实体时返回内容摘要 */
export function summarize(content: unknown): string {
  return sha256Hex(canonicalJson(content)).slice(0, 12);
}

export function eventId(seq: number, event: unknown): string {
  return `evt_${String(seq).padStart(5, '0')}_${sha256Hex(canonicalJson(event)).slice(0, 12)}`;
}

let counter = 0;
/** 人类可读稳定身份（同内容同 id 优先使用内容寻址；此处用于测试期生成） */
export function stableSlug(prefix: string, n: number, width = 4): string {
  counter += 1;
  return `${prefix}_${String(n).padStart(width, '0')}`;
}

export function resetSlugCounter(): void {
  counter = 0;
}
