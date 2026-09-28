import { deflateSync } from "node:zlib";

/** 8-bit grayscale PNG 编码器（零依赖），用于离线合成倾转帧 */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height) throw new Error("pixel-size-mismatch");

  const stride = width + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * stride + 1);
  }
  const idat = deflateSync(raw, { level: 6 });

  const chunks: Uint8Array[] = [];
  chunks.push(signature());
  chunks.push(chunk("IHDR", ihdr(width, height)));
  chunks.push(chunk("IDAT", idat));
  chunks.push(chunk("IEND", new Uint8Array(0)));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const signature = (): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  dv.setUint8(8, 8); // bit depth
  dv.setUint8(9, 0); // grayscale
  dv.setUint8(10, 0);
  dv.setUint8(11, 0);
  dv.setUint8(12, 0);
  return b;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) dv.setUint8(4 + i, type.charCodeAt(i));
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc >>> 0);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
