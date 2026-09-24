import { createHash } from 'node:crypto';
import type { Digest } from './types';

/** 确定性 JSON：键排序，保证同样内容在任何环境得到同一摘要。 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Text(text: string): Digest {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): Digest {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

export function digestOf(value: unknown): Digest {
  return sha256Text(canonicalize(value));
}

let counter = 0;
export function stableId(prefix: string, digest: Digest): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${digest.slice(0, 12)}`;
}
