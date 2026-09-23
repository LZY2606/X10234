import type {
  DoseV1, FiducialMarkerV1, FrameKind, ManualExclusionV1, MarkerObservationV1,
  PixelScaleV1, RawFrameV1, TiltAngleV1, TrackingGapV1
} from '../core/types.ts';
import { quantity } from '../core/normalize.ts';
import { blobDigest } from '../core/identity.ts';

export const CASE_PACK_ID = 'tc_pack_tilt_series_001';
export const SERIES_ID = 'ts_ferritin_synthetic_001';

export interface GeneratedSeries {
  frames: RawFrameV1[];
  tilts: TiltAngleV1[];
  scales: PixelScaleV1[];
  doses: DoseV1[];
  markers: FiducialMarkerV1[];
  observations: MarkerObservationV1[];
  gaps: TrackingGapV1[];
  exclusions: ManualExclusionV1[];
  truth: GroundTruth;
}

export interface GroundTruth {
  widthPx: number;
  heightPx: number;
  tiltAxisPhiRad: number;
  axisCenterOffsetXPx: number; // 轴线相对图像中心的偏心真值
  marker3D: Record<string, { p: number; r: number; q: number }>;
  frameDrift: Record<string, { tx: number; ty: number }>;
  badFrames: string[];
  swappedMarkerPair: [string, string] | null;
}

export interface GenOptions {
  frameCount?: number;
  tiltMaxDeg?: number;
  axisOffsetPx?: number;
  noiseSigmaPx?: number;
  badFrameShifts?: Record<number, { tx: number; ty: number }>;
  occlusion?: { markerId: string; from: number; to: number }[];
  swap?: [string, string, number] | null; // 两个标记 + 交换起始帧序
  missingFrames?: number[]; // 这些帧整帧缺失（高倾角缺失）
  badDoseAt?: number; // 某帧剂量原文不可解析
  frameKindAt?: Record<number, FrameKind>;
  seed?: number;
}

/** 可复现的确定性伪随机 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function frameId(seq: number): string {
  return `frm_${String(seq).padStart(4, '0')}`;
}

const MARKERS = ['fmk_a', 'fmk_b', 'fmk_c', 'fmk_d', 'fmk_e', 'fmk_f'];

export function generateSeries(options: GenOptions = {}): GeneratedSeries {
  const {
    frameCount = 19,
    tiltMaxDeg = 60,
    axisOffsetPx = 26,
    noiseSigmaPx = 0.35,
    badFrameShifts = {},
    occlusion = [],
    swap = null,
    missingFrames = [],
    badDoseAt = -1,
    frameKindAt = {},
    seed = 20260924
  } = options;

  const rng = makeRng(seed);
  const widthPx = 512;
  const heightPx = 512;
  const frames: RawFrameV1[] = [];
  const tilts: TiltAngleV1[] = [];
  const scales: PixelScaleV1[] = [];
  const doses: DoseV1[] = [];
  const markers: FiducialMarkerV1[] = [];
  const observations: MarkerObservationV1[] = [];
  const gaps: TrackingGapV1[] = [];
  const exclusions: ManualExclusionV1[] = [];

  const marker3D: GroundTruth['marker3D'] = {};
  for (const markerId of MARKERS) {
    marker3D[markerId] = {
      p: (rng() - 0.5) * 260,
      r: (rng() - 0.5) * 160,
      q: (rng() - 0.5) * 260
    };
    markers.push({ markerId, note: 'synthetic colloidal gold fiducial' });
  }
  // 序列统一像素尺度 0.84 nm/pixel
  scales.push({ scale: quantity(0.84, 'nm') });

  const frameDrift: GroundTruth['frameDrift'] = {};
  const anglesRad: Record<string, number> = {};
  let driftX = 0;
  let driftY = 0;

  for (let k = 0; k < frameCount; k++) {
    const seq = k + 1;
    if (missingFrames.includes(seq)) continue;
    const id = frameId(seq);
    const angleDeg = tiltMaxDeg * (2 * k / (frameCount - 1) - 1);
    const angleRad = angleDeg * Math.PI / 180;
    anglesRad[id] = angleRad;
    driftX += (rng() - 0.5) * 1.6;
    driftY += (rng() - 0.5) * 1.2;
    const bad = badFrameShifts[seq];
    frameDrift[id] = {
      tx: driftX + (bad?.tx ?? 0),
      ty: driftY + (bad?.ty ?? 0)
    };

    const signature = Array.from({ length: 16 }, (_, i) =>
      Math.round(127 + 100 * Math.sin(seq * 1.7 + i * 0.9) + (rng() - 0.5) * 18));
    const pngish = `RAW-TIFF/${SERIES_ID}/${id}/${signature.join(',')}`;
    const digest = blobDigest(pngish);
    frames.push({
      frameId: id,
      sequence: seq,
      kind: frameKindAt[seq] ?? 'micrograph',
      widthPx, heightPx,
      intensitySignature: signature,
      rawFileName: `${SERIES_ID}_${String(seq).padStart(3, '0')}.mrc.tif`,
      contentRef: { sha256: digest, bytes: pngish.length }
    });
    tilts.push({ frameId: id, angle: quantity(Number(angleDeg.toFixed(3)), 'degree') });
    const doseRaw = seq === badDoseAt ? 'n/a (dosimeter dropout)' : Number((1.8 + rng() * 0.25).toFixed(3));
    const doseUnit = seq % 3 === 0 ? 'e_per_angstrom2' : 'electron_per_nm2';
    doses.push({ frameId: id, dose: quantity(doseRaw, doseUnit as never) });
  }

  for (const frame of frames) {
    const angleRad = anglesRad[frame.frameId] as number;
    const drift = frameDrift[frame.frameId] as { tx: number; ty: number };
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    for (const markerId of MARKERS) {
      // 跟踪遮挡 → 缺口，不补点
      const occ = occlusion.find((o) => o.markerId === markerId
        && frame.sequence >= o.from && frame.sequence <= o.to);
      if (occ) continue;
      // 身份交换：交换起始帧之后两标记观测对调（但标记身份声明仍沿用旧轨迹，制造需要裁定的错配）
      let physicalMarker = markerId;
      if (swap && frame.sequence >= swap[2]) {
        if (markerId === swap[0]) physicalMarker = swap[1];
        else if (markerId === swap[1]) physicalMarker = swap[0];
      }
      const m = marker3D[physicalMarker] as { p: number; r: number; q: number };
      const xTrue = m.p * cosA + m.r * sinA + drift.tx
        + axisOffsetPx * (1 - cosA) + widthPx / 2;
      const yTrue = m.q + drift.ty + heightPx / 2;
      const x = Number((xTrue + (rng() - 0.5) * 2 * noiseSigmaPx).toFixed(3));
      const y = Number((yTrue + (rng() - 0.5) * 2 * noiseSigmaPx).toFixed(3));
      observations.push({
        observationId: `obs_${markerId}_${frame.frameId}`,
        markerId, frameId: frame.frameId,
        x: quantity(x, 'pixel'),
        y: quantity(y, 'pixel'),
        basis: 'image_top_left_px'
      });
    }
  }

  // 显式跟踪缺口
  for (const o of occlusion) {
    gaps.push({
      gapId: `gap_${o.markerId}_${String(o.from).padStart(4, '0')}_${String(o.to).padStart(4, '0')}`,
      markerId: o.markerId,
      fromFrameId: frameId(Math.max(1, o.from - 1)),
      toFrameId: frameId(Math.min(frameCount, o.to + 1)),
      reason: quantity('occluded', 'dimensionless')
    });
  }

  // 手工排除原因（坏帧），版本化保留
  for (const seqStr of Object.keys(badFrameShifts)) {
    const seq = Number(seqStr);
    exclusions.push({
      exclusionId: `exc_${frameId(seq)}`,
      targetFrameId: frameId(seq),
      reasonCode: 'excessive_motion',
      reasonText: `frame ${seq}: stage jump during acquisition, cross-correlation peak splits`,
      author: 'microscopy_team'
    });
  }

  const truth: GroundTruth = {
    widthPx, heightPx,
    tiltAxisPhiRad: 0,
    axisCenterOffsetXPx: axisOffsetPx,
    marker3D,
    frameDrift,
    badFrames: Object.keys(badFrameShifts).map((s) => frameId(Number(s))),
    swappedMarkerPair: swap ? [swap[0], swap[1]] : null
  };

  return { frames, tilts, scales, doses, markers, observations, gaps, exclusions, truth };
}
