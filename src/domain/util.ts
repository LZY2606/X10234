import { createHash } from 'node:crypto';

let counter = 0;
export function newUid(prefix: string): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}${counter.toString(36)}`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data as Uint8Array).digest('hex');
}

export function canonicalDigest(value: unknown): string {
  const canon = canonicalStringify(value);
  return sha256Hex(canon).slice(0, 24);
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function pointSetHash(members: { frameUid: string; markUid: string }[]): string {
  const lines = members
    .map((m) => `${m.frameUid}:${m.markUid}`)
    .sort()
    .join('|');
  return sha256Hex(lines).slice(0, 20);
}

export function commonPointSetHash(hashes: string[]): string {
  return `common:${sha256Hex(hashes.slice().sort().join('&')).slice(0, 16)}`;
}
