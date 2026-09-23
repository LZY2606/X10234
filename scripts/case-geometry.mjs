// 倾转帧拼合室离线案例包：合成几何（确定性，无外部依赖）。
// 生成原始 PGM 帧与 domain 材料 JSON：倾角/像素尺度/剂量/fiducial/缺口/手工排除。
import { createHash } from 'node:crypto';

export const WIDTH = 256;
export const HEIGHT = 256;

// 基线：-60..+60，步长 6 => 21 帧
export const TILTS = [-60, -54, -48, -42, -36, -30, -24, -18, -12, -6, 0, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60];

export const AXIS_ANGLE_DEG = 12;
// 故意偏心 14px：检验“轴不能默认固定在图像中心”
export const AXIS_OFFSET_PX = 14;

// 8 个 fiducial 的三维近似投影参数（u0 沿轴, v0 垂直轴, z 高度）
export const FIDUCIALS = [
  { id: 'F1', u0: -78, v0: -60, z: -22 },
  { id: 'F2', u0: -34, v0: -88, z: 34 },
  { id: 'F3', u0: 26, v0: -70, z: -40 },
  { id: 'F4', u0: 80, v0: -40, z: 18 },
  { id: 'F5', u0: -88, v0: 36, z: 44 },
  { id: 'F6', u0: -22, v0: 72, z: -16 },
  { id: 'F7', u0: 44, v0: 60, z: 30 },
  { id: 'F8', u0: 86, v0: 30, z: -30 }
];

export const BAD_FRAMES = new Set([-42]); // 漂移/污染坏帧
export const MISSING_HIGH_TILTS = new Set([54, 60]); // 缺失高倾角帧
export const GAP = { track: 'F3', from: 12, to: 15 }; // F3 在 +36..+48 跟踪断裂
export const SWAP = { a: 'F6', b: 'F7', from: 9, to: 13 }; // 高倾角区标签身份交换

function center() {
  return { x: WIDTH / 2, y: HEIGHT / 2 };
}

export function projectPoint(fiducial, tiltDeg, variant = {}) {
  const theta = (tiltDeg * Math.PI) / 180;
  const axisRad = (AXIS_ANGLE_DEG * Math.PI) / 180;
  const ux = Math.cos(axisRad);
  const uy = Math.sin(axisRad);
  const vx = -Math.sin(axisRad);
  const vy = Math.cos(axisRad);
  const c = center();
  // 沿轴坐标随 cos(theta) 压缩，垂直轴不变；轴偏心 g 加在垂直方向
  const g = variant.axisOffsetPx ?? AXIS_OFFSET_PX;
  const u = fiducial.u0 * Math.cos(theta);
  const v = fiducial.v0 + g;
  return {
    x: c.x + u * ux + v * vx,
    y: c.y + u * uy + v * vy
  };
}

export function renderFrame(tiltDeg, sequenceIndex, opts = {}) {
  const { swap = null, bad = false } = opts;
  const data = new Uint8Array(WIDTH * HEIGHT);
  // 背景渐变（剂量相关亮度），保持确定性
  const base = 26 + sequenceIndex;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      data[y * WIDTH + x] = (base + (x + y) * 0.02) & 0xff;
    }
  }
  const stamp = (cx, cy, sigma, amplitude) => {
    const radius = Math.ceil(sigma * 3);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.round(cx) + dx;
        const y = Math.round(cy) + dy;
        if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
        const falloff = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        const index = y * WIDTH + x;
        data[index] = Math.min(255, data[index] + amplitude * falloff);
      }
    }
  };
  for (const fiducial of FIDUCIALS) {
    // 身份交换：在交换区间，F6/F7 显示对方标签对应的物理点（模拟跟错点）
    let physical = fiducial;
    if (
      swap &&
      sequenceIndex >= swap.from &&
      sequenceIndex <= swap.to &&
      (fiducial.id === swap.a || fiducial.id === swap.b)
    ) {
      physical = FIDUCIALS.find(
        (other) =>
          other.id === (fiducial.id === swap.a ? swap.b : swap.a)
      );
    }
    // 缺口：F3 在断裂区间不打点（无法跟踪）
    if (
      sequenceIndex >= GAP.from &&
      sequenceIndex <= GAP.to &&
      fiducial.id === GAP.track
    ) {
      continue;
    }
    const point = projectPoint(physical, tiltDeg);
    // 坏帧：整体漂移 + 噪声条带，模拟载网跳动
    if (bad) {
      point.x += 11;
      point.y += 7;
    }
    stamp(point.x, point.y, 2.4, 210);
  }
  if (bad) {
    for (let y = 0; y < HEIGHT; y += 7) {
      for (let x = 0; x < WIDTH; x++) data[y * WIDTH + x] = 200;
    }
  }
  return encodePgm(data);
}

function encodePgm(data) {
  const header = Buffer.from(`P5\n${WIDTH} ${HEIGHT}\n255\n`, 'ascii');
  return Buffer.concat([header, Buffer.from(data)]);
}

export function hashBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
