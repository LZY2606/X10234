import { createHash } from "node:crypto";

/**
 * 规范序列化：对象键递归排序，保证同一内容在任何机器、任何时间得到相同摘要。
 * 这是档案“稳定身份”的基础——重新导入后身份不依赖自增 rowid 或时钟。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input as any).digest("hex");
}

export function contentId(prefix: string, content: unknown): string {
  return `${prefix}_${sha256Hex(stableStringify(content)).slice(0, 16)}`;
}

export function bytesId(prefix: string, bytes: Uint8Array): string {
  return `${prefix}_${sha256Hex(bytes).slice(0, 16)}`;
}

/** 事件身份：事件是不可变事实链上的节点，id 包含前驱，形成可校验的链。 */
export function eventId(prevEventId: string | null, payload: unknown, at: string): string {
  return contentId("evt", { prevEventId, payload, at });
}

export function shortDigest(value: unknown): string {
  return sha256Hex(stableStringify(value)).slice(0, 12);
}
