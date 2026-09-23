/**
 * 倾转几何与合成帧渲染（离线案例专用，确定可重放）。
 *
 * 图像平面坐标：左上原点，x 向右、y 向下，单位 pixel。
 * 倾转轴由方向单位向量 u 与轴上一点 anchor 定义；v = u 逆时针 90°。
 * 一个 3D 标记 (平行分量 a、面内垂直分量 q、厚度分量 h) 在倾角 θ 的投影：
 *
 *   p(θ) = anchor + a·u + (q·cosθ + h·sinθ)·v
 */

export interface Axis2D {
  directionDeg: number;
  anchor: { x: number; y: number };
}

export interface Marker3D {
  trackId: string;
  a: number; // 沿轴（px）
  q: number; // 轴法向的面内分量（px）
  h: number; // 厚度方向分量（px，确定性合成值）
}

export function axisVectors(directionDeg: number): { ux: number; uy: number; vx: number; vy: number } {
  const rad = (directionDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  // 图像坐标 y 向下，"逆时针 90°"在屏幕上对应 (-uy, ux)
  return { ux, uy, vx: -uy, vy: ux };
}

export function projectMarker(
  marker: Pick<Marker3D, "a" | "q" | "h">,
  axis: Axis2D,
  tiltDeg: number
): { x: number; y: number } {
  const { ux, uy, vx, vy } = axisVectors(axis.directionDeg);
  const t = (tiltDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const perp = marker.q * c + marker.h * s;
  return {
    x: axis.anchor.x + marker.a * ux + perp * vx,
    y: axis.anchor.y + marker.a * uy + perp * vy
  };
}

/** 可种子化的确定性高斯噪声（Box-Muller）。 */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return u;
  };
}

export function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export interface RenderSpec {
  width: number;
  height: number;
  dots: { x: number; y: number; r?: number; intensity?: number }[];
  driftX: number;
  driftY: number;
  blur: boolean;
  tiltDeg: number;
  seed: number;
}

/** 渲染 8-bit 灰度帧：背景梯度 + fiducial 高斯亮点 + 可选漂移/模糊。 */
export function renderFrame(spec: RenderSpec): Uint8Array {
  const { width, height } = spec;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grad = 18 + 10 * (x / width) + 8 * (y / height);
      gray[y * width + x] = Math.max(0, Math.min(255, grad + ((x + y) % 7)));
    }
  }
  for (const dot of spec.dots) {
    const cx = dot.x + spec.driftX;
    const cy = dot.y + spec.driftY;
    const radius = spec.blur ? (dot.r ?? 2) * 3.2 : dot.r ?? 2.2;
    const peak = dot.intensity ?? 205;
    const box = Math.ceil(radius * 2.4);
    for (let y = Math.max(0, Math.floor(cy - box)); y < Math.min(height, Math.ceil(cy + box)); y++) {
      for (let x = Math.max(0, Math.floor(cx - box)); x < Math.min(width, Math.ceil(cx + box)); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        const g = (peak - 24) * Math.exp(-d2 / (2 * radius * radius));
        const idx = y * width + x;
        gray[idx] = Math.max(0, Math.min(255, gray[idx] + g));
      }
    }
  }
  if (spec.blur) {
    // 简单均值模糊（运动模糊近似），两遍 3x3
    const src = Uint8Array.from(gray);
    for (let pass = 0; pass < 2; pass++) {
      const cur = pass === 0 ? src : Uint8Array.from(gray);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += cur[(y + dy) * width + (x + dx)];
          gray[y * width + x] = sum / 9;
        }
      }
    }
  }
  return gray;
}
