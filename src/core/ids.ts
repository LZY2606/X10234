import { sha256Hex, stableStringify } from './hash';

let counter = 0;

export async function derivedId(prefix: string, material: unknown): Promise<string> {
  const digest = (await sha256Hex(stableStringify(material))).slice(0, 16);
  return `${prefix}_${digest}`;
}

export async function randomId(prefix: string): Promise<string> {
  counter += 1;
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(16).slice(2, 18).padEnd(16, '0');
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`.slice(0, 48);
}
