/**
 * 最简 8-bit grayscale PNG 编码（确定性、无第三方依赖）。
 * 使用 node:zlib 做 deflate；浏览器侧不编码（帧图由后端以 data URL 提供）。
 */
import zlib from "node:zlib";
import type { GrayImage } from "./geometry.js";

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + len, crc32(out.subarray(4, 8 + len)));
  return out;
}

export function encodePngGray(img: GrayImage): Buffer {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.width);
  dv.setUint32(4, img.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = img.width + 1;
  const raw = Buffer.alloc(stride * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * stride] = 0;
    img.data.subarray(y * img.width, (y + 1) * img.width).forEach((v, i) => {
      raw[y * stride + 1 + i] = v;
    });
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
