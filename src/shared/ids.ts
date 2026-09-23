import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// 规范化 JSON（键排序），保证内容寻址跨进程稳定
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

export function contentDigest(value: unknown): string {
  return 'sha256:' + sha256Hex(canonicalJson(value));
}

export function blobDigest(bytes: Uint8Array): string {
  return 'sha256:' + sha256Hex(bytes);
}

export function stableObjectId(kind: string, digest: string): string {
  return `${kind}_${digest.slice(7, 19)}`;
}

export function eventId(seq: number, digest: string): string {
  return `evt_${String(seq).padStart(5, '0')}_${digest.slice(7, 15)}`;
}
