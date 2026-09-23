/**
 * 合成 tilt-series 物理模型（确定性、可重放）。
 *
 * 坐标：图像左上角原点，像素；宽 W 高 H。
 * fiducial 轨迹的投影遵循 sinogram 直线模型：
 *   对第 k 条轨迹，其在倾角 θ 帧上的位置 =
 *     x = x0_k * cos θ + perpX_k * sin θ + driftX(θ) + ε
 *     y = y0_k                 + driftY(θ) + ε
 * 其中 perpX 由“倾转轴相对图像中心的偏心”决定——这正是轴线不能默认
 * 固定在中心的物理来源。
 */

export interface Mulberry32 {
  next: () => number;
}

export function rng(seed: number): Mulberry32 {
  let a = seed >>> 0;
  return {
    next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export interface TiltSeriesGeometry {
  width: number;
  height: number;
  tiltAnglesDeg: number[];
  axisOrientationDeg: number;
  /** 轴线与图像中心的垂直偏心（像素），非零 => AXIS_OFF_CENTER */
  axisOffsetPx: number;
  trackCount: number;
  noiseSigma: number;
  driftPxPerFrame: number;
  seed: number;
}

export interface TrackTruth {
  trackId: string;
  /** 零倾角位置（像素） */
  x0: number;
  y0: number;
  /** 相对轴线的深度振幅（像素） */
  amp: number;
}

export function buildTracks(g: TiltSeriesGeometry): TrackTruth[] {
  const r = rng(g.seed + 101);
  const tracks: TrackTruth[] = [];
  for (let k = 0; k < g.trackCount; k++) {
    tracks.push({
      trackId: `trk_${String(k + 1).padStart(2, '0')}`,
      x0: g.width * (0.25 + 0.5 * r.next()),
      y0: g.height * (0.2 + 0.6 * r.next()),
      amp: g.width * (0.05 + 0.12 * r.next()) * (r.next() > 0.5 ? 1 : -1),
    });
  }
  return tracks;
}

const DEG = Math.PI / 180;

/** 无漂移的真值投影（像素），已把轴线方向与偏心旋转到图像坐标 */
export function projectTrack(
  t: TrackTruth,
  tiltDeg: number,
  g: TiltSeriesGeometry,
): { x: number; y: number } {
  const phi = g.axisOrientationDeg * DEG;
  const th = tiltDeg * DEG;
  // 轴线局部坐标：沿轴 u、垂直轴 v；图像中心到轴线有 axisOffset 的平移
  const dx0 = t.x0 - g.width / 2;
  const dy0 = t.y0 - g.height / 2 - g.axisOffsetPx;
  const u = dx0 * Math.cos(phi) + dy0 * Math.sin(phi);
  const v = -dx0 * Math.sin(phi) + dy0 * Math.cos(phi);
  const uT = u; // 沿轴不变
  const vT = v * Math.cos(th) + t.amp * Math.sin(th);
  const x = g.width / 2 + uT * Math.cos(phi) - vT * Math.sin(phi);
  const y = g.height / 2 + g.axisOffsetPx + uT * Math.sin(phi) + vT * Math.cos(phi);
  return { x, y };
}

/** 缓慢的束致漂移（刚体平移），随帧累计 */
export function drift(frameIndex: number, g: TiltSeriesGeometry): { dx: number; dy: number } {
  const t = frameIndex / Math.max(1, g.tiltAnglesDeg.length - 1);
  return {
    dx: g.driftPxPerFrame * frameIndex + 0.6 * Math.sin(t * Math.PI * 2),
    dy: g.driftPxPerFrame * 0.5 * frameIndex,
  };
}

/** 生成 8-bit PGM (P5) 帧：暗背景 + fiducial 亮斑 + 噪声 */
export function renderPgm(
  g: TiltSeriesGeometry,
  frameIndex: number,
  spots: { x: number; y: number }[],
  badFrame = false,
): Buffer {
  const r = rng(g.seed * 7919 + frameIndex);
  const { width: W, height: H } = g;
  const buf = Buffer.alloc(W * H);
  for (let i = 0; i < buf.length; i++) {
    let v = 12 + g.noiseSigma * (r.next() + r.next() + r.next() - 1.5);
    buf[i] = Math.max(0, Math.min(255, v));
  }
  if (badFrame) {
    // 坏帧：整幅漂移脉冲 + 条纹，使 fiducial 位置与真值严重不符
    for (let y = 0; y < H; y++) {
      if (y % 7 === 0) for (let x = 0; x < W; x++) buf[y * W + x] = Math.min(255, buf[y * W + x] + 60);
    }
  }
  const d = badFrame ? { dx: 9, dy: 7 } : drift(frameIndex, g);
  for (const s of spots) {
    const cx = s.x + d.dx;
    const cy = s.y + d.dy;
    stampGaussian(buf, W, H, cx, cy, badFrame ? 2.4 : 1.6, badFrame ? 90 : 150);
  }
  const header = Buffer.from(`P5\n${W} ${H}\n255\n`, 'ascii');
  return Buffer.concat([header, buf]);
}

function stampGaussian(buf: Buffer, W: number, H: number, cx: number, cy: number, sigma: number, amp: number) {
  const r = Math.ceil(sigma * 2.2);
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const add = amp * Math.exp(-d2 / (2 * sigma * sigma));
      buf[y * W + x] = Math.min(255, buf[y * W + x] + add);
    }
  }
}

/** 解析 PGM P5（供审阅页叠影与导入核对） */
export function parsePgm(buf: Buffer): { width: number; height: number; pixels: Buffer } {
  if (buf[0] !== 0x50 || buf[1] !== 0x35) throw new Error('not a P5 PGM');
  let pos = 2;
  const readToken = () => {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.slice(start, pos).toString('ascii');
  };
  const width = Number(readToken());
  const height = Number(readToken());
  const maxv = Number(readToken());
  pos++; // single whitespace after maxval
  if (maxv !== 255) throw new Error('only 8-bit PGM supported');
  return { width, height, pixels: buf.slice(pos, pos + width * height) };
}
