import { createHash, randomUUID } from "node:crypto";

export type Uid = string;

export function digestOf(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableId(prefix: string, ...parts: Array<string | number>): Uid {
  const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

export function newId(prefix: string): Uid {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
