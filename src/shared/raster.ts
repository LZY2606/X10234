// 原始帧不可变像素：自定义 RAW8 容器（ASCII 头 + base64 灰度），
// 浏览器与 Node 都可解析；内容寻址决定像素字节只存一份。
import { Buffer } from 'node:buffer';

export interface Raw8Image {
  width: number;
  height: number;
  bytes: Uint8Array;
}

export function encodeRaw8(img: Raw8Image): Uint8Array {
  const header = `RAW8 ${img.width} ${img.height}\n`;
  const body = Buffer.from(img.bytes).toString('base64');
  return new TextEncoder().encode(header + body);
}

export function decodeRaw8(data: Uint8Array): Raw8Image {
  const text = new TextDecoder().decode(data);
  const newline = text.indexOf('\n');
  const header = text.slice(0, newline).split(' ');
  if (header[0] !== 'RAW8') throw new Error('不是 RAW8 帧容器');
  return {
    width: Number(header[1]),
    height: Number(header[2]),
    bytes: Buffer.from(text.slice(newline + 1).trim(), 'base64'),
  };
}

export function newCanvas(width: number, height: number, fill = 8): Uint8Array {
  return new Uint8Array(width * height).fill(fill);
}

function gaussianDot(bytes: Uint8Array, w: number, h: number, cx: number, cy: number, radius: number, peak = 235) {
  const r2 = radius * radius;
  for (let y = Math.max(0, Math.floor(cy - radius - 1)); y < Math.min(h, Math.ceil(cy + radius + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 1)); x < Math.min(w, Math.ceil(cx + radius + 1)); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 <= r2) {
        const v = Math.round(peak * Math.exp(-d2 / (2 * (radius / 2.2) ** 2)));
        bytes[y * w + x] = Math.max(bytes[y * w + x], v);
      }
    }
  }
}

export function paintFiducials(img: Raw8Image, points: { x: number; y: number }[], radius = 2.4, blur = false): Uint8Array {
  const out = new Uint8Array(img.bytes);
  for (const p of points) gaussianDot(out, img.width, img.height, p.x, p.y, radius);
  if (blur) {
    const w = img.width;
    const blurred = new Uint8Array(out.length);
    for (let y = 1; y < img.height - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        blurred[i] = Math.round((out[i - 1] + out[i + 1] + out[i - w] + out[i + w] + out[i] * 2) / 6);
      }
    }
    return blurred;
  }
  return out;
}

/** 将已配准帧叠影到参考画布（简单平均合成）。 */
export function overlayInto(
  canvas: ImageData,
  frame: Raw8Image,
  mapPoint: (p: { x: number; y: number }) => { x: number; y: number } | null,
  weight: number,
) {
  const { width: w, height: h, data } = canvas;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const mapped = mapPoint({ x: x + 0.5, y: y + 0.5 });
      if (!mapped) continue;
      const mx = Math.floor(mapped.x), my = Math.floor(mapped.y);
      if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
      const v = frame.bytes[y * frame.width + x];
      const i = (my * w + mx) * 4;
      data[i] = Math.round(data[i] + (v - data[i]) * weight);
      data[i + 1] = Math.round(data[i + 1] + (v - data[i + 1]) * weight);
      data[i + 2] = Math.round(data[i + 2] + (v - data[i + 2]) * weight);
      data[i + 3] = 255;
    }
  }
}
