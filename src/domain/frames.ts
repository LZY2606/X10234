import { createHash } from 'node:crypto';

/** 轻量灰度像素：P5 二进制 PGM，无第三方编解码依赖。 */

export interface GrayImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export function encodePGM(img: GrayImage): Uint8Array {
  const header = Buffer.from(`P5\n${img.width} ${img.height}\n255\n`, 'ascii');
  const out = new Uint8Array(header.length + img.pixels.length);
  out.set(header, 0);
  out.set(img.pixels, header.length);
  return out;
}

export function decodePGM(bytes: Uint8Array): GrayImage {
  let pos = 0;
  const readToken = (): string => {
    while (pos < bytes.length) {
      const c = bytes[pos];
      if (c === 35) {
        while (pos < bytes.length && bytes[pos] !== 10) pos++;
        continue;
      }
      if (c > 32) break;
      pos++;
    }
    const start = pos;
    while (pos < bytes.length && bytes[pos] > 32) pos++;
    return Buffer.from(bytes.slice(start, pos)).toString('ascii');
  };
  const magic = readToken();
  if (magic !== 'P5') throw new Error('not a P5 PGM');
  const width = Number(readToken());
  const height = Number(readToken());
  const max = Number(readToken());
  pos++; // single whitespace after maxval
  if (max !== 255) throw new Error('only 8-bit PGM supported');
  const pixels = bytes.slice(pos, pos + width * height);
  if (pixels.length !== width * height) throw new Error('truncated PGM');
  return { width, height, pixels: new Uint8Array(pixels) };
}

export function blankImage(width: number, height: number, fill = 16): GrayImage {
  return { width, height, pixels: new Uint8Array(width * height).fill(fill) };
}

export function addGaussianBead(
  img: GrayImage,
  cx: number,
  cy: number,
  radius: number,
  amplitude: number,
): void {
  const r = Math.ceil(radius * 3);
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(img.height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(img.width - 1, Math.ceil(cx + r)); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const v = amplitude * Math.exp(-d2 / (2 * radius * radius));
      const idx = y * img.width + x;
      img.pixels[idx] = Math.min(255, img.pixels[idx] + v);
    }
  }
}

export function addNoise(img: GrayImage, sigma: number, seed: number): void {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < img.pixels.length; i++) {
    const n = (rand() + rand() + rand() - 1.5) * 2 * sigma;
    img.pixels[i] = Math.max(0, Math.min(255, img.pixels[i] + n));
  }
}

export function pixelSHA256(img: GrayImage): string {
  return createHash('sha256').update(encodePGM(img)).digest('hex');
}
