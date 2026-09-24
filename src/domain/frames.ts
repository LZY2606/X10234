/**
 * 不可变原始帧内容。合成帧生成器负责可复现地生成像素字节，
 * 其内容 id 由内容寻址决定；同一份原始片段在多场景共享时只存一份。
 */
import { hashBytes } from "./hash";

export interface FrameBitmap {
  width: number;
  height: number;
  /** 单通道 8 位灰度。 */
  pixels: Uint8Array;
}

export function bitmapBlobId(width: number, height: number, pixels: Uint8Array): string {
  const header = new TextEncoder().encode(`RAW8:${width}x${height}:`);
  const buf = new Uint8Array(header.length + pixels.length);
  buf.set(header, 0);
  buf.set(pixels, header.length);
  return hashBytes(buf);
}

export interface MarkerSpec {
  id: number;
  /** 垂直于轴线方向的基准坐标（px），决定随倾角的视差。 */
  u: number;
  /** 沿轴线方向坐标（px）。 */
  v: number;
  radius: number;
}

export interface FrameGenParams {
  width: number;
  height: number;
  tiltRad: number;
  /** 轴线穿过点（允许偏心）。 */
  axisOffsetX: number;
  axisOffsetY: number;
  /** 轴线方向角（图像坐标，弧度）。 */
  axisAngleRad: number;
  markers: MarkerSpec[];
  seed: number;
  noiseAmp: number;
}

/** 可复现的伪随机（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标记点在给定倾角下的投影像素坐标（相对图像）。 */
export function projectMarker(
  spec: MarkerSpec,
  p: Pick<FrameGenParams, "tiltRad" | "axisOffsetX" | "axisOffsetY" | "axisAngleRad">
): { x: number; y: number } {
  // 垂直于轴线的视差随 cos(tilt) 收缩。
  const perp = spec.u * Math.cos(p.tiltRad);
  const along = spec.v;
  const ca = Math.cos(p.axisAngleRad);
  const sa = Math.sin(p.axisAngleRad);
  // along 沿轴线方向 (ca,sa)，perp 沿垂直方向 (-sa,ca)。
  const x = p.axisOffsetX + along * ca - perp * sa;
  const y = p.axisOffsetY + along * sa + perp * ca;
  return { x, y };
}

export function generateFrame(p: FrameGenParams): FrameBitmap {
  const pixels = new Uint8Array(p.width * p.height);
  const rand = rng(p.seed);
  // 背景渐变 + 噪声（原始保真，不做清洗）。
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const grad = 18 + ((x + y) % 13);
      const noise = (rand() - 0.5) * p.noiseAmp;
      pixels[y * p.width + x] = clamp(grad + noise);
    }
  }
  for (const marker of p.markers) {
    const { x, y } = projectMarker(marker, p);
    stamp(pixels, p.width, p.height, x, y, marker.radius, 210);
  }
  return { width: p.width, height: p.height, pixels };
}

function stamp(
  pixels: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  value: number
): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 <= r2) {
        const falloff = 1 - Math.sqrt(d2) / (radius + 1);
        pixels[y * w + x] = clamp(pixels[y * w + x] + value * falloff);
      }
    }
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
