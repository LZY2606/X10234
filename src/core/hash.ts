function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 稳定的 canonical JSON：对象键排序、无多余空白，Uint8Array 标记为二进制 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Uint8Array) {
    return JSON.stringify({ __bin: bytesToHex(value) });
  }
  if (ArrayBuffer.isView(value)) {
    return JSON.stringify({ __bin: bytesToHex(new Uint8Array(value.buffer as ArrayBuffer)) });
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return 'null';
}

export interface HashSink {
  update(data: Uint8Array): void;
  digest(): Promise<Uint8Array> | Uint8Array;
}

async function webDigest(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return webDigest(bytes);
}

export async function sha256Canonical(value: unknown): Promise<string> {
  return sha256(utf8(canonicalJson(value)));
}

/** 有效点集等集合的稳定摘要 */
export async function stableDigest(parts: unknown[]): Promise<string> {
  return sha256Canonical(parts);
}
