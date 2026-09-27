/**
 * 稳定身份：所有实体、事件、不可变片段都带确定性 ID。
 * 导出 → 删除本地库 → 再导入后，身份、顺序与来源关系保持不变。
 */

export type EntityKind =
  | 'importBatch'
  | 'rawFrame'
  | 'tiltAngleRecord'
  | 'pixelScaleRecord'
  | 'exposureDoseRecord'
  | 'fiducialTrackSegment'
  | 'markerObservation'
  | 'trackGapRecord'
  | 'identitySwapSuspect'
  | 'manualExclusion'
  | 'interpretationBranch'
  | 'tiltAxisModel'
  | 'fiducialTrajectoryModel'
  | 'registrationCandidate'
  | 'adjudication'
  | 'reconstructionLock'
  | 'reviewView'
  | 'scenarioArchive'
  | 'ruleVersion'
  | 'domainJudgment';

export type StableId = string;

export function sid(kind: EntityKind, ...parts: (string | number)[]): StableId {
  const tail = parts
    .map((p) => String(p))
    .join('|')
    .replace(/[^A-Za-z0-9_.:|-]+/g, '_');
  return `${kind}:${tail}`;
}

const encoder = new TextEncoder();

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return fnv1a(bytes);
}

export async function canonicalHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(cloneSorted(value));
}

function cloneSorted(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneSorted);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = cloneSorted((value as Record<string, unknown>)[key]);
  }
  return out;
}

function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv-${h.toString(16).padStart(8, '0')}`;
}
