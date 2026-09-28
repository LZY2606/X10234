import { createHash } from 'node:crypto';

/**
 * 稳定身份：prefix + 确定性内容/序号派生。
 * 关键：身份由“材料的领域身份”决定，而不是数据库行号——
 * 导出、删除本地库再导入后 stableId 保持不变。
 */
let counter = 0;

export function resetIdCounter(): void {
  counter = 0;
}

export function makeStableId(prefix: string, deterministicSeed?: string): string {
  if (deterministicSeed !== undefined) {
    const h = createHash('sha256').update(deterministicSeed).digest('hex').slice(0, 16);
    return `${prefix}_${h}`;
  }
  counter += 1;
  return `${prefix}_new${counter.toString(36)}${Date.now().toString(36)}`;
}

export function sha256OfBytes(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256OfJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** 确定性 JSON：键排序，无多余空白，保证同内容同哈希（跨导入/导出） */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 内容摘要：实体关键字段的确定性子集，随查询返回 */
export function summarizeEntity(entity: {
  kind: string;
  stableId: string;
  version: number;
  [k: string]: unknown;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: entity.kind,
    stableId: entity.stableId,
    version: entity.version,
  };
  switch (entity.kind) {
    case 'TiltFrame':
      Object.assign(base, {
        acquisitionIndex: entity.acquisitionIndex,
        blobSha256: (entity as { blob: { sha256: string } }).blob.sha256,
        dims: entity.dims,
      });
      break;
    case 'TiltAngle':
      Object.assign(base, {
        acquisitionIndex: entity.acquisitionIndex,
        rawValue: (entity as { angle: { rawValue: number } }).angle.rawValue,
        rawUnit: (entity as { angle: { rawUnit: string } }).angle.rawUnit,
      });
      break;
    case 'ExposureDose':
      Object.assign(base, {
        acquisitionIndex: entity.acquisitionIndex,
        cumulativeRaw: (entity as { cumulative: { rawValue: number } }).cumulative.rawValue,
        perFrameRaw: (entity as { perFrame: { rawValue: number } }).perFrame.rawValue,
      });
      break;
    case 'PixelScale':
      Object.assign(base, {
        frameId: entity.frameId,
        rawValue: (entity as { scale: { rawValue: number } }).scale.rawValue,
        rawUnit: (entity as { scale: { rawUnit: string } }).scale.rawUnit,
      });
      break;
    case 'FiducialTrack':
      Object.assign(base, {
        physicalBeadId: entity.physicalBeadId,
        segmentCount: (entity as { segments: unknown[] }).segments.length,
        identityStatuses: (
          entity as { identityLinks: { status: string }[] }
        ).identityLinks.map((l) => l.status),
      });
      break;
    case 'TrackingGap':
      Object.assign(base, {
        acquisitionIndex: entity.acquisitionIndex,
        missing: (entity as { missingMarkerLabels: number[] }).missingMarkerLabels,
      });
      break;
    case 'ManualExclusion':
      Object.assign(base, {
        reasonCode: entity.reasonCode,
        decidedBy: entity.decidedBy,
        undone: (entity as { undoneByEventId: string | null }).undoneByEventId !== null,
      });
      break;
    case 'TiltSeries':
      Object.assign(base, {
        frameCount: (entity as { frameIds: string[] }).frameIds.length,
      });
      break;
    case 'TiltAxisModel':
      Object.assign(base, {
        pivot: entity.pivot,
        assumedCenter: entity.assumedCenter,
      });
      break;
    case 'RegistrationCandidate': {
      const c = entity as unknown as {
        transformKind: string;
        aggregateRmsPx: number;
        status: string;
        effectivePointSet: { frameIndices: number[]; observationCount: number };
      };
      Object.assign(base, {
        transformKind: c.transformKind,
        aggregateRmsPx: Number(c.aggregateRmsPx.toFixed(4)),
        status: c.status,
        frameCount: c.effectivePointSet.frameIndices.length,
        observationCount: c.effectivePointSet.observationCount,
      });
      break;
    }
    case 'AdjudicationDecision':
      Object.assign(base, {
        decision: entity.decision,
        candidateId: entity.candidateId,
      });
      break;
  }
  return base;
}
