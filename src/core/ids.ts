/**
 * 稳定身份工具。
 * 身份由内容/业务键确定性派生，不依赖插入顺序或自增主键，
 * 这样“导出 -> 删除本地数据库 -> 重新导入”后身份、顺序与来源关系保持。
 */

export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function fnv1a64(input: string): string {
  // 双段 32 位 FNV-1a（第二段取不同初值），拼成 64bit hex，降低碰撞概率。
  const lo = fnv1a(input);
  let h = 0xcbf29ce4;
  const s = '#' + input;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + lo;
}

export type StableId = string;

export function contentId(bytes: Uint8Array): StableId {
  return 'sha256:' + fnv1a64('content:' + bytesToAsciiSafe(bytes));
}

/** 二进制安全地参与哈希：逐字节编码，不依赖 TextDecoder。 */
export function bytesToAsciiSafe(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

export function jsonDigest(value: unknown): string {
  return fnv1a64('json:' + stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

let seqCounter = 0;
/** 事件号需要可复现（重放/导入导出），因此由调用方提供逻辑时钟。 */
export function localNonce(seed = 'proc'): string {
  seqCounter += 1;
  return `${seed}-${Date.now().toString(36)}-${seqCounter}`;
}
