import { createHash, randomUUID } from "node:crypto";

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 内容寻址的不可变原始内容身份：同一份原始片段只存一份。 */
export function blobIdFor(bytes: Buffer): string {
  return `blob_${sha256Hex(bytes).slice(0, 24)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** 事件身份：由顺序号与内容哈希共同决定，导出/再导入后保持稳定。 */
export function eventIdFor(seq: number, type: string, payload: string): string {
  const h = sha256Hex(`${seq}|${type}|${payload}`).slice(0, 12);
  return `evt_${seq}_${h}`;
}

/** 有效点集身份：候选之间只能用相同有效点集比较。 */
export function effectiveSetKey(pairs: Array<{ markerId: string; frameIndex: number }>): string {
  const norm = pairs
    .map((p) => `${p.markerId}@${p.frameIndex}`)
    .sort()
    .join(",");
  return `eps_${sha256Hex(norm).slice(0, 16)}`;
}
