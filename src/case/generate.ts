import {
  ID,
  sha256,
} from '../domain/ids.js';
import {
  addGaussianBead,
  addNoise,
  blankImage,
  encodePGM,
  type GrayImage,
} from '../domain/frames.js';
import {
  parseAngle,
  parseDose,
  parsePixelScale,
} from '../domain/units.js';
import type {
  FrameSource,
  TiltAngleSource,
  PixelScaleSource,
  DoseSource,
  FiducialPointObservation,
  TrackingGap,
  ManualExclusionReason,
  IdentitySwap,
} from '../domain/types.js';

/**
 * 固定离线案例“倾转帧拼合室”。不是通用表格，而是带像素帧、剂量、
 * fiducial 轨迹与七种情形（轴线偏心/身份交换/缺失高倾角/坏帧/局部过拟合/多解/并发冻结）的领域材料。
 */

export const CASE_SERIES_ID = ID.series(1);
export const CASE_BRANCH_MAIN = `${CASE_SERIES_ID}/main`;
export const CASE_BRANCH_AXIS = `${CASE_SERIES_ID}/axis-offcenter`;
export const IMG_W = 120;
export const IMG_H = 96;
export const N_TILT = 25; // -60..60 步长 5

export interface CasePointSeed {
  markerId: string;
  x: number; // 参考帧像素
  y: number;
}

export interface ScenarioSpec {
  code:
    | 'axis-eccentricity'
    | 'identity-swap'
    | 'missing-high-tilt'
    | 'bad-frame'
    | 'local-overfit'
    | 'multi-solution'
    | 'concurrent-freeze';
  title: string;
  branch: string;
  /** 组合输入与最小输入共享的原始片段 key（只存一份字节）。 */
  sharedBlobs: string[];
}

export interface CaseBundle {
  manifest: {
    seriesId: string;
    title: string;
    narrative: string;
    schemaVersion: number;
    createdAt: string;
    branches: { branchId: string; name: string; parent: string | null }[];
    scenarios: ScenarioSpec[];
  };
  /** 内容寻址字节：共享原始片段只出现一次。 */
  blobs: { contentId: string; mediaType: string; bytesBase64: string; sha256: string }[];
  frames: FrameSource[];
  tilts: TiltAngleSource[];
  scales: PixelScaleSource[];
  doses: DoseSource[];
  points: FiducialPointObservation[];
  gaps: TrackingGap[];
  exclusions: ManualExclusionReason[];
  /** 情形最小输入引用（帧/点 id）与组合输入。 */
  scenarios: Record<
    string,
    {
      minimal: { frameIds: string[]; markerIds: string[]; note: string };
      combined: { frameIds: string[]; markerIds: string[]; note: string };
    }
  >;
  /** 导入后要执行的剧本步骤（服务层重放）。 */
  playbook: CasePlayStep[];
  swaps: IdentitySwap[];
}

export type CasePlayStep =
  | { op: 'import' }
  | { op: 'param-revise'; branch: string; axisOrigin: [number, number]; axisAngleDeg: number; note: string }
  | { op: 'source-fix'; branch: string; frameId: string; field: string; before: string; after: string; note: string }
  | { op: 'conflicting-decisions'; branch: string; candidateKinds: string[]; note: string }
  | { op: 'scenario-flag'; code: ScenarioSpec['code']; branch: string; note: string };

// marker 3D 种子（x,y 像素，z 任意，用于投影）
const MARKERS: CasePointSeed[] = [
  { markerId: ID.marker(CASE_SERIES_ID, 1), x: 34, y: 30 },
  { markerId: ID.marker(CASE_SERIES_ID, 2), x: 66, y: 28 },
  { markerId: ID.marker(CASE_SERIES_ID, 3), x: 48, y: 52 },
  { markerId: ID.marker(CASE_SERIES_ID, 4), x: 82, y: 58 },
  { markerId: ID.marker(CASE_SERIES_ID, 5), x: 28, y: 66 },
  { markerId: ID.marker(CASE_SERIES_ID, 6), x: 72, y: 72 },
];

const AXIS_OFFSET_X = 14; // 故意偏心：轴不经过图像中心
const AXIS_OFFSET_Y = -9;

export function tiltAngles(): number[] {
  const out: number[] = [];
  for (let i = 0; i < N_TILT; i++) out.push(-60 + i * 5);
  return out;
}

/** 投影模型：绕偏置轴倾转，marker 横向移动 1/cos，含剂量依赖漂移与噪声。 */
function projectMarker(m: CasePointSeed, angleDeg: number, frameIndex: number, opts: { swap?: boolean }): { x: number; y: number } {
  const t = (angleDeg * Math.PI) / 180;
  const cx = IMG_W / 2 + AXIS_OFFSET_X;
  const cy = IMG_H / 2 + AXIS_OFFSET_Y;
  let dx = m.x - cx;
  const dy = m.y - cy;
  dx = dx / Math.cos(t); // 倾转横向拉伸
  let x = cx + dx;
  let y = cy + dy;
  // 帧漂移（剂量诱导）+ 确定性噪声
  const drift = frameIndex * 0.12;
  x += drift + Math.sin(frameIndex * 1.7 + m.x) * 0.5;
  y += Math.cos(frameIndex * 1.3 + m.y) * 0.5;
  if (opts.swap) {
    // 交换在观测坐标层的标记在两个 marker 间处理，这里占位
  }
  return { x, y };
}

const BAD_FRAME_INDEX = 17; // +25° 坏帧：运动模糊/漂移
const MISSING_HIGH_TILT_INDICES = [0, 1, 23, 24]; // -60,-55,+55,+60 丢失高倾角

/** marker2 在帧 12..14 与 marker4 身份交换（跟踪软件错配）。 */
const SWAP_MARKERS = [ID.marker(CASE_SERIES_ID, 2), ID.marker(CASE_SERIES_ID, 4)];
const SWAP_FRAMES = [12, 13, 14];

function renderFrame(frameIndex: number, angleDeg: number, positions: { x: number; y: number; intensity: number }[], bad: boolean): GrayImage {
  const img = blankImage(IMG_W, IMG_H, 14 + Math.round(frameIndex * 0.3));
  for (const p of positions) {
    addGaussianBead(img, p.x, p.y, bad ? 3.4 : 2.2, bad ? p.intensity * 0.55 : p.intensity);
  }
  if (bad) {
    // 运动模糊：重复水平拖影
    for (const p of positions) {
      for (const s of [1]) {
        addGaussianBead(img, p.x + 4 * s, p.y + 0.6, 2.6, p.intensity * 0.3);
        addGaussianBead(img, p.x - 4 * s, p.y - 0.6, 2.6, p.intensity * 0.3);
      }
    }
  }
  addNoise(img, bad ? 9 : 4, 1000 + frameIndex);
  return img;
}

export function generateCaseBundle(): CaseBundle {
  const angles = tiltAngles();
  const blobs = new Map<string, { contentId: string; mediaType: string; bytesBase64: string; sha256: string }>();
  const frames: FrameSource[] = [];
  const tilts: TiltAngleSource[] = [];
  const doses: DoseSource[] = [];
  const points: FiducialPointObservation[] = [];
  const gaps: TrackingGap[] = [];
  const exclusions: ManualExclusionReason[] = [];

  const dosePerTilt = 2.0; // e-/A^2 per tilt
  let pointSeq = 0;

  // 每帧渲染；丢失高倾角帧不生成像素（用 acquisitionRecorded 表达缺失）
  for (let i = 0; i < N_TILT; i++) {
    const frameId = ID.frame(CASE_SERIES_ID, i);
    const recorded = !MISSING_HIGH_TILT_INDICES.includes(i);
    const angle = angles[i];
    const bad = i === BAD_FRAME_INDEX;
    const positions: { x: number; y: number; intensity: number }[] = [];

    // 该帧各 marker 是否可见（marker5 在高负角出界 -> 缺口）
    for (const m of MARKERS) {
      const proj = projectMarker(m, angle, i, {});
      let visible = proj.x > 2 && proj.x < IMG_W - 2 && proj.y > 2 && proj.y < IMG_H - 2;
      if (m.markerId === ID.marker(CASE_SERIES_ID, 5) && angle <= -45) visible = false;
      if (!visible) continue;

      let { x, y } = proj;
      // 坏帧全局大漂移
      if (bad) {
        x += 7;
        y += 3;
      }
      const swapped = SWAP_MARKERS.includes(m.markerId) && SWAP_FRAMES.includes(i);
      // 交换：把坐标贴给另一个 marker 的观测（身份交换）
      if (swapped) {
        const otherId = SWAP_MARKERS.find((q) => q !== m.markerId)!;
        const otherSeed = MARKERS.find((q2) => q2.markerId === otherId)!;
        const op = projectMarker(otherSeed, angle, i, {});
        x = op.x + (bad ? 7 : 0);
        y = op.y + (bad ? 3 : 0);
      }
      const intensity = 150 * Math.max(0.35, Math.cos(t(angle))) + 30;
      positions.push({ x, y, intensity });
      pointSeq += 1;
      const pointId = ID.point(m.markerId, pointSeq);
      points.push({
        id: pointId,
        seriesId: CASE_SERIES_ID,
        markerId: m.markerId,
        frameId,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        basis: { kind: 'pixel', origin: 'top-left' },
        sigmaPx: bad ? 1.6 : 0.8,
        observedBy: 'tracking-software v3',
      });
    }

    if (recorded) {
      const img = renderFrame(i, angle, positions, bad);
      const bytes = encodePGM(img);
      const hash = sha256(bytes);
      const contentId = `blob-${hash.slice(0, 32)}`;
      if (!blobs.has(contentId)) {
        blobs.set(contentId, {
          contentId,
          mediaType: 'image/x-portable-graymap',
          bytesBase64: Buffer.from(bytes).toString('base64'),
          sha256: hash,
        });
      }
      frames.push({
        id: frameId,
        seriesId: CASE_SERIES_ID,
        index: i,
        label: `tilt_${String(i).padStart(2, '0')}_${angle >= 0 ? '+' : ''}${angle}.pgm`,
        blobRef: contentId,
        width: IMG_W,
        height: IMG_H,
        mediaType: 'image/x-portable-graymap',
        acquisitionRecorded: true,
      });
      tilts.push({
        id: ID.angle(frameId),
        seriesId: CASE_SERIES_ID,
        frameId,
        angle: parseAngle(`${angle} °`, 'stage'),
      });
      doses.push({
        id: `${frameId}/dose`,
        seriesId: CASE_SERIES_ID,
        frameId,
        cumulative: parseDose(`${(dosePerTilt * (i + 1)).toFixed(1)} e-/Å^2`, 'cumulative'),
        perFrame: parseDose(`${dosePerTilt} e-/Å^2`, 'per-frame'),
      });
    } else {
      frames.push({
        id: frameId,
        seriesId: CASE_SERIES_ID,
        index: i,
        label: `tilt_${String(i).padStart(2, '0')}_MISSING.pgm`,
        blobRef: '',
        width: IMG_W,
        height: IMG_H,
        mediaType: 'image/x-portable-graymap',
        acquisitionRecorded: false,
      });
      tilts.push({
        id: ID.angle(frameId),
        seriesId: CASE_SERIES_ID,
        frameId,
        angle: parseAngle(`${angle} °`, 'stage'),
      });
    }
  }

  // 显式跟踪缺口：marker5 在 -60..-45 出界
  gaps.push({
    id: ID.gap(ID.marker(CASE_SERIES_ID, 5), 1),
    seriesId: CASE_SERIES_ID,
    markerId: ID.marker(CASE_SERIES_ID, 5),
    fromFrameIndex: 0,
    toFrameIndex: 3,
    reason: 'out-of-field',
    note: '高负倾角该金颗粒移出视场',
  });
  // marker3 在坏帧附近低信号
  gaps.push({
    id: ID.gap(ID.marker(CASE_SERIES_ID, 3), 1),
    seriesId: CASE_SERIES_ID,
    markerId: ID.marker(CASE_SERIES_ID, 3),
    fromFrameIndex: BAD_FRAME_INDEX,
    toFrameIndex: BAD_FRAME_INDEX,
    reason: 'low-signal',
    note: '运动模糊帧金颗粒信号低于跟踪阈值',
  });

  // 手工排除原因（坏帧），版本化、可撤销
  exclusions.push({
    id: ID.exclusion(ID.frame(CASE_SERIES_ID, BAD_FRAME_INDEX), 1),
    seriesId: CASE_SERIES_ID,
    frameId: ID.frame(CASE_SERIES_ID, 17),
    scope: 'frame',
    reason: 'motion-blur',
    rationale: '+25° 帧出现明显拖影与全局 7px 漂移，值班电镜工程师手工标记',
    decidedBy: 'em-operator@lab',
    active: true,
  });

  const scales: PixelScaleSource[] = [
    {
      id: ID.scale(CASE_SERIES_ID),
      seriesId: CASE_SERIES_ID,
      scale: parsePixelScale('1.42 nm/px', 'image'),
    },
  ];

  const swaps: IdentitySwap[] = [
    {
      atFrameIndex: 12,
      markerA: SWAP_MARKERS[0],
      markerB: SWAP_MARKERS[1],
      evidence: '帧12起轨迹交叉，软件把 mk-02 与 mk-04 的观测互换至帧14',
      resolved: false,
    },
  ];

  const scenarioCodes: ScenarioSpec['code'][] = [
    'axis-eccentricity',
    'identity-swap',
    'missing-high-tilt',
    'bad-frame',
    'local-overfit',
    'multi-solution',
    'concurrent-freeze',
  ];
  const scenarios: CaseBundle['scenarios'] = {};
  for (const code of scenarioCodes) {
    const high = angles.map((_, i) => i).filter((i) => !MISSING_HIGH_TILT_INDICES.includes(i));
    scenarios[code] = {
      minimal: minimalFor(code, high),
      combined: {
        frameIds: frames.map((f) => f.id),
        markerIds: MARKERS.map((m) => m.markerId),
        note: '组合输入：在完整倾转序列上叠加该情形并与其它边界条件并存',
      },
    };
  }

  return {
    manifest: {
      seriesId: CASE_SERIES_ID,
      title: '倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支',
      narrative:
        '电镜小组导入倾转序列、曝光剂量和 fiducial 点轨迹，比较刚体、局部形变与排除坏帧的配准方案；' +
        '在不把轴默认放在图像中心、轨迹可断裂且身份可交换的前提下，用相同有效点集比较候选。',
      schemaVersion: 3,
      createdAt: '2026-09-24T00:00:00.000Z',
      branches: [
        { branchId: CASE_BRANCH_MAIN, name: 'main', parent: null },
        { branchId: CASE_BRANCH_AXIS, name: 'axis-offcenter-review', parent: CASE_BRANCH_MAIN },
      ],
      scenarios: scenarioCodes.map((code, i) => ({
        code,
        title: scenarioTitle(code),
        branch: i === 0 ? CASE_BRANCH_AXIS : CASE_BRANCH_MAIN,
        sharedBlobs: ['shared-rendered-tilt-frames'],
      })),
    },
    blobs: [...blobs.values()],
    frames,
    tilts,
    scales,
    doses,
    points,
    gaps,
    exclusions,
    scenarios,
    swaps,
    playbook: [
      { op: 'import' },
      {
        op: 'param-revise',
        branch: CASE_BRANCH_AXIS,
        axisOrigin: [IMG_W / 2 + AXIS_OFFSET_X, IMG_H / 2 + AXIS_OFFSET_Y],
        axisAngleDeg: 2.5,
        note: '参数修订：显式把轴线移到偏心位置并给出方向',
      },
      {
        op: 'source-fix',
        branch: CASE_BRANCH_MAIN,
        frameId: ID.frame(CASE_SERIES_ID, 8),
        field: 'dose',
        before: '18.0 e-/Å^2',
        after: '19.0 e-/Å^2',
        note: '只影响局部依赖的源数据改动：重算帧8相关残差，不全局替换',
      },
      {
        op: 'conflicting-decisions',
        branch: CASE_BRANCH_MAIN,
        candidateKinds: ['rigid', 'local-deformation'],
        note: '两个窗口同时保存：后提交者看到版本冲突及双方差异',
      },
    ],
  };
}

function t(deg: number): number {
  return (deg * Math.PI) / 180;
}

function minimalFor(code: ScenarioSpec['code'], recordedFrames: number[]): { frameIds: string[]; markerIds: string[]; note: string } {
  const f = (i: number) => ID.frame(CASE_SERIES_ID, i);
  const m = (n: number) => ID.marker(CASE_SERIES_ID, n);
  switch (code) {
    case 'axis-eccentricity':
      return { frameIds: [f(3), f(12), f(21)], markerIds: [m(1), m(2), m(3)], note: '低/中/高三倾角各一帧即可暴露轴线偏心' };
    case 'identity-swap':
      return { frameIds: [f(11), f(12), f(13), f(14), f(15)], markerIds: [m(2), m(4)], note: '交换窗口前后各一帧' };
    case 'missing-high-tilt':
      return { frameIds: [f(0), f(1), f(2), f(22), f(23), f(24)], markerIds: [m(1), m(3)], note: '高倾角端缺失帧' };
    case 'bad-frame':
      return { frameIds: [f(16), f(17), f(18)], markerIds: [m(1), m(2), m(3)], note: '坏帧及相邻帧' };
    case 'local-overfit':
      return { frameIds: recordedFrames.slice(8, 20).map(f), markerIds: [m(1), m(2), m(3), m(4)], note: '中段足够帧数以暴露过拟合' };
    case 'multi-solution':
      return { frameIds: [f(11), f(12), f(13), f(14)], markerIds: [m(2), m(4)], note: '身份交换导致多解' };
    case 'concurrent-freeze':
      return { frameIds: [f(12)], markerIds: [m(1), m(2)], note: '同分支同一基版本并发保存' };
  }
}

function scenarioTitle(code: ScenarioSpec['code']): string {
  return {
    'axis-eccentricity': '轴线偏心',
    'identity-sap': '轨迹身份交换',
    'identity-swap': '轨迹身份交换',
    'missing-high-tilt': '缺失高倾角帧',
    'bad-frame': '坏帧排除',
    'local-overfit': '局部形变过拟合',
    'multi-solution': '多解',
    'concurrent-freeze': '并发冻结',
  }[code];
}
