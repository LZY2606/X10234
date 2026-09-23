import { contentId } from './hash';
import {
  normalizeAngle,
  normalizeDose,
  pixelScaleToNmPerPixel
} from './units';
import type {
  Dose,
  EntityKind,
  FiducialMarker,
  ManualExclusion,
  PixelScale,
  RawFrame,
  TiltAngle,
  TrackGap,
  VersionRef
} from './types';

/**
 * 导入器：把案例包/外部材料变成来源实体。
 * 导入时只保留原始表示 + 派生诊断，绝不做不可逆清洗。
 * 无法转换的值留在原位置（conversion 诊断标记），不为画图丢弃。
 */

export interface CaseBlob {
  name: string;
  path: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  bytes?: Buffer;
}

export interface CaseFrameJson {
  frameId: string;
  sequenceIndex: number;
  tiltDeg: number;
  width: number;
  height: number;
  present: boolean;
  blob: {
    path: string;
    sha256: string;
    byteLength: number;
    contentType: string;
  } | null;
  missingReason: string | null;
  badFrame: boolean;
  acquisitionNote: string;
}

export interface CaseMaterials {
  caseId: string;
  title: string;
  domain: string;
  image: { width: number; height: number };
  axisHint: { angleDeg: number; knownOffsetPx: number };
  pixelScale: {
    scope: 'series' | { frameId: string };
    scale: PixelScale['scale'];
  };
  frames: CaseFrameJson[];
  tiltAngles: Array<{ frameId: string; sequenceIndex: number; angle: TiltAngle['angle'] }>;
  doses: Array<{ frameId: string; sequenceIndex: number; exposure: Dose['exposure'] }>;
  markers: Array<{
    markerId: string;
    frameId: string;
    sequenceIndex: number;
    trackId: string;
    rawLabel: string;
    coordinate: FiducialMarker['coordinate'];
  }>;
  trackGaps: Array<{
    trackId: string;
    fromSequenceIndex: number;
    toSequenceIndex: number;
    reason: string;
    provenance: string;
  }>;
  manualExclusions: Array<{
    frameId: string;
    sequenceIndex: number;
    reason: string;
    provenance: string;
  }>;
  identitySwapQuestion: {
    questionId: string;
    trackIdA: string;
    trackIdB: string;
    fromSequenceIndex: number;
    toSequenceIndex: number;
    evidence: string;
  };
  missingHighTilts: { sequenceIndices: number[]; reason: string };
}

export interface SourceEntityEnvelope {
  entityId: string;
  kind: EntityKind;
  version: number;
  contentId: string;
  body:
    | RawFrame
    | TiltAngle
    | PixelScale
    | Dose
    | FiducialMarker
    | TrackGap
    | ManualExclusion;
  refs: VersionRef[];
  /** 需入库的 blob（按内容去重）。 */
  blob?: { contentId: string; bytes: Buffer; contentType: string };
  conversionDiagnostics: string[];
}

export interface ImportPlan {
  envelopes: SourceEntityEnvelope[];
  sourceContentIds: string[];
  diagnostics: string[];
}

export function buildImportPlan(materials: CaseMaterials, blobBytesById?: Map<string, Buffer>): ImportPlan {
  const envelopes: SourceEntityEnvelope[] = [];
  const diagnostics: string[] = [];
  const sourceContentIds: string[] = [];

  const push = (
    entityId: string,
    kind: EntityKind,
    body: SourceEntityEnvelope['body'],
    blob?: SourceEntityEnvelope['blob']
  ) => {
    const cid = contentId(kind, body);
    envelopes.push({
      entityId,
      kind,
      version: 1,
      contentId: cid,
      body,
      refs: [],
      blob,
      conversionDiagnostics: []
    });
    sourceContentIds.push(cid);
    return cid;
  };

  for (const frame of materials.frames) {
    const frameId = frame.frameId;
    if (frame.present && frame.blob) {
      const blobContentId = `blob_${frame.blob.sha256.slice(0, 32)}`;
      const body: RawFrame = {
        kind: 'raw_frame',
        layer: 'source',
        frameId,
        sequenceIndex: frame.sequenceIndex,
        width: frame.width,
        height: frame.height,
        blobContentId,
        blobByteLength: frame.blob.byteLength,
        pixelFormat: 'pgm/P5',
        acquisitionNote: frame.acquisitionNote,
        provenance: frame.blob.path
      };
      const bytes = blobBytesById?.get(frame.blob.path);
      push(`raw_${frameId}`, 'raw_frame', body, bytes
        ? { contentId: blobContentId, bytes, contentType: frame.blob.contentType }
        : undefined);
    }
  }

  for (const tilt of materials.tiltAngles) {
    const body: TiltAngle = {
      kind: 'tilt_angle',
      layer: 'source',
      frameId: tilt.frameId,
      angle: tilt.angle,
      sequenceIndex: tilt.sequenceIndex,
      provenance: tilt.angle.rawRepresentation
        ? `tilt:${tilt.frameId}`
        : ''
    };
    const cid = push(`tilt_${tilt.frameId}`, 'tilt_angle', body);
    const converted = normalizeAngle(tilt.angle);
    if (converted.diagnostic.code !== 'OK') {
      diagnostics.push(converted.diagnostic.message);
      const envelope = envelopes.find((entry) => entry.contentId === cid)!;
      envelope.conversionDiagnostics.push(converted.diagnostic.message);
    }
  }

  const pixelBody: PixelScale = {
    kind: 'pixel_scale',
    layer: 'source',
    scope: materials.pixelScale.scope,
    scale: materials.pixelScale.scale,
    sequenceIndex: 0,
    provenance: materials.pixelScale.scale.provenance
  };
  const pixelCid = push('pixel_scale_series', 'pixel_scale', pixelBody);
  const pixelConversion = pixelScaleToNmPerPixel(materials.pixelScale.scale);
  if (pixelConversion.diagnostic.code !== 'OK') {
    diagnostics.push(pixelConversion.diagnostic.message);
    envelopes.find((entry) => entry.contentId === pixelCid)!.conversionDiagnostics.push(
      pixelConversion.diagnostic.message
    );
  }

  for (const dose of materials.doses) {
    const body: Dose = {
      kind: 'dose',
      layer: 'source',
      frameId: dose.frameId,
      exposure: dose.exposure,
      sequenceIndex: dose.sequenceIndex,
      provenance: dose.exposure.provenance
    };
    const cid = push(`dose_${dose.frameId}`, 'dose', body);
    const converted = normalizeDose(dose.exposure);
    if (converted.diagnostic.code !== 'OK') {
      diagnostics.push(converted.diagnostic.message);
      envelopes.find((entry) => entry.contentId === cid)!.conversionDiagnostics.push(
        converted.diagnostic.message
      );
    }
  }

  for (const marker of materials.markers) {
    const body: FiducialMarker = {
      kind: 'fiducial_marker',
      layer: 'source',
      frameId: marker.frameId,
      sequenceIndex: marker.sequenceIndex,
      rawLabel: marker.rawLabel,
      coordinate: marker.coordinate,
      provenance: marker.coordinate.provenance
    };
    push(
      `marker_${marker.frameId}_${marker.trackId}`,
      'fiducial_marker',
      body
    );
  }

  for (const gap of materials.trackGaps) {
    const body: TrackGap = {
      kind: 'track_gap',
      layer: 'source',
      trackId: gap.trackId,
      fromSequenceIndex: gap.fromSequenceIndex,
      toSequenceIndex: gap.toSequenceIndex,
      reason: gap.reason,
      provenance: gap.provenance
    };
    push(`gap_${gap.trackId}`, 'track_gap', body);
  }

  for (const exclusion of materials.manualExclusions) {
    const body: ManualExclusion = {
      kind: 'manual_exclusion',
      layer: 'source',
      frameId: exclusion.frameId,
      reason: exclusion.reason,
      sequenceIndex: exclusion.sequenceIndex,
      provenance: exclusion.provenance
    };
    push(`exclusion_${exclusion.frameId}`, 'manual_exclusion', body);
  }

  return { envelopes, sourceContentIds, diagnostics };
}
