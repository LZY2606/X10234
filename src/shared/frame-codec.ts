/**
 * 领域原始帧格式 GSBFRM1（二进制，小端，uint16 灰度）。
 * 仓库案例包使用该格式，不拿通用表格替代领域材料。
 *
 * 布局：
 *   magic "GSBFRM1" (8B) | width u32 | height u32 | depth u8(=16) |
 *   acquisitionIndex u32 | reserved[15] | pixels u16[width*height]
 */
export const GSB_MAGIC = Buffer.from('GSBFRM1');
export const HEADER_LEN = 8 + 4 + 4 + 1 + 4 + 15;

export interface GsbFrame {
  width: number;
  height: number;
  acquisitionIndex: number;
  pixels: Uint16Array;
}

export function encodeFrame(width: number, height: number, acquisitionIndex: number, pixels: Uint16Array): Buffer {
  if (pixels.length !== width * height) throw new Error(`frame pixel count mismatch: ${pixels.length} != ${width * height}`);
  const buf = Buffer.alloc(HEADER_LEN + pixels.length * 2);
  GSB_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(width, 8);
  buf.writeUInt32LE(height, 12);
  buf.writeUInt8(16, 16);
  buf.writeUInt32LE(acquisitionIndex, 17);
  for (let i = 0; i < pixels.length; i++) buf.writeUInt16LE(pixels[i], HEADER_LEN + i * 2);
  return buf;
}

export function decodeFrame(buf: Buffer): GsbFrame {
  if (buf.length < HEADER_LEN || !buf.subarray(0, 8).equals(GSB_MAGIC)) {
    throw new Error('bad GSBFRM1 magic');
  }
  const width = buf.readUInt32LE(8);
  const height = buf.readUInt32LE(12);
  const depth = buf.readUInt8(16);
  const acquisitionIndex = buf.readUInt32LE(17);
  if (depth !== 16) throw new Error(`unsupported bit depth ${depth}`);
  if (buf.length !== HEADER_LEN + width * height * 2) throw new Error('corrupt GSBFRM1 length');
  const pixels = new Uint16Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = buf.readUInt16LE(HEADER_LEN + i * 2);
  return { width, height, acquisitionIndex, pixels };
}

/** 供审阅页叠影渲染：转 0..255（保留 uint16 全范围线性映射） */
export function toU8(frame: GsbFrame): Uint8ClampedArray {
  let min = Infinity;
  let max = -Infinity;
  for (const p of frame.pixels) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const span = Math.max(1, max - min);
  const out = new Uint8ClampedArray(frame.pixels.length);
  for (let i = 0; i < frame.pixels.length; i++) {
    out[i] = Math.round(((frame.pixels[i] - min) / span) * 255);
  }
  return out;
}
