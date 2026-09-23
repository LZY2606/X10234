// Minimal 8-bit grayscale PNG codec, isomorphic across Node and browsers.
// Raw microscope frames in the offline case package are small synthetic
// grayscale images; we intentionally avoid an image-library dependency so the
// domain material is self-contained.

export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array; // row-major, one byte per pixel
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length, false);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  dv.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)), false);
  return out;
}

export async function encodePng(image: GrayImage): Promise<Uint8Array> {
  const { width, height, data } = image;
  if (data.length !== width * height) throw new Error('png/size-mismatch');
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter type 0 (None) per scanline
    raw.set(data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const cs = new CompressionStream('deflate');
  const compressed = await streamAll(cs, raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const total =
    signature.length + 12 + ihdr.length + 12 + compressed.length + 12;
  const result = new Uint8Array(total);
  let off = 0;
  result.set(signature, off);
  off += signature.length;
  result.set(chunk('IHDR', ihdr), off);
  off += 12 + ihdr.length;
  result.set(chunk('IDAT', compressed), off);
  off += 12 + compressed.length;
  result.set(chunk('IEND', new Uint8Array(0)), off);
  return result;
}

async function streamAll(cs: CompressionStream, bytes: Uint8Array): Promise<Uint8Array> {
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function decodePng(bytes: Uint8Array): Promise<GrayImage> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8; // skip signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (p < bytes.length) {
    const len = view.getUint32(p, false);
    const type = new TextDecoder().decode(bytes.subarray(p + 4, p + 8));
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = bv.getUint32(0, false);
      height = bv.getUint32(4, false);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 0) {
    throw new Error('png/unsupported-format: only 8-bit grayscale frames are supported');
  }
  const concatenated = concat(idat);
  const ds = new DecompressionStream('deflate');
  const raw = await drainDecompress(ds, concatenated);
  const stride = width + 1;
  const data = new Uint8Array(width * height);
  let prev = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const line = raw.subarray(y * stride + 1, (y + 1) * stride);
    const recon = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const a = x >= 1 ? recon[x - 1] : 0;
      const b = prev[x];
      const c = x >= 1 ? prev[x - 1] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error('png/unsupported-filter');
      recon[x] = v & 0xff;
    }
    data.set(recon, y * width);
    prev = recon;
  }
  return { width, height, data };
}

async function drainDecompress(ds: DecompressionStream, bytes: Uint8Array): Promise<Uint8Array> {
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], forcedTotal?: number): Uint8Array {
  const total = forcedTotal ?? chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
