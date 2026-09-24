import { createHash } from "node:crypto";

/** 内容摘要：sha256，取前 16 位作为展示用短摘要 */
export function digestOf(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function shortDigest(content: string | Buffer): string {
  return digestOf(content).slice(0, 16);
}

/** 稳定身份：由命名空间 + 内容摘要派生，导出/删除/再导入后保持不变 */
export function stableId(namespace: string, content: string): string {
  return `${namespace}_${createHash("sha256").update(namespace + ":" + content).digest("hex").slice(0, 20)}`;
}

/**  canonical JSON：键排序，保证同一内容得到同一摘要 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
