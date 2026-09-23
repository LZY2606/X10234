// 合成原始帧字节（Float32 灰度）。确定性、可复现；真实场景下这里是相机原始文件字节。
import { createHash } from 'node:crypto';
import type { ContentBlobRef } from '../shared/domain';

export interface FrameRenderSpec {
  width: number;
  height: number;
  seed: number;
  /** 金粒位置（像素） */
  beads: { x: number; y: number; r?: number; intensity?: number }[];
  /** 0..1 的整体亮度，用于模拟坏帧/过曝 */
  brightness?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderFrameF32(spec: FrameRenderSpec): Uint8Array {
  const { width: w, height: h } = spec;
  const buf = new Float32Array(w * h);
  const rng = mulberry32(spec.seed);
  const brightness = spec.brightness ?? 0.12;
  for (let i = 0; i < buf.length; i++) buf[i] = brightness + rng() * 0.03;
  for (const bead of spec.beads) {
    const r = bead.r ?? 2.2;
    const intensity = bead.intensity ?? 0.8;
    const x0 = Math.max(0, Math.floor(bead.x - r - 1));
    const x1 = Math.min(w - 1, Math.ceil(bead.x + r + 1));
    const y0 = Math.max(0, Math.floor(bead.y - r - 1));
    const y1 = Math.min(h - 1, Math.ceil(bead.y + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - bead.x, y - bead.y);
        if (d <= r + 1) buf[y * w + x] += intensity * Math.exp(-(d * d) / (r * r));
      }
    }
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function blobRefOf(bytes: Uint8Array, mediaType = 'frame-grayscale-f32'): ContentBlobRef {
  const h = createHash('sha256').update(bytes).digest('hex');
  return { blobId: `blob-${h.slice(0, 16)}`, mediaType, byteLength: bytes.length, sha256: h };
}
