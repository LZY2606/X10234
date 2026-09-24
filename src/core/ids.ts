import { randomBytes } from 'node:crypto';
import type { StableId } from '../shared/types';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function encodeTime(now: number, len: number): string {
  let str = '';
  let t = now;
  for (let i = len - 1; i >= 0; i--) {
    str = ENCODING[t % 32] + str;
    t = Math.floor(t / 32);
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let str = '';
  for (let i = 0; i < len; i++) str += ENCODING[bytes[i]! % 32];
  return str;
}

/** ULID：单调、时间有序的稳定 ID（不依赖行号/导入顺序） */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

export function makeId(kind: string, now?: number): StableId {
  return `${kind}:${ulid(now)}`;
}
