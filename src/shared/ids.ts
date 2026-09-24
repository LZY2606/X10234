// 稳定身份：所有显示值都携带稳定 ID，重新导入后保持不变。
// 采用确定性内容/结构哈希，而非自增 rowid。
import { createHash } from 'node:crypto';

export function sha256Hex(content: Uint8Array | string): string {
  const h = createHash('sha256');
  h.update(content);
  return h.digest('hex');
}

export function contentDigest(content: Uint8Array | string): string {
  return 'sha256:' + sha256Hex(content);
}

// 对规范化 JSON（键排序）做内容寻址，用于候选 / 有效点集 / 事件等稳定身份。
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function structuralId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 16)}`;
}

export const round = (x: number, digits = 6): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
