import { solveRegistration, hashStr } from '../shared/geometry';
import { diag } from '../shared/geometry';
import type { CandidateReport, MarkerObservation, RuleCode } from '../shared/types';

export interface AnalysisInput {
  seriesRef: string;
  width: number;
  height: number;
  frames: { frameId: string; tiltAngleDeg: number; acquired: boolean }[];
  tracks: Record<string, MarkerObservation[]>;
  missingFrames: string[];
  exclusions: { frameId: string; reason: string }[];
  identitySwap?: { cutFrame: string; pair: [string, string] };
}

export interface CandidateSpec {
  kind: CandidateReport['kind'];
  excludedFrames?: string[];
  forceCenterAxis?: boolean;
  localWarp?: boolean;
  identityMap?: Record<string, string>;
  betaStart?: number;
  label: string;
}

function commonSetRms(
  input: AnalysisInput,
  frames: AnalysisInput['frames'],
  tracks: Record<string, MarkerObservation[]>,
  excluded: string[],
  identityMap: Record<string, string> | undefined,
  forceCenter: boolean,
  localWarp: boolean,
  betaStart?: number
): number {
  const allowed = new Set(frames.filter((f) => f.acquired && !excluded.includes(f.frameId)).map((f) => f.frameId));
  const allKeys = new Set<string>();
  for (const key of Object.keys(tracks)) for (const o of tracks[key]) if (allowed.has(o.frameId)) allKeys.add(key);
  const filteredTracks: Record<string, MarkerObservation[]> = {};
  for (const key of [...allKeys].sort()) {
    filteredTracks[key] = tracks[key].filter((o) => allowed.has(o.frameId));
  }
  const res = solveRegistration({
    frames,
    tracks: filteredTracks,
    width: input.width,
    height: input.height,
    excludedFrames: excluded,
    identityMap,
    forceCenterAxis: forceCenter,
    localWarp,
    holdoutFraction: 0,
    betaStart
  });
  return res.trainRmsPx;
}

export function evaluateCandidate(input: AnalysisInput, spec: CandidateSpec): CandidateReport {
  const excluded = spec.excludedFrames ?? [];
  const diagnostics: CandidateReport['diagnostics'] = [];
  const res = solveRegistration({
    frames: input.frames,
    tracks: input.tracks,
    width: input.width,
    height: input.height,
    excludedFrames: excluded,
    identityMap: spec.identityMap,
    forceCenterAxis: spec.forceCenterAxis,
    localWarp: spec.localWarp,
    holdoutFraction: spec.kind === 'local-warp' ? 0.28 : 0.2,
    betaStart: spec.betaStart
  });

  const planned = input.frames.filter((f) => f.acquired).length;
  if (res.framesUsed < planned) {
    diagnostics.push(
      diag(
        'RULE_NO_FRAME_DROPPING_FOR_RESIDUAL',
        'fail',
        `该候选少用 ${planned - res.framesUsed} 帧；不同候选必须在相同有效点集上比较，禁止用少帧换低残差`,
        excluded.map((f) => `${input.seriesRef}#frame/${f}`)
      )
    );
  }
  if (input.missingFrames.length) {
    diagnostics.push(
      diag('MISSING_HIGH_TILT', 'warn', `计划缺口 ${input.missingFrames.join(', ')}（not-acquired），不得当作坏帧删除；轴线不确定度上升`)
    );
  }
  for (const e of input.exclusions) {
    if (!excluded.includes(e.frameId)) {
      diagnostics.push(diag('EXCLUSION_NOT_APPLIED', 'warn', `存在人工排除原因但候选未使用：${e.frameId} — ${e.reason}`));
    } else {
      diagnostics.push(diag('MANUAL_EXCLUSION_APPLIED', 'info', `应用带原因的手工排除 ${e.frameId}: ${e.reason}`));
    }
  }
  if (spec.forceCenterAxis) {
    diagnostics.push(
      diag('RULE_AXIS_NOT_CENTER', 'warn', '轴线被强制固定在图像中心；规则要求自由估计轴线位置，偏心时高倾角会出现系统残差')
    );
  }
  if (spec.identityMap) {
    diagnostics.push(
      diag('RULE_TRACK_BREAKABLE_SWAPPABLE', 'info', '使用断裂段交换映射重解（fiducial 轨迹可断裂且可能身份交换）', Object.values(spec.identityMap).map((m) => `${input.seriesRef}#track/${m}`))
    );
  }

  let legal = true;
  if (spec.kind === 'local-warp') {
    const gap = res.heldoutRmsPx - res.trainRmsPx;
    if (res.heldoutRmsPx > res.trainRmsPx * 1.8 || gap > 1.5) {
      legal = false;
      diagnostics.push(diag('LOCAL_WARP_OVERFIT', 'fail', `局部形变 train=${res.trainRmsPx.toFixed(3)} 但 held-out=${res.heldoutRmsPx.toFixed(3)} px，泛化失败 → 过拟合`));
    }
  }

  const allExcluded = input.exclusions.map((e) => e.frameId);
  const common = commonSetRms(
    input,
    input.frames,
    input.tracks,
    allExcluded,
    spec.identityMap,
    !!spec.forceCenterAxis,
    !!spec.localWarp,
    spec.betaStart
  );

  return {
    candidateId: `${input.seriesRef}/candidate/${spec.kind}`,
    kind: spec.kind,
    axisAngleDeg: Number(res.axisAngleDeg.toFixed(3)),
    axisOffsetPx: { x: Number(res.axisOffsetXPx.toFixed(3)), y: Number(res.axisOffsetYPx.toFixed(3)) },
    frameResiduals: res.frameResiduals,
    trainRmsPx: Number(res.trainRmsPx.toFixed(3)),
    heldoutRmsPx: Number.isFinite(res.heldoutRmsPx) ? Number(res.heldoutRmsPx.toFixed(3)) : 0,
    commonSetRmsPx: Number(common.toFixed(3)),
    framesUsed: res.framesUsed,
    framesPlanned: planned,
    observationsUsed: res.observationsUsed,
    diagnostics,
    legal,
    basis: [input.seriesRef]
  };
}

export function axisAmbiguityScan(input: AnalysisInput): { axisAngleDeg: number; rmsPx: number }[] {
  const peaks: { axisAngleDeg: number; rmsPx: number }[] = [];
  for (let beta = -80; beta <= 80; beta += 4) {
    const res = solveRegistration({
      frames: input.frames,
      tracks: input.tracks,
      width: input.width,
      height: input.height,
      holdoutFraction: 0,
      betaStart: beta
    });
    peaks.push({ axisAngleDeg: Number(res.axisAngleDeg.toFixed(2)), rmsPx: Number(res.trainRmsPx.toFixed(3)) });
  }
  peaks.sort((a, b) => a.rmsPx - b.rmsPx);
  const distinct: typeof peaks = [];
  for (const p of peaks) {
    if (!distinct.some((d) => Math.abs(((d.axisAngleDeg - p.axisAngleDeg + 90) % 180) - 90) < 8)) distinct.push(p);
    if (distinct.length >= 4) break;
  }
  return distinct;
}

export function ruleDiagnosticEvents(): { code: RuleCode; statement: string }[] {
  return [
    { code: 'RULE_AXIS_NOT_CENTER', statement: '倾转轴不能被默认固定在图像中心，必须由 fiducial 数据自由估计轴线角与偏移。' },
    { code: 'RULE_TRACK_BREAKABLE_SWAPPABLE', statement: 'fiducial 轨迹可以断裂成段，段间可能发生身份交换；交换是显式假设而非清洗。' },
    { code: 'RULE_COMMON_VALID_POINT_SET', statement: '不同候选用相同有效点集比较；commonSetRms 是唯一公平比较口径。' },
    { code: 'RULE_NO_FRAME_DROPPING_FOR_RESIDUAL', statement: '不允许用少帧换低残差；只有带原因的人工排除可以删帧，且所有候选在该口径下重算。' },
    { code: 'RULE_KEEP_ALL_LEGAL_CANDIDATES', statement: '无法唯一决定时保留全部合法候选，等待人工裁定，禁止导入时挑一个。' },
    { code: 'RULE_CONCURRENT_VERSION_CONFLICT', statement: '并发保存时后提交看到版本冲突与双方差异，必须在新版本上解决，不能覆盖历史。' }
  ];
}
