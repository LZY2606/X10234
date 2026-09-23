/**
 * 倾转几何与配准引擎（确定性、可单测）。
 *
 * 几何约定（坐标基准显式）：
 *  - 图像坐标：原点左上角，x 向右，y 向下（px）。
 *  - 倾转轴由轴上一点 A=(ax, ay) 与方向 dir（相对 +x 的角度）给出，
 *    因此轴线可以偏心 —— 绝不默认它在图像中心。
 *  - 点 P 绕轴在面内旋转到角度 t（cos t, sin t 剪切模型），
 *    再叠加每帧刚体平移（dose 漂移）。
 */

export interface Axis {
  ax: number;
  ay: number;
  dirDeg: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 点绕显式轴线的投影位置。 */
export function projectAroundAxis(p: Point, axis: Axis, tiltDeg: number, shift: Point = { x: 0, y: 0 }): Point {
  const t = (tiltDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // 平移到轴坐标系
  const dx = p.x - axis.ax;
  const dy = p.y - axis.ay;
  // 轴方向单位向量
  const d = (axis.dirDeg * Math.PI) / 180;
  const ux = Math.cos(d);
  const uy = Math.sin(d);
  // 沿轴坐标 q 与垂直轴坐标 r
  const q = dx * ux + dy * uy;
  const r = -dx * uy + dy * ux;
  // 倾转：沿轴不变，垂直方向按 cos 压缩，并引入 sin*z 的侧向项（fiducial 在不同 z）
  // 这里把 sin*z 项吸收到 fiducial 的“离轴高度”，由调用方在 r' 中处理。
  const r2 = r * c;
  // 转回图像坐标
  const x2 = axis.ax + q * ux - r2 * uy + shift.x;
  const y2 = axis.ay + q * uy + r2 * ux + shift.y;
  return { x: x2, y: y2 };
}

/** 带离轴高度 z 的投影（sin 项让高倾角点产生侧向位移）。 */
export function projectFiducial(
  p: Point,
  z: number,
  axis: Axis,
  tiltDeg: number,
  shift: Point = { x: 0, y: 0 },
): Point {
  const t = (tiltDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = p.x - axis.ax;
  const dy = p.y - axis.ay;
  const d = (axis.dirDeg * Math.PI) / 180;
  const ux = Math.cos(d);
  const uy = Math.sin(d);
  const q = dx * ux + dy * uy;
  const r = -dx * uy + dy * ux;
  const r2 = r * c + z * s;
  const x2 = axis.ax + q * ux - r2 * uy + shift.x;
  const y2 = axis.ay + q * uy + r2 * ux + shift.y;
  return { x: x2, y: y2 };
}

/** 8 位灰度图（行优先）。 */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function makeImage(width: number, height: number): GrayImage {
  return { width, height, data: new Uint8Array(width * height) };
}

export function setPixel(img: GrayImage, x: number, y: number, v: number): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return;
  img.data[yi * img.width + xi] = Math.max(img.data[yi * img.width + xi], Math.min(255, Math.round(v)));
}

/** 在图上画一个确定性高斯亮斑（fiducial 金粒）。 */
export function paintBlob(img: GrayImage, cx: number, cy: number, radius = 2.2, peak = 235): void {
  const r = Math.ceil(radius) + 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      const g = peak * Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius));
      // 亚像素：用分数权重近似
      setPixel(img, x, y, g * (1 - Math.abs(x - cx) % 1) * (1 - Math.abs(y - cy) % 1 || 1));
    }
  }
}

/** 生成一帧合成图：背景纹理 + fiducial 投影点。 */
export function renderFrame(
  width: number,
  height: number,
  seed: number,
  markers: Array<{ x: number; y: number }>,
): GrayImage {
  const img = makeImage(width, height);
  // 确定性弱背景纹理（dose 梯度 + 噪声），用于帧叠影可见
  let state = seed >>> 0 || 1;
  const rand = () => {
    state = (state * 1664525 + 1013904273) >>> 0;
    return state / 4294967296;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grad = 8 + 10 * (x / width) + 6 * (y / height);
      const noise = (rand() - 0.5) * 6;
      img.data[y * width + x] = Math.max(0, Math.min(60, grad + noise));
    }
  }
  for (const m of markers) paintBlob(img, m.x, m.y);
  return img;
}

/** 最简 PNG 编码（8-bit grayscale，无外部依赖）。 */
export function encodePngGray(img: GrayImage): Uint8Array {
  // 使用 zlib（Node 与浏览器均通过构建别名/垫片处理）；这里返回原始带 filter 行数据由 png 模块压缩。
  // 为保持纯函数，返回带行前缀的缓冲。
  const stride = img.width + 1;
  const raw = new Uint8Array(stride * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * stride] = 0; // filter none
    raw.set(img.data.subarray(y * img.width, (y + 1) * img.width), y * stride + 1);
  }
  return raw;
}
