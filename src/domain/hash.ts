/**
 * 稳定内容寻址。使用确定性的 FNV-1a 64 位哈希（纯 JS，无平台依赖），
 * 使导出/删除/再导入后内容身份保持一致，且不依赖异步 SubtleCrypto。
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

export function hashBytes(bytes: Uint8Array): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * FNV_PRIME) & U64;
  }
  return "sha1-" + h.toString(16).padStart(16, "0");
}

const encoder = new TextEncoder();

export function hashString(text: string): string {
  return hashBytes(encoder.encode(text));
}

/** 对可序列化对象做规范化（键排序）后哈希，得到稳定内容摘要。 */
export function hashCanonical(value: unknown): string {
  return hashString(canonicalJSON(value));
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
