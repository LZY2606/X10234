// 无依赖的 PGM (P5) 读写，用于不可变原始帧字节。
export function encodePGM(width: number, height: number, pixels: Uint8Array): Buffer {
  if (pixels.length !== width * height) throw new Error('pixel size mismatch');
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  return Buffer.concat([header, Buffer.from(pixels)]);
}

export function decodePGM(buf: Buffer): { width: number; height: number; pixels: Uint8Array } {
  const tokens: number[] = [];
  let pos = 0;
  const readToken = () => {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.subarray(start, pos).toString('ascii');
  };
  const magic = readToken();
  if (magic !== 'P5') throw new Error('not P5');
  const width = Number(readToken());
  const height = Number(readToken());
  const maxv = Number(readToken());
  pos++; // single whitespace after maxval
  return { width, height, pixels: new Uint8Array(buf.subarray(pos, pos + width * height)) };
}
