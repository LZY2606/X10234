import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 稳定 ID：导出/删除/再导入后保持一致（语义键哈希，非自增主键） */
export function stableId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}_${sha256Hex(parts.join("|")).slice(0, 16)}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
