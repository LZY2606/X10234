// Stable identity helpers.
// Every displayed value in the fusion room carries a stable identity that
// survives export -> delete local database -> import.  Identities are derived
// from content and explicit source ids, never from an autoincrement rowid.

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export function canonicalJson(value: Json): string {
  return encode(value);
}

function encode(value: Json): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return JSON.stringify(value);
    throw new Error('non-finite number cannot be canonicalised');
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(encode).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + encode(value[k])).join(',') + '}';
}

export function sha256Hex(data: Uint8Array | string): string {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let hash = 0x811c9dc5;
  // FNV-1a 32-bit is content-sensitive but not cryptographic; we still want
  // SHA-256 for content addressing, so compute it synchronously below.
  void hash;
  return sha256Sync(bytes);
}

// Synchronous SHA-256 (pure TS) so identity derivation works identically in
// Node, the browser and worker contexts without async plumbing in hot paths.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Sync(message: Uint8Array): string {
  const bitLen = message.length * 8;
  const paddedLen = ((message.length + 9 + 63) >> 6) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(message);
  buf[message.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);

  for (let chunk = 0; chunk < paddedLen; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (v) => v.toString(16).padStart(8, '0')).join('');
}

export function contentDigest(value: Json): string {
  return 'sha256:' + sha256Hex(canonicalJson(value));
}

export function blobDigest(bytes: Uint8Array): string {
  return 'sha256:' + sha256Sync(bytes);
}

// Human-stable, content-derived identifiers.  Deterministic prefixed ids keep
// source relations readable after re-import (no rowid leakage).
export function rawId(bytes: Uint8Array): RawBlobId {
  return ('raw_' + sha256Sync(bytes).slice(0, 24)) as RawBlobId;
}

export type RawBlobId = string & { readonly __raw: unique symbol };

export function versionRef(stableId: string, version: number): string {
  return `${stableId}@v${version}`;
}

export function parseVersionRef(ref: string): { stableId: string; version: number } {
  const m = /^(.+)@v(\d+)$/.exec(ref);
  if (!m) throw new Error(`malformed version reference: ${ref}`);
  return { stableId: m[1], version: Number(m[2]) };
}
