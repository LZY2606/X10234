import { deflateSync, crc32 } from "node:zlib";

/** 纯 Node 8-bit grayscale PNG 编码器（离线案例帧，无外部依赖）。 */
export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Buffer {
  if (gray.length !== width * height) throw new Error("gray size mismatch");
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter none
    gray.subarray(y * width, (y + 1) * width);
    raw.set(gray.subarray(y * width, (y + 1) * width), y * stride + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function decodeGrayPng(_png: Buffer): { width: number; height: number; gray: Uint8Array } {
  // 案例帧只由本工具编码；审阅端直接以 <img>/canvas 读取，服务端无需解码。
  throw new Error("not needed for packed frames");
}
