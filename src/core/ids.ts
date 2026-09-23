import crypto from "node:crypto";

export function sha256(buf: Uint8Array | Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function stableId(prefix: string, ...parts: Array<string | number>): string {
  const h = sha256(parts.join("|"));
  return `${prefix}_${h.slice(0, 12)}`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

/** 内容摘要：查询实体时随版本号一起返回。 */
export function digestSummary(obj: unknown): string {
  return sha256(canonicalJson(obj)).slice(0, 16);
}

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`).join(",")}}`;
}
