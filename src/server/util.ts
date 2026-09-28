import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input as never).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

let counter = 0;
export function stableId(prefix: string, material: unknown): string {
  counter += 1;
  return `${prefix}_${sha256Hex(canonicalJson(material)).slice(0, 16)}`;
}

export function uid(prefix: string): string {
  counter += 1;
  const rand = createHash('sha256')
    .update(`${Date.now()}:${counter}:${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
  return `${prefix}_${rand}`;
}
