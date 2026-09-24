// 生成「倾转帧拼合室」离线案例包：电镜 tilt-series 轴线、fiducial 轨迹与配准分支。
// 所有输出确定性（固定种子），重跑结果一致。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../casepack/', import.meta.url).pathname;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260919);
const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.2; // ~N(0, ~0.4)

// ---- 成像几何（领域基准）----
const SIZE = 24;                 // 帧尺寸 24x24 px
const CENTER = (SIZE - 1) / 2;   // 图像中心 11.5
const AXIS_CX = 15.2;            // 真实倾转轴 x 位置（偏心，不在图像中心）
const AXIS_CY = 11.5;
const PIXEL_NM = 1.35;           // nm/pixel
const TILTS = [-60, -40, -20, 0, 20, 40, 60];
const frameId = (t) => `frame_${t < 0 ? 'm' : 'p'}${String(Math.abs(t)).padStart(3, '0')}`;

// fiducial 标记：(v 沿倾转方向, u 沿轴线方向)，单位 px
const MARKERS = [
  { id: 'fid_f01', v: -6.0, u: -4.0 },
  { id: 'fid_f02', v: 5.0, u: -6.0, gapAt: 'frame_p020' },          // 跟踪缺口
  { id: 'fid_f03', v: 1.0, u: 3.5, swapWith: 'fid_f04', swapFrom: 'frame_p020' }, // 交叉后身份交换
  { id: 'fid_f04', v: 1.25, u: 4.0 },
  { id: 'fid_f05', v: -2.5, u: 0.5 },
];
const BAD_FRAME = 'frame_p040';   // 运动模糊坏帧
const PICK_ERROR = { traj: 'fid_f01', frame: 'frame_m020', dx: -0.8, dy: 0.5 }; // 人为挑点误差（后续源数据修订）

function project(marker, tiltDeg) {
  const th = (tiltDeg * Math.PI) / 180;
  return { x: AXIS_CX + marker.v * Math.cos(th), y: AXIS_CY + marker.u };
}

// ---- 帧图像（24x24 强度阵列，带高斯斑点）----
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'frames'), { recursive: true });

const frames = [];
for (const tilt of TILTS) {
  const id = frameId(tilt);
  const img = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 18 + Math.floor(rand() * 8)));
  const blurred = id === BAD_FRAME;
  for (const m of MARKERS) {
    const p = project(m, tilt);
    const sigma = blurred ? 1.8 : 0.7;
    const amp = blurred ? 90 : 220;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const dx = x - p.x, dy = y - p.y;
        const d2 = blurred ? dx * dx / (2 * sigma * sigma * 4) + dy * dy / (2 * sigma * sigma)
                           : (dx * dx + dy * dy) / (2 * sigma * sigma);
        img[y][x] = Math.min(255, img[y][x] + Math.round(amp * Math.exp(-d2)));
      }
    }
  }
  const dose = id === 'frame_p060'
    ? { value: 189, unit: 'e-/nm^2', basis: 'detector-counts-calibrated' } // 可换算但单位不同
    : { value: 2.1, unit: 'e-/A^2', basis: 'dose-calibrated' };
  frames.push({
    frameId: id,
    tiltAngle: { value: tilt, unit: 'deg', basis: 'stage-goniometer' },
    accumulatedDose: dose,
    exposureTime: { value: 0.4, unit: 's' },
    image: { width: SIZE, height: SIZE, basis: 'image-pixel', origin: 'top-left', data: `frames/${id}.json` },
  });
  writeFileSync(join(OUT, 'frames', `${id}.json`), JSON.stringify({ frameId: id, width: SIZE, height: SIZE, basis: 'image-pixel', origin: 'top-left', intensities: img }));
}

// ---- fiducial 轨迹（跟踪器输出：含缺口与身份交换）----
const trajOf = {};
for (const m of MARKERS) trajOf[m.id] = [];
for (const tilt of TILTS) {
  const fid = frameId(tilt);
  for (const m of MARKERS) {
    if (m.gapAt === fid) continue; // 跟踪丢失
    // 身份交换：swapFrom 起 fid_f03 的观测实际来自 fid_f04 的标记，反之亦然
    let src = m;
    if (m.swapWith && TILTS.indexOf(tilt) >= TILTS.indexOf(20)) src = MARKERS.find((k) => k.id === m.swapWith);
    if (!m.swapWith && MARKERS.some((k) => k.swapWith === m.id) && TILTS.indexOf(tilt) >= TILTS.indexOf(20)) src = MARKERS.find((k) => k.id === 'fid_f03');
    const p = project(src, tilt);
    const noisy = fid === BAD_FRAME ? 2.0 : 0.35;
    let x = p.x + gauss() * noisy;
    let y = p.y + gauss() * noisy;
    if (PICK_ERROR.traj === m.id && PICK_ERROR.frame === fid) { x += PICK_ERROR.dx; y += PICK_ERROR.dy; }
    trajOf[m.id].push({ frameId: fid, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
  }
}

const trajectories = MARKERS.map((m) => ({
  trajectoryId: `traj_${m.id.slice(4)}`,
  markerId: m.id,
  coordinateBasis: { unit: 'pixel', origin: 'top-left', frameOfReference: 'raw-image' },
  observations: trajOf[m.id],
  trackingGaps: m.gapAt ? [{ frameId: m.gapAt, reason: 'tracking-loss', reportedBy: 'auto-tracker/1.3' }] : [],
}));

// ---- 手工排除原因 ----
const exclusions = [
  { frameId: BAD_FRAME, decision: 'exclude', reason: 'motion-blur', decidedBy: 'em-operator-li', decidedAt: '2026-09-12T09:40:00+09:00' },
];

// ---- 配准参数（v1：错误默认——倾转轴固定在图像中心）----
const alignmentParams = {
  entity: 'alignment_params',
  versionNote: 'v1 默认倾转轴固定于图像中心（待检验的假设）',
  axisPrior: { mode: 'fixed-at-image-center', imageCenter: { x: CENTER, y: CENTER, unit: 'pixel' } },
  tiltAxisAzimuth: { value: 0, unit: 'deg', basis: 'image-frame' },
  models: ['rigid', 'local-deformation', 'exclude-bad-frames'],
};

writeFileSync(join(OUT, 'tilt-series.json'), JSON.stringify({
  seriesId: 'ts_em_2026_0912_a3',
  microscope: { id: 'cryo-em-02', acceleratingVoltage: { value: 300, unit: 'kV' } },
  detector: { id: 'direct-detector-east', pixelSize: { value: PIXEL_NM, unit: 'nm/pixel', basis: 'specimen-plane' } },
  tiltScheme: { direction: 'bidirectional', startTilt: { value: 0, unit: 'deg' } },
  frames,
}, null, 2));

writeFileSync(join(OUT, 'fiducials.json'), JSON.stringify({
  tracker: { name: 'auto-tracker', version: '1.3', note: '轨迹可断裂；交叉处可能发生身份交换' },
  trajectories,
}, null, 2));

writeFileSync(join(OUT, 'exclusions.json'), JSON.stringify({ manualExclusions: exclusions }, null, 2));
writeFileSync(join(OUT, 'alignment-params.json'), JSON.stringify(alignmentParams, null, 2));

writeFileSync(join(OUT, 'revisions.json'), JSON.stringify({
  narrative: '初始导入后：一次参数修订、一次只影响局部依赖的源数据改动、一次互相冲突的人工决定',
  parameterRevision: {
    entity: 'alignment_params',
    change: { axisPrior: { mode: 'free', searchRangePx: 6 } },
    rationale: '轴线偏心诊断显示倾转轴不能默认固定在图像中心，放开轴线先验',
    revisedBy: 'em-operator-li',
  },
  sourceChange: {
    entity: 'traj_f01',
    frameId: 'frame_m020',
    delta: { x: 0.8, y: -0.5, unit: 'pixel' },
    reason: '人工重挑标记点，修正挑点误差；只应使依赖 traj_f01 的结论失效',
    revisedBy: 'em-operator-li',
  },
  conflictingDecisions: [
    { reviewer: 'reviewer-a', frameId: 'frame_p020', decision: 'exclude', reason: '多条轨迹在此帧同时丢失，信噪比不足' },
    { reviewer: 'reviewer-b', frameId: 'frame_p020', decision: 'keep', reason: '缺口可由相邻帧插值补足，排除会损失有效点集' },
  ],
}, null, 2));

writeFileSync(join(OUT, 'scenarios.json'), JSON.stringify({
  note: '七个反例情形：每个保存一个最小输入与一个组合输入；共享原始片段只存一份不可变内容',
  scenarios: [
    { name: 'axis_eccentricity', title: '轴线偏心',
      minimal: { fixAxisAtCenter: true },
      combined: { fixAxisAtCenter: true, doseWeighting: true },
      expect: ['axis_eccentricity'] },
    { name: 'trajectory_identity_swap', title: '轨迹身份交换',
      minimal: { trajectories: ['traj_f03', 'traj_f04'] },
      combined: { trajectories: ['traj_f03', 'traj_f04'], includeGaps: true },
      expect: ['trajectory_identity_swap'] },
    { name: 'missing_high_tilt', title: '缺失高倾角帧',
      minimal: { dropFrames: ['frame_m060', 'frame_p060'] },
      combined: { dropFrames: ['frame_m060', 'frame_p060'], fixAxisAtCenter: true },
      expect: ['missing_high_tilt'] },
    { name: 'bad_frame_exclusion', title: '坏帧排除',
      minimal: { excludeFrames: ['frame_p040'] },
      combined: { excludeFrames: ['frame_p040'], trajectories: ['traj_f03', 'traj_f04'] },
      expect: ['candidate_comparison'] },
    { name: 'local_deformation_overfit', title: '局部形变过拟合',
      minimal: { trajectories: ['fid_f01', 'fid_f03', 'fid_f05'].map((m) => `traj_${m.slice(4)}`), model: 'local-deformation' },
      combined: { trajectories: ['fid_f01', 'fid_f03', 'fid_f05'].map((m) => `traj_${m.slice(4)}`), model: 'local-deformation', excludeFrames: ['frame_p040'] },
      expect: ['local_deformation_overfit'] },
    { name: 'multiple_solutions', title: '多解',
      minimal: { dropFrames: ['frame_m060', 'frame_p060', 'frame_m040', 'frame_p040'], trajectories: ['traj_f01', 'traj_f05'] },
      combined: { dropFrames: ['frame_m060', 'frame_p060'], trajectories: ['traj_f01', 'traj_f05'] },
      expect: ['multiple_solutions'] },
    { name: 'concurrent_freeze', title: '并发冻结',
      minimal: { reviewers: ['reviewer-a', 'reviewer-b'] },
      combined: { reviewers: ['reviewer-a', 'reviewer-b'], withLock: true },
      expect: ['version_conflict'] },
  ],
}, null, 2));

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
  packId: 'tilt-frame-assembly-room',
  title: '倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支',
  packVersion: 1,
  coordinateBasis: { image: 'image-pixel/top-left', tilt: 'stage-goniometer/deg', length: 'nm' },
  files: {
    tiltSeries: 'tilt-series.json',
    fiducials: 'fiducials.json',
    exclusions: 'exclusions.json',
    alignmentParams: 'alignment-params.json',
    revisions: 'revisions.json',
    scenarios: 'scenarios.json',
  },
  frames: frames.map((f) => f.image.data),
}, null, 2));

console.log(`casepack generated: ${frames.length} frames, ${trajectories.length} trajectories`);
