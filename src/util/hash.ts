/**
 * 稳定内容哈希：32 位 FNV-1a（确定性、同步、无外部依赖）。
 * 用于内容寻址与身份；案例规模极小，碰撞风险可忽略。
 */
export function fnv1aBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const encoder = new TextEncoder();

export function stableHash(value: unknown): string {
  return fnv1aBytes(encoder.encode(canonicalJson(value)));
}

/** 键排序的规范 JSON，使哈希与对象构造顺序无关。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Uint8Array) return '"bin:' + Array.from(value).join(',') + '"';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
