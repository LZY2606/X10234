import { buildCase, makeTiltRange } from './generator';
import type { CaseSpec } from './case-types';
import type { DiagnosisCode } from '../shared/model';

export const DIAGNOSIS_KEYS: DiagnosisCode[] = [
  'AXIS_OFF_CENTER',
  'TRACK_IDENTITY_SWAP_SUSPECTED',
  'MISSING_HIGH_TILT_FRAMES',
  'BAD_FRAME_EXCLUDED',
  'LOCAL_WARP_OVERFIT',
  'NON_UNIQUE_SOLUTION',
  'FEW_FRAMES_RESIDUAL_GAMBIT',
];

// 基线：完整 -60..60、5 条轨迹、明确偏心轴线。
export function baselineCase(): CaseSpec {
  return buildCase({
    caseId: 'case/tilt-room/base',
    title: '倾转帧拼合室 · 基线（完整倾转序列）',
    tilts: makeTiltRange(10, 60),
    seed: 20260924,
    trackCount: 5,
    gaps: [{ track: 2, fromIdx: 4, toIdx: 5, reason: 'fiducial 离开视野（跟踪缺口，未删除）' }],
  });
}

// 1) 轴线偏心：本身基线已偏心；最小案例用更强偏心，禁止默认居中。
export function axisOffCenterCase(): CaseSpec {
  return buildCase({
    caseId: 'case/min/axis-offset',
    title: '最小输入 · 轴线偏心',
    tilts: makeTiltRange(15, 45),
    seed: 11,
    trackCount: 4,
    geometry: { axisOffsetPx: 9.4 },
  });
}

// 2) 轨迹身份交换：tr0 与 tr1 在第 6 帧后错接。
export function swapCase(): CaseSpec {
  const c = buildCase({
    caseId: 'case/min/track-swap',
    title: '最小输入 · fiducial 身份交换',
    tilts: makeTiltRange(10, 60),
    seed: 22,
    trackCount: 4,
    swapTracks: ['case/min/track-swap/tr0', 'case/min/track-swap/tr1', 'case/min/track-swap/f06'],
    gaps: [{ track: 3, fromIdx: 6, toIdx: 7, reason: '缺口后身份重接疑似错误' }],
  });
  return c;
}

// 3) 缺失高倾角帧：±60、±50 缺失。
export function missingHighTiltCase(): CaseSpec {
  return buildCase({
    caseId: 'case/min/missing-high-tilt',
    title: '最小输入 · 缺失高倾角帧',
    tilts: makeTiltRange(10, 60),
    seed: 33,
    trackCount: 4,
    missing: (t) => Math.abs(t) >= 50,
  });
}

// 4) 坏帧：中段一帧显著平移，配手工排除原因。
export function badFrameCase(): CaseSpec {
  return buildCase({
    caseId: 'case/min/bad-frame',
    title: '最小输入 · 坏帧与手工排除',
    tilts: makeTiltRange(10, 60),
    seed: 44,
    trackCount: 4,
    badIndex: 7,
  });
}

// 5) 局部形变过拟合：稀疏点 + 局部涟漪，局部模型留一恶化。
export function overfitCase(): CaseSpec {
  const c = buildCase({
    caseId: 'case/min/local-overfit',
    title: '最小输入 · 局部形变过拟合',
    tilts: makeTiltRange(20, 40), // 仅 5 帧，自由度高
    seed: 55,
    trackCount: 4,
  });
  // 在偶数帧加入法向涟漪（局部、非全局刚体）。
  c.frames.forEach((f, i) => {
    if (i % 2 === 0 && i !== 0) f.rippleN = i === 2 ? 1.1 : 0.0;
  });
  // 在其中一帧注入明显局部运动以诱发每轨迹二次项过拟合
  c.frames[2].rippleN = 1.4;
  return c;
}

// 6) 多解：倾转覆盖窄，轴角近等极小并存。
export function nonUniqueCase(): CaseSpec {
  return buildCase({
    caseId: 'case/min/non-unique',
    title: '最小输入 · 多解（轴角欠定）',
    tilts: [-20, -10, 0, 10, 20],
    seed: 66,
    trackCount: 3,
    geometry: { noisePx: 0.9, axisOffsetPx: 2.0 },
  });
}

// 7) 少帧换低残差（纯候选层反例）：与坏帧同素材，但生成一个非法丢帧候选。
export function gambitBaseCase(): CaseSpec {
  return buildCase({
    caseId: 'case/min/gambit',
    title: '最小输入 · 少帧换低残差',
    tilts: makeTiltRange(10, 60),
    seed: 77,
    trackCount: 4,
    badIndex: 9,
  });
}

// 组合输入：偏心 + 交换 + 缺高倾角 + 坏帧（排除）+ 多解倾向，全部叠加。
export function compositeCase(): CaseSpec {
  const c = buildCase({
    caseId: 'case/composite/all',
    title: '组合输入 · 多边界同时发生',
    tilts: makeTiltRange(10, 60),
    seed: 88,
    trackCount: 5,
    geometry: { axisOffsetPx: 8.1, noisePx: 0.55 },
    missing: (t) => t === 60 || t === -60,
    badIndex: 8,
    excludeIdx: 8,
    excludeReason: '人工复核：明显漂移且剂量记录异常，排除（带原因版本化）',
    swapTracks: ['case/composite/all/tr1', 'case/composite/all/tr3', 'case/composite/all/f07'],
    gaps: [
      { track: 0, fromIdx: 10, toIdx: 11, reason: '高倾角被碳膜遮挡' },
      { track: 4, fromIdx: 2, toIdx: 3, reason: '自动跟踪中断' },
    ],
  });
  return c;
}

export interface CaseEntry {
  key: DiagnosisCode | 'BASELINE';
  spec: CaseSpec;
  branch: string;
}

export function minimalCases(): { key: DiagnosisCode; spec: CaseSpec }[] {
  return [
    { key: 'AXIS_OFF_CENTER', spec: axisOffCenterCase() },
    { key: 'TRACK_IDENTITY_SWAP_SUSPECTED', spec: swapCase() },
    { key: 'MISSING_HIGH_TILT_FRAMES', spec: missingHighTiltCase() },
    { key: 'BAD_FRAME_EXCLUDED', spec: badFrameCase() },
    { key: 'LOCAL_WARP_OVERFIT', spec: overfitCase() },
    { key: 'NON_UNIQUE_SOLUTION', spec: nonUniqueCase() },
    { key: 'FEW_FRAMES_RESIDUAL_GAMBIT', spec: gambitBaseCase() },
  ];
}
