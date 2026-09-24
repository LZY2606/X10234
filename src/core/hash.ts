import { createHash } from 'node:crypto';

let webCrypto: Crypto | undefined;
try {
  webCrypto = globalThis.crypto;
} catch {
  webCrypto = undefined;
}

export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  if (webCrypto?.subtle) {
    const digest = await webCrypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return createHash('sha256').update(data).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export async function contentHash(value: unknown): Promise<string> {
  return sha256(stableStringify(value));
}
