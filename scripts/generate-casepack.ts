// 生成离线案例包「倾转帧拼合室」：电镜 tilt-series 轴线、fiducial 轨迹与配准分支
// 输出确定性的 JSON 到 casepack/（仓库自带，不依赖网络）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const W = 48, H = 48, CX = 24, CY = 24;
const AXIS_OFFSET_BASE = 6.2;   // px —— 基线里轴线就偏离图像中心
const AXIS_ANGLE_DEG = -12.0;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

interface Bead { id: string; bx: number; by: number; bz: number }
const beadRand = lcg(20260919);
const beads: Bead[] = [];
for (let i = 0; i < 12; i++) {
  beads.push({
    id: `bead-${String(i + 1).padStart(2, '0')}`,
    bx: (beadRand() - 0.5) * 36,
    by: (beadRand() - 0.5) * 36,
    bz: (beadRand() - 0.5) * 12,
  });
}

const TILTS: number[] = [];
for (let a = -60; a <= 60; a += 3) TILTS.push(a);

function project(b: Bead, tiltDeg: number, axisOffset: number, axisAngleDeg = AXIS_ANGLE_DEG) {
  const t = (tiltDeg * Math.PI) / 180;
  const phi = (axisAngleDeg * Math.PI) / 180;
  const u = b.bx * Math.cos(t) + b.bz * Math.sin(t); // 沿倾转轴方向的投影坐标
  return {
    x: CX + axisOffset + Math.cos(phi) * u - Math.sin(phi) * b.by,
    y: CY + Math.sin(phi) * u + Math.cos(phi) * b.by,
  };
}

function renderFrame(tiltDeg: number, axisOffset: number, seed: number, badFrame: boolean): string {
  const rand = lcg(seed);
  const img = new Uint8Array(W * H);
  for (let i = 0; i < img.length; i++) img[i] = 28 + Math.floor(rand() * 14);
  if (badFrame) for (let i = 0; i < img.length; i++) img[i] = Math.min(255, img[i] + 90 + Math.floor(rand() * 60));
  for (const b of beads) {
    const p = project(b, tiltDeg, axisOffset);
    const px = Math.round(p.x), py = Math.round(p.y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = px + dx, yy = py + dy;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H) img[yy * W + xx] = dx === 0 && dy === 0 ? 235 : 190;
    }
  }
  return Buffer.from(img).toString('base64');
}

const out = (...p: string[]) => join(import.meta.dirname, '..', 'casepack', ...p);
mkdirSync(out('baseline', 'frames'), { recursive: true });
mkdirSync(out('scenarios'), { recursive: true });

// ---- 基线 tilt-series：原始帧 + 倾角 + 像素尺度 + 剂量 ----
const BAD_FRAMES = [12, 13, 27];
const frames = TILTS.map((tilt, i) => {
  const bad = BAD_FRAMES.includes(i);
  const imageB64 = renderFrame(tilt, AXIS_OFFSET_BASE, 1000 + i, bad);
  writeFileSync(out('baseline', 'frames', `frame-${String(i).padStart(2, '0')}.json`), JSON.stringify({
    frameIndex: i, width: W, height: H, encoding: 'gray8-base64', image: imageB64,
  }));
  return {
    frameIndex: i,
    tiltAngle: { raw: `${tilt.toFixed(1)} deg` },
    // frame 27 的剂量单位故意写成无法转换的形式，验证“留在原位置并附诊断”
    exposureDose: { raw: i === 27 ? '1.9e2 e-/sqA' : `${(3.1 - i * 0.01).toFixed(2)} e-/A2` },
    imageRef: `baseline/frames/frame-${String(i).padStart(2, '0')}.json`,
  };
});
writeFileSync(out('baseline', 'tilt-series.json'), JSON.stringify({
  kind: 'tilt-series', seriesId: 'TS-2026-0919-em',
  pixelSize: { raw: '0.42 nm/px' },
  frames,
}, null, 2));

// ---- 基线 fiducial 轨迹：含跟踪缺口与身份交换提示 ----
const tracklets = beads.map((b, bi) => {
  const pts = [];
  // bead-08 的轨迹在 frame 18..20 断裂（跟踪缺口）
  const gapFrames = b.id === 'bead-08' ? [18, 19, 20] : [];
  // bead-05 只到 frame 24；bead-10 从 frame 25 开始（同一颗珠子，身份交换）
  const start = b.id === 'bead-10' ? 25 : 0;
  const end = b.id === 'bead-05' ? 24 : TILTS.length - 1;
  const obsRand = lcg(77000 + bi);
  for (let i = start; i <= end; i++) {
    if (gapFrames.includes(i)) continue;
    const p = project(b, TILTS[i], AXIS_OFFSET_BASE);
    // 观测噪声：普通帧 σ≈0.4px，坏帧 σ≈2.5px（坏帧排除情形的素材）
    const sigma = BAD_FRAMES.includes(i) ? 2.5 : 0.4;
    const jx = (obsRand() + obsRand() + obsRand() - 1.5) * sigma;
    const jy = (obsRand() + obsRand() + obsRand() - 1.5) * sigma;
    pts.push({ frameIndex: i, x: { raw: `${(p.x + jx).toFixed(2)} px`, basis: 'image' }, y: { raw: `${(p.y + jy).toFixed(2)} px`, basis: 'image' } });
  }
  const t: any = { trackletId: `trk-${String(bi + 1).padStart(2, '0')}`, points: pts };
  if (gapFrames.length) t.gapAfter = { frames: gapFrames, reason: '高倾角下标记点被冰染遮挡' };
  return t;
});
writeFileSync(out('baseline', 'fiducials.json'), JSON.stringify({
  kind: 'fiducial-tracks', trackSetId: 'FT-2026-0919-em',
  tracklets,
  trackingGaps: [{ trackletId: 'trk-08', frames: [18, 19, 20], reason: '高倾角下标记点被冰染遮挡' }],
  identitySwapHints: [{ a: 'trk-05', b: 'trk-10', atFrame: 24 }],
}, null, 2));

// ---- 基线手工排除原因（版本化） ----
writeFileSync(out('baseline', 'exclusions.json'), JSON.stringify({
  kind: 'manual-exclusions',
  exclusions: [{ frameIndex: 13, reason: '冰污染导致该帧衍射遮挡', decidedBy: 'operator-chen' }],
}, null, 2));

// ---- 反例档案：七个情形，各自一个最小输入 + 一个组合输入 ----
const scenarios: Record<string, any> = {
  'axis-eccentric': {
    title: '轴线偏心', rule: '倾转轴不能被默认固定在图像中心',
    minimal: { axisOverride: { angleDeg: AXIS_ANGLE_DEG, offsetPx: 18.5 }, note: '轴线偏移 18.5 px，若拟合把轴固定在图像中心将产生系统性残差' },
    combined: { axisOverride: { angleDeg: AXIS_ANGLE_DEG, offsetPx: 18.5 }, plusScenario: 'bad-frame-exclusion' },
  },
  'track-identity-swap': {
    title: '轨迹身份交换', rule: 'fiducial 轨迹可断裂且可能身份交换',
    minimal: { swap: { a: 'trk-05', b: 'trk-10', atFrame: 24 }, note: 'trk-05 在 frame 24 结束、trk-10 从 25 接续同一颗珠子' },
    combined: { swap: { a: 'trk-05', b: 'trk-10', atFrame: 24 }, plusScenario: 'axis-eccentric' },
  },
  'missing-high-tilt': {
    title: '缺失高倾角帧', rule: '缺失高倾角帧只影响依赖这些帧的结论',
    minimal: { dropFrames: [38, 39, 40], note: '缺失 +54/+57/+60 度帧' },
    combined: { dropFrames: [38, 39, 40], plusScenario: 'track-identity-swap' },
  },
  'bad-frame-exclusion': {
    title: '坏帧排除', rule: '不用少帧换低残差：候选比较必须在相同有效点集上',
    minimal: { excludeFrames: [12, 13, 27], note: '排除三帧后残差下降，但有效点集变小，比较无效' },
    combined: { excludeFrames: [12, 13, 27], plusScenario: 'missing-high-tilt' },
  },
  'local-deform-overfit': {
    title: '局部形变过拟合', rule: '局部形变自由度相对点数过高且残差收益低于噪声时判为过拟合',
    minimal: { model: 'local-deformation', controlPointSpacingPx: 8, note: '48px 视场上 8px 控制点间距 → 过参数化' },
    combined: { model: 'local-deformation', controlPointSpacingPx: 8, plusScenario: 'bad-frame-exclusion' },
  },
  'multi-solution': {
    title: '多解', rule: '无法唯一决定时保留全部合法候选',
    minimal: { degenerate: true, note: '轴线角 ± 两个极小值残差都在容差内，两个候选都必须保留' },
    combined: { degenerate: true, plusScenario: 'axis-eccentric' },
  },
  'concurrent-freeze': {
    title: '并发冻结', rule: '两个窗口同时锁定同一分支时，后提交者必须看到版本冲突及双方差异',
    minimal: { actors: ['reviewer-a', 'reviewer-b'], note: '两人基于同一 head 各自提交锁定' },
    combined: { actors: ['reviewer-a', 'reviewer-b'], plusScenario: 'multi-solution' },
  },
};
for (const [name, s] of Object.entries(scenarios)) {
  writeFileSync(out('scenarios', `${name}.json`), JSON.stringify({ scenarioId: name, ...s }, null, 2));
}

// ---- 重放记录：初始导入 → 参数修订 → 局部源数据改动 → 冲突的人工决定 → 七情形 ----
writeFileSync(out('replay.json'), JSON.stringify({
  packId: 'tilt-joining-room/em-tilt-series-alignment',
  narrative: '电镜小组导入倾转序列、曝光剂量和 fiducial 点轨迹，比较刚体、局部形变与排除坏帧的配准方案',
  steps: [
    { op: 'import-baseline', sources: ['baseline/tilt-series.json', 'baseline/fiducials.json', 'baseline/exclusions.json'] },
    { op: 'interpret', branch: 'main', models: ['rigid', 'local-deformation', 'exclude-bad-frames'] },
    { op: 'revise-params', note: '参数修订：像素尺度 0.42 → 0.43 nm/px（重新标定）', pixelSize: '0.43 nm/px' },
    { op: 'amend-source', note: '局部源数据改动：补登 trk-08 缺口内 frame 19 的坐标，只影响依赖该轨迹的候选', trackletId: 'trk-08', frameIndex: 19 },
    { op: 'conflicting-decisions', note: '互相冲突的人工决定：reviewer-a 采纳刚体候选，reviewer-b 在分支上否定它' },
    { op: 'run-scenarios', scenarios: Object.keys(scenarios) },
  ],
}, null, 2));

// ---- manifest ----
writeFileSync(out('manifest.json'), JSON.stringify({
  packId: 'tilt-joining-room/em-tilt-series-alignment',
  title: '倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支',
  geometry: { width: W, height: H, center: [CX, CY], baselineAxis: { angleDeg: AXIS_ANGLE_DEG, offsetPx: AXIS_OFFSET_BASE } },
  tilts: TILTS,
  baseline: ['baseline/tilt-series.json', 'baseline/fiducials.json', 'baseline/exclusions.json'],
  scenarios: Object.keys(scenarios).map((id) => `scenarios/${id}.json`),
  replay: 'replay.json',
}, null, 2));

console.log('casepack generated:', TILTS.length, 'frames,', beads.length, 'beads');
