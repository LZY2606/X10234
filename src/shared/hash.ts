import { createHash } from "node:crypto";

/** 规范化 JSON（键排序），保证跨运行稳定哈希。 */
export function stableStringify(value: unknown): string {
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

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value as any).digest("hex");
}

export function contentHash(doc: unknown): string {
  return sha256(stableStringify(doc));
}

let counter = 0;
export function stableId(prefix: string, seed: string): string {
  counter += 1;
  return `${prefix}_${sha256(seed).slice(0, 10)}`;
}
