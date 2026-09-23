/** 极简 PGM(P5) 灰度图编解码：帧图像的原始字节格式，导入时原样保留。 */
export function encodePgm(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const out = new Uint8Array(header.length + pixels.length);
  out.set(header, 0);
  out.set(pixels, header.length);
  return out;
}

export function decodePgm(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const text = new TextDecoder().decode(bytes.slice(0, 64));
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(text);
  if (!m) throw new Error('不是合法的 PGM(P5) 图像');
  const width = Number(m[1]);
  const height = Number(m[2]);
  const headerLen = m[0].length;
  const pixels = bytes.slice(headerLen, headerLen + width * height);
  if (pixels.length !== width * height) throw new Error('PGM 像素数据长度不足');
  return { width, height, pixels };
}
