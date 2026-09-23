/**
 * 合成倾转序列：不拿通用表格替代领域材料。
 * 每个原始帧是真正的灰度字节（uint8 raw），包含 5 个 fiducial 球的投影像，
 * 运动符合“绕一条偏离图像中心的倾转轴”的几何模型，并人为注入跟踪缺口与坏帧。
 */

export interface SynthConfig {
  width: number;
  height: number;
  /** 倾转轴锚点（像素）。刻意偏离图像中心，用于“轴线偏心”反例。 */
  axisAnchor: { x: number; y: number };
  axisDirectionDeg: number;
  anglesDeg: number[];
  /** 每个 fiducial 球：零倾角坐标（像素）与深度 z（像素） */
  beads: { x0: number; y0: number; z0: number; label: string }[];
  blurFrames: number[];
  missingHighTilt?: boolean;
}

export interface GeneratedFrame {
  index: number;
  angleDeg: number;
  pixels: Uint8Array;
  beadPixels: { label: string; x: number; y: number }[];
}

export function beadProjected(cfg: SynthConfig, bead: { x0: number; y0: number; z0: number }, angleDeg: number) {
  const t = (cfg.axisDirectionDeg * Math.PI) / 180;
  const dx = cfg.axisAnchor.x;
  const dy = cfg.axisAnchor.y;
  // 转到轴坐标系
  const lx = (bead.x0 - dx) * Math.cos(t) + (bead.y0 - dy) * Math.sin(t);
  const ly = -(bead.x0 - dx) * Math.sin(t) + (bead.y0 - dy) * Math.cos(t);
  const theta = (angleDeg * Math.PI) / 180;
  // 绕轴倾转：平行坐标 lx 不变，法向由深度 z 与 ly 混合
  const lx2 = lx * Math.cos(theta) + bead.z0 * Math.sin(theta);
  const ly2 = ly;
  // 转回图像坐标
  const x = dx + lx2 * Math.cos(t) - ly2 * Math.sin(t);
  const y = dy + lx2 * Math.sin(t) + ly2 * Math.cos(t);
  return { x, y };
}

export function generateFrames(cfg: SynthConfig): GeneratedFrame[] {
  const out: GeneratedFrame[] = [];
  let outIndex = 0;
  cfg.anglesDeg.forEach((angleDeg, idx) => {
    if (cfg.missingHighTilt && Math.abs(angleDeg) >= 60) return;
    const pixels = new Uint8Array(cfg.width * cfg.height).fill(18);
    // 背景剂量相关的轻微噪声（确定性，无外部随机源）
    for (let y = 0; y < cfg.height; y++) {
      for (let x = 0; x < cfg.width; x++) {
        pixels[y * cfg.width + x] = 18 + Math.floor(6 * Math.sin(x * 0.11 + y * 0.07 + idx) + 6);
      }
    }
    const beadPixels: GeneratedFrame["beadPixels"] = [];
    for (const bead of cfg.beads) {
      const p = beadProjected(cfg, bead, angleDeg);
      drawBlob(pixels, cfg.width, cfg.height, p.x, p.y, 3, 210);
      beadPixels.push({ label: bead.label, x: p.x, y: p.y });
    }
    if (cfg.blurFrames.includes(idx)) {
      // 运动模糊：水平方向均值化，产生真实的坏帧字节
      const copy = new Uint8Array(pixels);
      for (let y = 0; y < cfg.height; y++) {
        for (let x = 8; x < cfg.width - 8; x++) {
          let sum = 0;
          for (let k = -8; k <= 8; k++) sum += copy[y * cfg.width + x + k];
          pixels[y * cfg.width + x] = Math.round(sum / 17);
        }
      }
    }
    out.push({ index: outIndex++, angleDeg, pixels, beadPixels });
  });
  return out;
}

function drawBlob(buf: Uint8Array, w: number, h: number, cx: number, cy: number, radius: number, peak: number) {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const v = peak * Math.exp(-(d * d) / (radius * radius * 0.6));
      const idx = y * w + x;
      buf[idx] = Math.min(255, Math.round(Math.max(buf[idx], v)));
    }
  }
}

export const DEFAULT_TILT_ANGLES = [
  -60, -55, -50, -45, -40, -35, -30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60,
];
