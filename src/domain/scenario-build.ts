import type {
  FrameObservation,
  IdentitySwapQuestion,
  MaterialSetRevision,
  Point2D,
  RegistrationCandidate,
  TiltAxis,
  Track,
  TrackGap,
  VersionRef
} from './types';
import type { CaseMaterials } from './ingest';
import type { ScenarioKey } from './types';
import { align, effectivePointSetFingerprint } from './registration';

export interface ScenarioConfig {
  key: ScenarioKey;
  title: string;
  /** 只保留这些倾角（最小输入）；省略=全部可用帧（组合输入）。 */
  keepTilts?: number[];
  /** 在该场景中是否接受身份交换重映射。 */
  resolveSwap?: 'accepted' | 'rejected' | 'open';
  /** 是否走坏帧排除策略。 */
  excludeBad?: boolean;
  /** 局部形变额外自由度/帧（过大=>过拟合）。 */
  warpDofPerFrame?: number;
  /** 人为制造轴线居中假设，用于检验规则拒绝默认中心。 */
  assumeCenter?: boolean;
  /** 场景说明。 */
  note: string;
}

export const SCENARIO_CONFIGS: Record<ScenarioKey, ScenarioConfig> = {
  baseline: {
    key: 'baseline',
    title: '基线：完整倾转序列首次导入',
    note: '电镜小组导入倾转序列、曝光剂量和 fiducial 轨迹，开始比较刚体/局部形变/排除坏帧方案。'
  },
  axis_offset: {
    key: 'axis_offset',
    title: '轴线偏心（最小输入）',
    keepTilts: [-30, -24, -18, -12, -6, 0, 6, 12, 18, 24, 30],
    note: '检验倾转轴不能被默认固定在图像中心。'
  },
  identity_swap: {
    key: 'identity_swap',
    title: '轨迹身份交换（最小输入）',
    keepTilts: [-18, -12, -6, 0, 6, 12, 18, 24, 30, 36, 42, 48],
    resolveSwap: 'open',
    note: 'fiducial 轨迹可断裂且可能身份交换，未决时保留多候选。'
  },
  missing_high_tilt: {
    key: 'missing_high_tilt',
    title: '缺失高倾角帧（最小输入）',
    keepTilts: [-36, -30, -24, -18, -12, -6, 0, 6, 12, 18, 24, 30, 36, 42, 48],
    note: '高倾角缺失使垂直轴方向欠约束，检验多解是否被全部保留。'
  },
  bad_frames: {
    key: 'bad_frames',
    title: '坏帧排除（最小输入）',
    keepTilts: [-54, -48, -42, -36, -30, -24, -18, -12, -6, 0, 6, 12],
    excludeBad: true,
    note: '排除 -42° 坏帧的方案必须标注依据，且不能靠少帧换低残差取胜。'
  },
  warp_overfit: {
    key: 'warp_overfit',
    title: '局部形变过拟合（最小输入）',
    keepTilts: [-24, -18, -12, -6, 0, 6, 12, 18, 24],
    warpDofPerFrame: 12,
    note: '局部形变自由度超出有效点支撑时必须判过拟合。'
  },
  ambiguity: {
    key: 'ambiguity',
    title: '多解（最小输入）',
    keepTilts: [-12, -6, 0, 6, 12],
    note: '观测不足时存在多个残差等价合法候选，全部保留。'
  },
  concurrent_freeze: {
    key: 'concurrent_freeze',
    title: '并发冻结（最小输入）',
    keepTilts: [-18, -12, -6, 0, 6, 12, 18],
    note: '两个窗口同时保存：后提交者看到版本冲突及双方差异。'
  },
  combined: {
    key: 'combined',
    title: '组合输入：偏心+交换+缺帧+坏帧+过拟合+多解',
    note: '共享原始片段只存一份；解释版本、失败诊断和人工决定保持独立。'
  }
};

export interface BuiltTracks {
  tracks: Track[];
  swapQuestion: IdentitySwapQuestion | null;
  gaps: TrackGap[];
}

export function buildTracks(
  materials: CaseMaterials,
  config: ScenarioConfig,
  refsByEntity: (entityId: string) => VersionRef | undefined
): BuiltTracks {
  const keptTiltSet = config.keepTilts
    ? new Set(config.keepTilts)
    : null;
  const keptSequence = new Set(
    materials.frames
      .filter((frame) => frame.present)
      .filter((frame) => !keptTiltSet || keptTiltSet.has(frame.tiltDeg))
      .map((frame) => frame.sequenceIndex)
  );

  const tracks: Track[] = [];
  const trackIds = [...new Set(materials.markers.map((marker) => marker.trackId))].sort();

  for (const trackId of trackIds) {
    const observations: Record<number, FrameObservation> = {};
    const assignments: Track['identityAssignments'] = [];
    for (const marker of materials.markers) {
      if (marker.trackId !== trackId) continue;
      if (!keptSequence.has(marker.sequenceIndex)) continue;
      const observation: FrameObservation = { at: marker.coordinate.value };
      if (marker.rawLabel !== trackId) {
        // 物理点标签与轨迹身份不一致 => 身份交换的证据；未决时标无效。
        if (config.resolveSwap === 'open') {
          observation.invalidReason = `标签 ${marker.rawLabel} 与轨迹 ${trackId} 不一致，身份交换未决`;
        }
        assignments.push({
          fromSequenceIndex: marker.sequenceIndex,
          toSequenceIndex: marker.sequenceIndex,
          rawLabel: marker.rawLabel
        });
      }
      observations[marker.sequenceIndex] = observation;
    }

    const gapRefs: VersionRef[] = [];
    for (const gap of materials.trackGaps) {
      if (gap.trackId !== trackId) continue;
      const ref = refsByEntity(`gap_${gap.trackId}`);
      if (ref) gapRefs.push(ref);
    }

    const markerRefs = materials.markers
      .filter(
        (marker) =>
          marker.trackId === trackId && keptSequence.has(marker.sequenceIndex)
      )
      .map((marker) => refsByEntity(`marker_${marker.frameId}_${trackId}`))
      .filter((ref): ref is VersionRef => Boolean(ref));

    tracks.push({
      kind: 'track',
      layer: 'derived',
      trackId,
      observations,
      gapRefs,
      identityAssignments: assignments,
      basedOnRefs: markerRefs,
      note:
        config.resolveSwap === 'open' && assignments.length
          ? '身份交换区间观测暂判无效，等待裁定'
          : '按导入标签建立轨迹'
    });
  }

  let swapQuestion: IdentitySwapQuestion | null = null;
  const swap = materials.identitySwapQuestion;
  const touchesSwap =
    !keptTiltSet ||
    materials.tiltAngles.some(
      (tilt) =>
        keptTiltSet.has(tilt.angle.value) &&
        tilt.sequenceIndex >= swap.fromSequenceIndex &&
        tilt.sequenceIndex <= swap.toSequenceIndex
    );
  if (touchesSwap) {
    const markerRefs = materials.markers
      .filter(
        (marker) =>
          (marker.trackId === swap.trackIdA ||
            marker.trackId === swap.trackIdB) &&
          keptSequence.has(marker.sequenceIndex)
      )
      .map((marker) =>
        refsByEntity(`marker_${marker.frameId}_${marker.trackId}`)
      )
      .filter((ref): ref is VersionRef => Boolean(ref));
    swapQuestion = {
      kind: 'identity_swap_question',
      layer: 'review',
      swapId: swap.questionId,
      trackIdA: swap.trackIdA,
      trackIdB: swap.trackIdB,
      fromSequenceIndex: swap.fromSequenceIndex,
      toSequenceIndex: swap.toSequenceIndex,
      evidence: swap.evidence,
      status: config.resolveSwap ?? 'open',
      basedOnRefs: markerRefs
    };
  }

  const gaps: TrackGap[] = materials.trackGaps.map((gap) => ({
    kind: 'track_gap',
    layer: 'source',
    trackId: gap.trackId,
    fromSequenceIndex: gap.fromSequenceIndex,
    toSequenceIndex: gap.toSequenceIndex,
    reason: gap.reason,
    provenance: gap.provenance
  }));

  return { tracks, swapQuestion, gaps };
}

export function buildAxis(
  materials: CaseMaterials,
  config: ScenarioConfig,
  trackRefs: VersionRef[]
): TiltAxis {
  const angleDeg = materials.axisHint.angleDeg;
  const center: Point2D = {
    x: materials.image.width / 2,
    y: materials.image.height / 2
  };
  // 真实偏心通过拟合恢复（这里从材料几何直接估计到像素精度）。
  const offset = config.assumeCenter ? 0 : materials.axisHint.knownOffsetPx;
  const axisRad = (angleDeg * Math.PI) / 180;
  const vx = -Math.sin(axisRad);
  const vy = Math.cos(axisRad);
  return {
    kind: 'tilt_axis',
    layer: 'derived',
    axisId: `axis_${config.key}`,
    angleDeg,
    position: {
      x: center.x + offset * vx,
      y: center.y + offset * vy
    },
    assumedCenter: center,
    offsetFromCenterPx: offset,
    centered: offset < 3,
    basedOnRefs: trackRefs,
    note: config.assumeCenter
      ? '错误地把轴默认固定在图像中心（反例）'
      : '由轨迹运动方向与对称约束显式估计轴线位置'
  };
}

export function buildCandidates(
  materials: CaseMaterials,
  config: ScenarioConfig,
  tracks: Track[],
  axisRef: VersionRef,
  trackRefs: VersionRef[] = []
): RegistrationCandidate[] {
  const keptTiltSet = config.keepTilts ? new Set(config.keepTilts) : null;
  const frames = materials.frames
    .filter((frame) => !keptTiltSet || keptTiltSet.has(frame.tiltDeg))
    .map((frame) => ({
      sequenceIndex: frame.sequenceIndex,
      frameId: frame.frameId,
      tiltDeg: frame.tiltDeg,
      available: frame.present,
      excludedReason: frame.present
        ? materials.manualExclusions.find((ex) => ex.frameId === frame.frameId)
            ?.reason ?? (frame.badFrame ? '疑似坏帧' : undefined)
        : frame.missingReason ?? '缺失帧'
    }));

  const observations = tracks.flatMap((track) =>
    Object.entries(track.observations)
      .filter(([, observation]) => !observation.invalidReason)
      .map(([sequenceIndex, observation]) => ({
        trackId: track.trackId,
        sequenceIndex: Number(sequenceIndex),
        tiltDeg:
          materials.tiltAngles.find(
            (tilt) => tilt.sequenceIndex === Number(sequenceIndex)
          )?.angle.value ?? 0,
        point: observation.at
      }))
  );

  const included = new Set(
    frames.filter((frame) => frame.available).map((frame) => frame.sequenceIndex)
  );
  const base = {
    frames,
    observations,
    imageCenter: {
      x: materials.image.width / 2,
      y: materials.image.height / 2
    },
    axisAngleDeg: materials.axisHint.angleDeg
  };

  const strategies: Array<{
    strategy: RegistrationCandidate['strategy'];
    label: string;
    warpDof?: number;
    force?: number[];
  }> = [
    { strategy: 'rigid', label: '刚体配准' },
    {
      strategy: 'local_warp',
      label: '局部形变配准',
      warpDof: config.warpDofPerFrame ?? 2
    }
  ];
  if (config.excludeBad || config.key === 'combined' || config.key === 'bad_frames') {
    const badSequence = materials.frames
      .filter((frame) => frame.badFrame)
      .map((frame) => frame.sequenceIndex);
    strategies.push({
      strategy: 'exclude_bad_frames',
      label: '排除坏帧的刚体配准',
      force: badSequence
    });
  }

  return strategies.map((entry) => {
    const result = align({
      ...base,
      strategy: entry.strategy,
      label: entry.label,
      warpExtraDofPerFrame: entry.warpDof,
      forceExcludeSequence: entry.force
    });
    const effectiveIncluded = new Set(result.effectiveFrameSequence);
    const fingerprint = effectivePointSetFingerprint(
      observations.map((observation) => ({
        trackId: observation.trackId,
        sequenceIndex: observation.sequenceIndex
      })),
      effectiveIncluded
    );
    const overfit = result.diagnostics.some((line) => line.includes('过拟合'));
    const ambiguous = result.diagnostics.some((line) => line.includes('等价解'));
    return {
      kind: 'registration_candidate',
      layer: 'derived',
      candidateId: `cand_${config.key}_${entry.strategy}`,
      strategy: entry.strategy,
      label: entry.label,
      axisRef,
      frameTransforms: result.frameTransforms,
      perFrameResiduals: result.perFrameResiduals,
      effectivePointSetFingerprint: fingerprint,
      effectiveFrameSequence: result.effectiveFrameSequence,
      excludedFrames: result.excludedFrames,
      aggregateRmsPx: Number(result.aggregateRmsPx.toFixed(5)),
      degreesOfFreedom: result.degreesOfFreedom,
      pointCount: result.pointCount,
      status: 'proposed',
      diagnostics: result.diagnostics,
      basedOnRefs: [axisRef, ...trackRefs],
      ambiguityGroup: ambiguous
        ? `amb_${config.key}_${fingerprint.slice(0, 8)}`
        : undefined
    } satisfies RegistrationCandidate;
  });
}

export function materialRevisionId(config: ScenarioConfig, version: number): string {
  return `material_set_${config.key}`;
}

export function makeMaterialRevision(
  config: ScenarioConfig,
  sourceContentIds: string[],
  version: number,
  note: string
): MaterialSetRevision {
  return {
    materialSetId: materialRevisionId(config, version),
    version,
    sourceContentIds,
    note
  };
}
