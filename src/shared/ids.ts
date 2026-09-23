import { createHash } from 'node:crypto';

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
      .join(',') +
    '}'
  );
}

export function stableRef(entityId: string, version: number): string {
  return `${entityId}@v${version}`;
}

export function parseRef(ref: string): { id: string; version: number } {
  const m = /^(.+)@v(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad entity ref: ${ref}`);
  return { id: m[1], version: Number(m[2]) };
}

export function valueIdentity(entityId: string, version: number, path: string): string {
  return `${entityId}@v${version}#${path}`;
}
