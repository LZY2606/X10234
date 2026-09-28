/**
 * 离线案例包生成器：七类反例各一个最小输入 + 一个组合输入，
 * 共享的原始帧片段（同 contentSignature）最终只存一份不可变内容。
 * 全部输出确定性（无随机数），保证案例包可复现、可版本化。
 */
import { encodeGrayPng } from './png.js';
import { projectBead, type AxisGeometry, type Bead3D } from './projection.js';
import { sha256OfBytes } from './ids.js';
import type {
  CaseBlobRef,
  CaseEventSpec,
  CaseFrameSpec,
  CaseGapSpec,
  CaseIdentityLinkSpec,
  CasePack,
  CaseSegmentSpec,
  CaseTrackSpec,
  MinimalInput,
} from './casepack.js';

export const W = 96;
export const H = 96;
export const N = 21; // 21 帧, -70..70 步长 7

export type Scenario = MinimalInput['scenario'];

export const ALL_SCENARIOS: Scenario[] = [
  'axis-eccentricity',
  'track-identity-swap',
  'missing-high-tilt',
  'bad-frame-exclusion',
  'local-deform-overfit',
  'multiple-solutions',
  'concurrent-freeze',
];

export interface ScenarioConfig {
  scenario: Scenario;
  pivot: { x: number; y: number };
  beads: Bead3D[];
  gaps: { frameIndex: number; labels: number[]; reason: string | null }[];
  swapAt?: { frameIndex: number; beadA: string; beadB: string };
  missingHighTilt?: number[];
  badFrames?: {
    index: number;
    badness: 'crack' | 'drift-burst' | 'focus-loss' | 'ice-contamination';
  }[];
  manualExclusions?: MinimalInput['exclusions'];
  expectedAffected: string[];
  expectedDiagnostics: string[];
}

export const ECCENTRIC_PIVOT = { x: 55, y: 38 }; // 中心 (48,48)，刻意偏移

function stdBeads(): Bead3D[] {
  // 非对称布置，保证唯一解
  return [
    { physicalBeadId: 'bead_n1', u0: -22, v0: -14, z: -8 },
    { physicalBeadId: 'bead_n2', u0: 6, v0: 18, z: 5 },
    { physicalBeadId: 'bead_n3', u0: 20, v0: -6, z: 11 },
    { physicalBeadId: 'bead_n4', u0: -8, v0: 10, z: -15 },
  ];
}

function symmetricBeads(): Bead3D[] {
  // 关于轴局部原点 (v,z)->(-v,-z) 成对对称 => 轴方向非唯一
  return [
    { physicalBeadId: 'bead_s1', u0: -18, v0: -14, z: -10 },
    { physicalBeadId: 'bead_s2', u0: -18, v0: 14, z: 10 },
    { physicalBeadId: 'bead_s3', u0: 12, v0: -18, z: -6 },
    { physicalBeadId: 'bead_s4', u0: 12, v0: 18, z: 6 },
  ];
}

export function scenarioConfigs(): ScenarioConfig[] {
  return [
    {
      scenario: 'axis-eccentricity',
      pivot: ECCENTRIC_PIVOT,
      beads: stdBeads(),
      gaps: [],
      expectedAffected: ['tax_initial'],
      expectedDiagnostics: ['axis/eccentric', 'axis/assumed-center'],
    },
    {
      scenario: 'track-identity-swap',
      pivot: ECCENTRIC_PIVOT,
      beads: stdBeads(),
      gaps: [{ frameIndex: 9, labels: [2, 4], reason: 'tracker-lost' }],
      swapAt: { frameIndex: 9, beadA: 'bead_n2', beadB: 'bead_n4' },
      expectedAffected: ['trk_bead_n2', 'trk_bead_n4'],
      expectedDiagnostics: ['track/identity-swap', 'track/gap'],
    },
    {
      scenario: 'missing-high-tilt',
      pivot: ECCENTRIC_PIVOT,
      beads: stdBeads(),
      gaps: [
        { frameIndex: 19, labels: [1, 2, 3, 4], reason: 'not-acquired' },
        { frameIndex: 20, labels: [1, 2, 3, 4], reason: 'not-acquired' },
      ],
      missingHighTilt: [19, 20],
      expectedAffected: ['ts_series', 'cand_rigid'],
      expectedDiagnostics: ['frame/missing-high-tilt'],
    },
    {
      scenario: 'bad-frame-exclusion',
      pivot: ECCENTRIC_PIVOT,
      beads: stdBeads(),
      gaps: [],
      badFrames: [{ index: 13, badness: 'drift-burst' }],
      manualExclusions: [
        {
          exclusionId: 'exc_frame13',
          target: { scope: 'frame', frameId: 'frm_013' },
          reasonCode: 'bad-frame/drift-burst',
          note: '第13帧漂移突跳，台读数正常但图像错位，人工排除',
          decidedBy: 'em-operator-li',
          decidedAt: '2026-09-20T03:10:00+08:00',
        },
      ],
      expectedAffected: ['frm_013', 'cand_drop_badframes'],
      expectedDiagnostics: ['frame/excluded-bad'],
    },
    {
      scenario: 'local-deform-overfit',
      pivot: ECCENTRIC_PIVOT,
      beads: stdBeads(),
      gaps: [],
      badFrames: [{ index: 10, badness: 'focus-loss' }],
      expectedAffected: ['cand_local_deform'],
      expectedDiagnostics: ['local-deform/overfit'],
    },
    {
      scenario: 'multiple-solutions',
      pivot: ECCENTRIC_PIVOT,
      beads: symmetricBeads(),
      gaps: [],
      expectedAffected: ['cand_rigid'],
      expectedDiagnostics: ['solution/non-unique'],
    },
    {
      scenario: 'concurrent-freeze',
      pivot: ECCENTRIC_PIVOT,
      beads: stdBeads(),
      gaps: [],
      expectedAffected: [],
      expectedDiagnostics: [],
    },
  ];
}

// ---------------------------------------------------------------------------
// 帧像素渲染（确定性合成：背景梯度 + 金粒投影斑点 + 坏帧瑕疵）
// ---------------------------------------------------------------------------

export interface RenderedFrame {
  bytes: Buffer;
  sha256: string;
  signature: string;
}

function angleOf(i: number): number {
  return -70 + i * 7;
}

function renderFrame(
  cfg: ScenarioConfig,
  index: number,
  present: boolean,
): RenderedFrame | null {
  if (!present) return null;
  const gray = Buffer.alloc(W * H);
  const angle = angleOf(index);
  const axis: AxisGeometry = { pivot: cfg.pivot, directionDeg: 12 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 随倾角缓慢变化的背景剂量梯度（模拟厚度/剂量差异，非零均值）
      const base = 26 + 10 * Math.cos((angle * Math.PI) / 180) + (x / W) * 8 + (y / H) * 5;
      gray[y * W + x] = Math.max(0, Math.min(255, Math.round(base)));
    }
  }
  for (const bead of cfg.beads) {
    const p = projectBead(bead, angle, axis);
    paintDisk(gray, p.x, p.y, 3.2, 205);
    paintDisk(gray, p.x - 1, p.y - 1, 1.3, 245);
  }
  const bad = cfg.badFrames?.find((b) => b.index === index);
  if (bad) {
    if (bad.badness === 'crack') {
      for (let y = 10; y < H - 10; y++) {
        const x = 40 + Math.round(3 * Math.sin(y / 5.0));
        gray[y * W + x] = 250;
        gray[y * W + x + 1] = 250;
      }
    } else if (bad.badness === 'drift-burst') {
      for (const bead of cfg.beads) {
        const p = projectBead(bead, angle, axis);
        paintDisk(gray, p.x + 9, p.y + 6, 3.0, 150); // 重影 = 突跳漂移
      }
    } else if (bad.badness === 'focus-loss') {
      for (const bead of cfg.beads) {
        const p = projectBead(bead, angle, axis);
        paintDisk(gray, p.x, p.y, 6.5, 120); // 散焦大软斑
      }
    } else if (bad.badness === 'ice-contamination') {
      paintDisk(gray, 30, 30, 11, 235);
      paintDisk(gray, 64, 60, 8, 230);
    }
  }
  const bytes = encodeGrayPng(W, H, gray);
  return {
    bytes,
    sha256: sha256OfBytes(bytes),
    signature: frameSignature(cfg.scenario, index, angle, bad?.badness),
  };
}

function paintDisk(gray: Buffer, cx: number, cy: number, r: number, val: number): void {
  const r2 = r * r;
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 <= r2) {
        const idx = y * W + x;
        gray[idx] = Math.max(gray[idx], Math.round(val * (1 - d2 / (r2 * 1.6))));
      }
    }
  }
}

function frameSignature(
  scenario: Scenario,
  index: number,
  angle: number,
  badness?: string,
): string {
  // 跨场景共享的“正常帧”使用与场景无关的签名：角度+几何+无瑕疵 => 同字节
  // 为此正常帧的渲染不依赖场景 pivot 差异会造成字节不同，所以共享依据是
  // “同一合成模型下正常帧”的内容；组合输入复用与最小输入完全相同的渲染调用。
  return `${scenario}:f${index}:a${angle}:${badness ?? 'ok'}`;
}

// ---------------------------------------------------------------------------
// 轨迹组装：投影 -> marker 观测；断裂分段 + 身份交换
// ---------------------------------------------------------------------------

const LABEL_BY_BEAD: Record<string, number> = {
  bead_n1: 1,
  bead_n2: 2,
  bead_n3: 3,
  bead_n4: 4,
  bead_s1: 1,
  bead_s2: 2,
  bead_s3: 3,
  bead_s4: 4,
};

function buildTracks(cfg: ScenarioConfig): CaseTrackSpec[] {
  const axis: AxisGeometry = { pivot: cfg.pivot, directionDeg: 12 };
  const gapSet = new Map<number, Set<number>>();
  for (const g of cfg.gaps) gapSet.set(g.frameIndex, new Set(g.labels));

  const tracks: CaseTrackSpec[] = [];
  for (const bead of cfg.beads) {
    const ownLabel = LABEL_BY_BEAD[bead.physicalBeadId];
    // 该物理颗粒在每帧被跟踪器报告成哪个 marker label（交换后改变）
    const labelAt = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      let label = ownLabel;
      if (cfg.swapAt) {
        const { frameIndex, beadA, beadB } = cfg.swapAt;
        if (i > frameIndex) {
          if (bead.physicalBeadId === beadA) label = LABEL_BY_BEAD[beadB];
          else if (bead.physicalBeadId === beadB) label = LABEL_BY_BEAD[beadA];
        }
      }
      labelAt.set(i, label);
    }
    // 分段：在该 bead 缺失的 gap 帧处断开
    const breaks = cfg.gaps
      .filter((g) => (gapSet.get(g.frameIndex) ?? new Set()).has(ownLabel))
      .map((g) => g.frameIndex);
    const segments: CaseSegmentSpec[] = [];
    const bounds = [-1, ...breaks, N];
    for (let k = 0; k < bounds.length - 1; k++) {
      const from = bounds[k] + 1;
      const to = bounds[k + 1] - 1;
      if (from > to) continue;
      const observations = [];
      for (let i = from; i <= to; i++) {
        const label = labelAt.get(i)!;
        const p = projectBead(bead, angleOf(i), axis);
        observations.push({
          markerLabel: label,
          x: Math.round(p.x * 100) / 100,
          y: Math.round(p.y * 100) / 100,
          datum: 'px/unbinned@raw-frame' as const,
          fitQuality: 0.92 + 0.05 * Math.cos((angleOf(i) * Math.PI) / 120),
        });
      }
      segments.push({
        segmentId: `seg_${bead.physicalBeadId}_${segments.length + 1}`,
        indexFrom: from,
        indexTo: to,
        observations,
      });
    }
    const identityLinks: CaseIdentityLinkSpec[] = [];
    for (let k = 1; k < segments.length; k++) {
      const gapFrame = breaks[k - 1];
      const isSwap =
        cfg.swapAt !== undefined &&
        gapFrame === cfg.swapAt.frameIndex &&
        (bead.physicalBeadId === cfg.swapAt.beadA ||
          bead.physicalBeadId === cfg.swapAt.beadB);
      identityLinks.push({
        linkId: `lnk_${bead.physicalBeadId}_${k}`,
        fromSegmentId: segments[k - 1].segmentId,
        toSegmentId: segments[k].segmentId,
        gapFrameIndex: gapFrame,
        status: isSwap ? 'swapped' : 'provisional',
        reason: isSwap
          ? `第${gapFrame}帧跟踪丢失后，marker ${ownLabel} 与对侧标签互换，物理颗粒身份仍连续`
          : `第${gapFrame}帧短暂缺失后续接`,
        swappedWithLinkId: isSwap
          ? `lnk_${
              bead.physicalBeadId === cfg.swapAt!.beadA
                ? cfg.swapAt!.beadB
                : cfg.swapAt!.beadA
            }_${k}`
          : undefined,
      });
    }
    tracks.push({
      trackId: `trk_${bead.physicalBeadId}`,
      physicalBeadId: bead.physicalBeadId,
      segments,
      identityLinks,
    });
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// 组装最小输入
// ---------------------------------------------------------------------------

export function buildMinimalInput(cfg: ScenarioConfig): {
  input: MinimalInput;
  blobs: Map<string, { bytes: Buffer; path: string }>;
} {
  const missing = new Set(cfg.missingHighTilt ?? []);
  const frames: CaseFrameSpec[] = [];
  const blobs = new Map<string, { bytes: Buffer; path: string }>();
  for (let i = 0; i < N; i++) {
    const present = !missing.has(i);
    const rendered = renderFrame(cfg, i, present);
    const bad = cfg.badFrames?.find((b) => b.index === i);
    const frameId = `frm_${i.toString().padStart(3, '0')}`;
    let blob: CaseBlobRef | undefined;
    if (rendered) {
      const path = `shared/raw_frames/${rendered.sha256}.png`;
      blob = {
        blobId: `blob_${rendered.sha256.slice(0, 16)}`,
        sha256: rendered.sha256,
        byteLength: rendered.bytes.length,
        mediaType: 'image/png',
        path,
      };
      if (!blobs.has(rendered.sha256)) blobs.set(rendered.sha256, { bytes: rendered.bytes, path });
    }
    frames.push({
      frameId,
      acquisitionIndex: i,
      widthPx: W,
      heightPx: H,
      contentSignature: rendered?.signature ?? `missing:a${angleOf(i)}`,
      blob: blob as CaseBlobRef,
      role: missing.has(i)
        ? 'missing-high-tilt'
        : bad
          ? 'bad'
          : 'normal',
      badness: bad?.badness,
      present,
    });
  }

  const angles = frames
    .filter((f) => f.present)
    .map((f) => ({
      angleId: `ang_${f.acquisitionIndex.toString().padStart(3, '0')}`,
      frameId: f.frameId,
      acquisitionIndex: f.acquisitionIndex,
      rawValue: angleOf(f.acquisitionIndex),
      rawUnit: 'degrees',
      convention: 'degrees/signed/raw-stage' as const,
    }));

  const scales = [
    { scaleId: 'pxsc_global', frameId: null, rawValue: 2.72, rawUnit: 'A/pixel' as const },
  ];

  const doses = frames
    .filter((f) => f.present)
    .map((f, k) => ({
      doseId: `dose_${f.acquisitionIndex.toString().padStart(3, '0')}`,
      frameId: f.frameId,
      acquisitionIndex: f.acquisitionIndex,
      cumulativeRaw: Math.round((0.8 + k * 2.15) * 100) / 100,
      perFrameRaw: 2.15,
      rawUnit: 'e-/A^2' as const,
    }));

  const gaps: CaseGapSpec[] = cfg.gaps.map((g, k) => ({
    gapId: `gap_${k + 1}`,
    frameId: `frm_${g.frameIndex.toString().padStart(3, '0')}`,
    acquisitionIndex: g.frameIndex,
    missingMarkerLabels: g.labels,
    reasonRaw: g.reason,
  }));

  const input: MinimalInput = {
    scenario: cfg.scenario,
    frames,
    angles,
    scales,
    doses,
    tracks: buildTracks(cfg),
    gaps,
    exclusions: (cfg.manualExclusions ?? []) as MinimalInput['exclusions'],
    axisTruth: {
      pivot: cfg.pivot,
      imageCenter: { x: W / 2, y: H / 2 },
      directionDeg: 12,
    },
    expectedAffected: cfg.expectedAffected,
    expectedDiagnostics: cfg.expectedDiagnostics,
  };
  return { input, blobs };
}

// ---------------------------------------------------------------------------
// 组合输入：七类边界同时出现（并发冻结不改变材料，仅在重放脚本中体现）
// ---------------------------------------------------------------------------

export function buildCombinedInput(): {
  input: MinimalInput;
  blobs: Map<string, { bytes: Buffer; path: string }>;
} {
  const cfg: ScenarioConfig = {
    scenario: 'combined' as Scenario,
    pivot: ECCENTRIC_PIVOT,
    beads: stdBeads(),
    gaps: [
      { frameIndex: 9, labels: [2, 4], reason: 'tracker-lost' },
      { frameIndex: 20, labels: [1, 2, 3, 4], reason: 'not-acquired' },
    ],
    swapAt: { frameIndex: 9, beadA: 'bead_n2', beadB: 'bead_n4' },
    missingHighTilt: [20],
    badFrames: [
      { index: 13, badness: 'drift-burst' },
      { index: 10, badness: 'focus-loss' },
    ],
    manualExclusions: [
      {
        exclusionId: 'exc_frame13',
        target: { scope: 'frame', frameId: 'frm_013' },
        reasonCode: 'bad-frame/drift-burst',
        note: '组合案例：第13帧漂移突跳，人工排除',
        decidedBy: 'em-operator-li',
        decidedAt: '2026-09-20T03:10:00+08:00',
      },
    ],
    expectedAffected: [
      'tax_initial',
      'trk_bead_n2',
      'trk_bead_n4',
      'ts_series',
      'frm_013',
      'cand_local_deform',
      'cand_rigid',
    ],
    expectedDiagnostics: [
      'axis/eccentric',
      'axis/assumed-center',
      'track/identity-swap',
      'track/gap',
      'frame/missing-high-tilt',
      'frame/excluded-bad',
      'local-deform/overfit',
    ],
  };
  const built = buildMinimalInput(cfg);
  (built.input as MinimalInput & { scenario: string }).scenario = 'combined';
  return built;
}

export function replayEvents(): CaseEventSpec[] {
  return [
    {
      type: 'parameter-revision',
      eventId: 'evt_rev_axis_from_data',
      at: '2026-09-20T04:00:00+08:00',
      by: 'em-scientist-chen',
      changes: { assumedCenter: false, axisPivotX: ECCENTRIC_PIVOT.x, axisPivotY: ECCENTRIC_PIVOT.y, regularization: 0.25 },
      note: '放弃“轴在图像中心”的默认值，改用 fiducial 正弦拟合估计偏心轴线，并给局部形变加正则',
    },
    {
      type: 'local-source-change',
      eventId: 'evt_src_dose_unit_reannotate',
      at: '2026-09-20T04:20:00+08:00',
      by: 'em-operator-li',
      sourceEntityKind: 'ExposureDose',
      sourceStableId: 'dose_010',
      newVersion: 2,
      note: '仅把第10帧剂量原文从 e-/A^2 更正为重新标定值；只允许影响剂量派生与权重，不得重算轴线',
    },
    {
      type: 'manual-decision',
      eventId: 'evt_dec_lock_dropbad',
      at: '2026-09-20T04:40:00+08:00',
      by: 'em-reviewer-a',
      decision: 'lock',
      candidateLabel: 'drop-badframes-v1',
      note: '在相同有效点集上，排除坏帧方案残差更低且不过拟合，锁定供重建引用',
      conflictsWith: 'evt_dec_lock_rigid_concurrent',
    },
    {
      type: 'manual-decision',
      eventId: 'evt_dec_lock_rigid_concurrent',
      at: '2026-09-20T04:40:02+08:00',
      by: 'em-reviewer-b',
      decision: 'lock',
      candidateLabel: 'rigid-v1',
      note: '另一审阅窗口几乎同时锁定刚体方案；后提交者必须看到版本冲突与双方差异',
    },
  ];
}

export function buildCasePack(): {
  pack: CasePack;
  blobs: Map<string, { bytes: Buffer; path: string }>;
} {
  const blobs = new Map<string, { bytes: Buffer; path: string }>();
  const minimalInputs = scenarioConfigs().map((cfg) => {
    const { input, blobs: b } = buildMinimalInput(cfg);
    for (const [k, v] of b) if (!blobs.has(k)) blobs.set(k, v);
    return input;
  });
  const combinedBuilt = buildCombinedInput();
  for (const [k, v] of combinedBuilt.blobs) if (!blobs.has(k)) blobs.set(k, v);

  const pack: CasePack = {
    packFormat: 'tilt-assembly-room/case-pack/v1',
    title: '倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支',
    seriesName: 'gold-fiducials-on-lamella-96px',
    seriesId: 'ts_series',
    coordinateDatum: 'px/unbinned@raw-frame',
    createdAt: '2026-09-20T02:00:00+08:00',
    minimalInputs,
    combined: combinedBuilt.input,
    replay: { branchId: 'brch_main', events: replayEvents() },
    domainNotes:
      '21 帧 -70°..70° 倾转序列，像素尺度 2.72 Å/px，累计剂量逐帧递增；4 颗金粒 fiducial，' +
      '倾转轴 pivot=(55,38) 刻意偏离图像中心 (48,48)。轨迹在第9帧断裂且 marker 2/4 身份交换，' +
      '第20帧（+70°）缺失，第13帧为漂移坏帧。所有量带单位/坐标基准；不可换算值保留原位并附诊断。',
  };
  return { pack, blobs };
}
