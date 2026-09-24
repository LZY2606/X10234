#!/usr/bin/env node
/**
 * 离线案例包构建器：倾转帧拼合室（tilt-assembly-room）
 *
 * 产物全部提交进仓库（cases/tilt-assembly-room/），测试与页面离线加载，
 * 不依赖任何通用表格。
 *
 * 帧几何（确定性，无外部随机源）：
 *  - 11 帧倾角 -60..+60，步长 15°，128x128 px，8-bit PGM
 *  - 真实倾转轴偏心：pivot=(78, 60)，轴角 +6°（不经过图像中心 64,64）
 *  - 6 颗 fiducial，高度 z 各异；倾转下横向位移 = z*sin(theta)，
 *    帧间漂移随剂量累积
 *  - f045 为坏帧（束流跳变导致整体漂移 + 噪声）
 *  - 跟踪器标签：tracker-2 / tracker-3 在 f-15 之后发生身份交换
 *  - tracker-5 在 f-30..f000 存在跟踪缺口
 *
 * 最小输入与组合输入共享同一批帧字节（按 sha256 内容寻址，只存一份）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'cases', 'tilt-assembly-room');
const frameDir = join(outDir, 'frames');
mkdirSync(frameDir, { recursive: true });

const W = 128, H = 128;
const ANGLES = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
const AXIS = { pivotX: 78, pivotY: 60, angleDeg: 6 }; // 真实偏心轴
const MARKERS = [
  { id: 'm1', x0: 40, y0: 30, z: -18 },
  { id: 'm2', x0: 70, y0: 44, z: 10 },
  { id: 'm3', x0: 52, y0: 80, z: 26 },
  { id: 'm4', x0: 92, y0: 72, z: -8 },
  { id: 'm5', x0: 30, y0: 96, z: 14 },
  { id: 'm6', x0: 84, y0: 100, z: -30 },
];
const BAD_FRAME = 'f045';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writePGM(path, pixels) {
  const header = Buffer.from(`P5\n${W} ${H}\n255\n`, 'ascii');
  const body = Buffer.from(pixels);
  writeFileSync(path, Buffer.concat([header, body]));
}

/** 依据真实模型生成某帧某 marker 的投影像素坐标（含帧漂移）。 */
function project(marker, angleDeg, frameIndex) {
  const th = (angleDeg * Math.PI) / 180;
  const axis = (AXIS.angleDeg * Math.PI) / 180;
  // marker 相对真实 pivot
  const dx = marker.x0 - AXIS.pivotX;
  const dy = marker.y0 - AXIS.pivotY;
  // 绕轴旋转：垂直轴方向坐标受 cos/sin 影响（简化为 2D 倾转投影）
  const axX = Math.sin(axis), axY = -Math.cos(axis);
  const perpX = -axY, perpY = axX;
  const along = dx * axX + dy * axY;
  const perp = dx * perpX + dy * perpY;
  // 倾转：垂直方向收缩 cosθ；高度 z 产生 sinθ 视差
  const perpT = perp * Math.cos(th) + marker.z * Math.sin(th);
  let x = AXIS.pivotX + along * axX + perpT * perpX;
  let y = AXIS.pivotY + along * axY + perpT * perpY;
  // 累积剂量漂移（缓慢平移），坏帧大幅跳变
  const driftScale = frameIndex === 4 ? 0 : frameIndex * 0.35;
  x += driftScale;
  y += frameIndex * 0.12;
  if (`f${String(angleDeg).replace('-', 'm').padStart(3, '0')}` === BAD_FRAME || (angleDeg === 45)) {
    x += 9.5; y += 6.0; // 坏帧束流跳变
  }
  return { x, y };
}

function frameId(angle) {
  return `f${String(angle).replace('-', 'm').padStart(3, '0')}`;
}

const frames = [];
const truthObservations = {};

ANGLES.forEach((angle, idx) => {
  const id = frameId(angle);
  const rnd = mulberry32(1000 + idx * 77);
  const pixels = new Uint8Array(W * H);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 12 + Math.floor(rnd() * 10);
  truthObservations[id] = [];
  for (const marker of MARKERS) {
    const p = project(marker, angle, idx);
    truthObservations[id].push({ marker: marker.id, x: p.x, y: p.y });
    // 2.2px 高斯亮斑
    for (let oy = -3; oy <= 3; oy++) {
      for (let ox = -3; ox <= 3; ox++) {
        const xx = Math.round(p.x) + ox, yy = Math.round(p.y) + oy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const g = Math.exp(-(ox * ox + oy * oy) / 2.4) * 235;
        pixels[yy * W + xx] = Math.min(255, pixels[yy * W + xx] + g);
      }
    }
  }
  // 纹理格线，帮助叠影肉眼判读
  for (let x = 8; x < W; x += 16) for (let y = 0; y < H; y++) pixels[y * W + x] = 40;
  const path = join(frameDir, `${id}.pgm`);
  writePGM(path, pixels);
  const bytes = readFileSync(path);
  frames.push({
    frameId: id, index: idx, angle, file: `frames/${id}.pgm`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
  });
});

// ---- 跟踪器输出：标签交换与缺口在“观测层”真实存在，留给解释层裁定 ----
function trackerLabel(markerId, angle) {
  // m2/m3 在 -15° 之后被跟踪器互换标签
  const swapped = angle >= -15;
  if (markerId === 'm2') return swapped ? 'tracker-3' : 'tracker-2';
  if (markerId === 'm3') return swapped ? 'tracker-2' : 'tracker-3';
  return { m1: 'tracker-1', m4: 'tracker-4', m5: 'tracker-5', m6: 'tracker-6' }[markerId];
}

const observations = [];
for (const f of frames) {
  for (const t of truthObservations[f.frameId]) {
    const label = trackerLabel(t.marker, f.angle);
    // tracker-5 缺口：-30,-15,0 三帧未观测到
    if (label === 'tracker-5' && [-30, -15, 0].includes(f.angle)) continue;
    observations.push({
      observationId: `obs-${f.frameId}-${label}`,
      frameId: f.frameId,
      observedTrackId: label,
      physicalTruth: t.marker,
      x: Number(t.x.toFixed(3)),
      y: Number(t.y.toFixed(3)),
      basis: 'image_px_top_left',
      uncertaintyPx: 0.4,
    });
  }
}

const caseJson = {
  schema: 'tilt-assembly-room/case/v1',
  title: '倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支',
  coordinateBasis: 'image_px_top_left',
  frameGeometry: { widthPx: W, heightPx: H },
  assumedImageCenter: { x: W / 2, y: H / 2 },
  groundTruthNote: '仅供测试断言；应用层不读取此字段做计算',
  groundTruth: { axis: AXIS, markerSwap: ['m2', 'm3'], swapAfterAngleDeg: -15, badFrame: BAD_FRAME },
  frames,
  tiltAngles: frames.map(f => ({
    angleId: `angle-${f.frameId}`, frameId: f.frameId,
    raw: { text: `${f.angle} deg` }, value: f.angle, unit: 'degree',
    signConvention: 'ccw_positive_in_xy',
  })),
  pixelScales: [{
    scaleId: 'scale-series', frameId: null,
    raw: { text: '0.55 nm/px (microscope MAG x43k)' },
    value: 0.55, unit: 'nm_per_px',
  }],
  doses: frames.map((f, i) => ({
    doseId: `dose-${f.frameId}`, frameId: f.frameId,
    raw: { dm4: { image_list: 0, exposure_dose: Number((1.8 + i * 0.02).toFixed(3)) } },
    electronsPerAngstrom2: { value: Number((1.8 + i * 0.02).toFixed(3)), unit: 'e-/A^2' },
    cumulative: { value: Number((1.8 * (i + 1) + 0.02 * (i * (i + 1)) / 2).toFixed(3)), unit: 'e-/A^2' },
  })),
  observations,
  trackGaps: [{
    gapId: 'gap-tracker5-low-tilt', observedTrackId: 'tracker-5',
    missingFrameIds: ['fm30', 'fm15', 'f000'],
    reason: 'low contrast at low dose; tracker confidence < threshold',
    raw: { log: 'tracker v3.2: lost at fm30, reacquired f015' },
  }],
  manualExclusionReasons: [{
    reasonId: 'exclude-f045', frameId: 'f045',
    reason: 'beam jump during exposure; whole-frame drift 11px — excluded pending decision',
    author: 'em-team@grid',
    raw: { microscopistNote: 'f045 looks smeared in live view' },
  }],
  scenarios: {
    axis_eccentricity: {
      minimal: { frameIds: ['fm30', 'f000', 'f030'], description: '仅 3 帧即可证明轴不经过图像中心' },
      combined: { frameIds: frames.map(f => f.frameId) },
    },
    track_identity_swap: {
      minimal: { observationIds: ['obs-fm30-tracker-2', 'obs-fm15-tracker-2', 'obs-f015-tracker-2', 'obs-f030-tracker-2'] },
      combined: { usesAllObservations: true },
    },
    missing_high_tilt_frames: {
      missingFrameIds: ['fm60', 'f060'],
      minimal: { removeFrameIds: ['fm60'] },
      combined: { removeFrameIds: ['fm60', 'f060'] },
    },
    bad_frame_exclusion: { badFrameId: 'f045', minimal: { frameIds: ['f030', 'f045', 'f060'] } },
    local_warp_overfit: { minimal: { frameIds: ['f015', 'f030'], trackerSubset: ['tracker-1', 'tracker-2', 'tracker-4'] } },
    multiple_solutions: { minimal: { collinearTracks: ['tracker-1', 'tracker-2'] } },
    concurrent_freeze: { note: '由两个浏览器窗口在重放阶段制造，非静态材料' },
  },
  narrative: {
    baseline: '初始导入：帧/倾角/尺度/剂量/标记点/缺口/手工排除原因全部版本化',
    revision2: '参数修订：把“假设轴在图像中心”改为必须估计，并收紧坏帧残差阈值',
    revision3: '只影响局部依赖的源数据改动：修正 f015 上 tracker-1 的一个亚像素坐标',
    conflictingDecision: '窗口 A 接受刚体方案并锁定；窗口 B 基于过期世界版本提交局部形变 -> 版本冲突',
  },
};

writeFileSync(join(outDir, 'case.json'), JSON.stringify(caseJson, null, 2));
console.log(`case package written: ${frames.length} frames, ${observations.length} observations -> ${outDir}`);
