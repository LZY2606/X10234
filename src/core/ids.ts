import { createHash } from "node:crypto";

/** 内容寻址哈希：共享原始片段只存一份不可变内容 */
export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 稳定身份：领域前缀 + 确定性内容哈希片段，导出/再导入后保持不变 */
export function stableId(prefix: string, content: string): string {
  return `${prefix}_${sha256(content).slice(0, 16)}`;
}

/** 规范化 JSON（键排序），保证内容摘要与属性顺序无关 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentSummary(value: unknown): string {
  return sha256(canonicalJson(value));
}
