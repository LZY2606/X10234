import { createHash } from "node:crypto";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** 规范序列化：键排序，保证跨实现稳定 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 稳定身份：带领域前缀的短哈希（显示值都要带稳定身份） */
export function stableId(prefix: string, payload: unknown): string {
  return `${prefix}:${sha256Json(payload).slice(0, 12)}`;
}

export function contentSummary(value: unknown): string {
  const digest = sha256Json(value);
  return `sha256:${digest.slice(0, 16)}`;
}
