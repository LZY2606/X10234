import type { Database } from 'sql.js';
import { queryOne } from './db';
import { stableHash } from '../util/hash';
import { prefixFor } from './ids';

export interface ContentRecord {
  contentId: string;
  stableId: string;
  kind: string;
  version: number;
  body: unknown;
  summary: string;
}

/** 简短、人类可读的内容摘要（界面与实体信封共用）。 */
export function summarize(kind: string, body: any): string {
  switch (kind) {
    case 'rawFrame':
      return `frame#${body.index} ${body.width}x${body.height} bytes=${body.bytesContentHash.slice(0, 8)}`;
    case 'tiltAngle':
      return `${body.frameId} tilt raw="${body.angle.raw}" → ${body.angle.value === null ? '不可转换' : body.angle.value + body.angle.unit}`;
    case 'pixelScale':
      return `pixel ${body.pixelSize.raw}${body.pixelSize.unit} → ${body.pixelSize.value === null ? '不可转换' : body.pixelSize.value + 'nm'}`;
    case 'exposureDose':
      return `${body.frameId} dose raw="${body.dose.raw}" → ${body.dose.value === null ? '不可转换' : body.dose.value + body.dose.unit}`;
    case 'fiducialObservation':
      return `${body.trackId}@${body.frameId} (${body.x.raw},${body.y.raw})${body.frame ? ' [' + body.frame + ']' : ''}`;
    case 'trackingGap':
      return `gap ${body.trackId}@${body.frameId}: ${body.reason.raw}`;
    case 'manualExclusion':
      return `exclude ${body.target.type}${body.target.frameId ? '/' + body.target.frameId : ''}${body.target.trackId ? '/' + body.target.trackId : ''}: ${body.reason.raw} (${body.author})`;
    case 'alignmentParams':
      return `params v${body.revision}: tiltMode=${body.tiltCenterMode} minTiltPoints=${body.minTiltPoints} warpDOF=${body.warpDegreesOfFreedom} overfitCvRatio=${body.overfitCvRatioThreshold}`;
    case 'tiltAxis':
      return body.determined
        ? `axis dir=${body.directionDeg.toFixed(2)}° anchor=(${body.anchorX.toFixed(1)},${body.anchorY.toFixed(1)}) ecc=( ${body.eccentricityX.toFixed(1)},${body.eccentricityY.toFixed(1)})px`
        : `axis 未唯一决定 (${body.alternatives.length} 个合法候选)`;
    case 'trackIdentity':
      return `track identity: ${body.mapping.length} 重判, ${body.brokenTracks.length} 断裂轨迹`;
    case 'alignmentCandidate':
      return `candidate ${body.scheme} RMS=${body.totalResidualPx.toFixed(3)}px frames=${body.perFrameResidual.length} excluded=${body.excludedFrameIds.length} points=${body.effectivePointSet.length}`;
    case 'adjudication':
      return `${body.decision} ${body.candidateId}${body.supersedesAdjudicationId ? ' (撤销自 ' + body.supersedesAdjudicationId + ')' : ''}: ${body.reason}`;
    case 'registrationLock':
      return `lock ${body.reference} → ${body.candidateId}${body.released ? ' [已释放]' : ''}`;
    default:
      return `${kind}#${prefixFor(kind)}`;
  }
}

export function ensureBytes(db: Database, bytes: Uint8Array, now: string): string {
  const hash = 'sha:' + stableHash({ bin: Array.from(bytes) });
  const exists = queryOne<{ content_hash: string }>(db, 'SELECT content_hash FROM bytes WHERE content_hash=?', [hash]);
  if (!exists) {
    db.run('INSERT INTO bytes(content_hash,bytes,size,imported_at) VALUES (?,?,?,?)', [hash, bytes, bytes.length, now]);
  }
  return hash;
}

export function putContent(db: Database, rec: Omit<ContentRecord, 'contentId' | 'summary'> & { summary?: string }, introducedEvent: string): ContentRecord {
  const contentId = 'cid:' + stableHash({ stableId: rec.stableId, version: rec.version, body: rec.body, kind: rec.kind });
  const existing = queryOne<{ content_id: string }>(db, 'SELECT content_id FROM object_contents WHERE content_id=?', [contentId]);
  if (!existing) {
    const summary = rec.summary ?? summarize(rec.kind, rec.body);
    db.run(
      `INSERT INTO object_contents(content_id,stable_id,kind,version,json,summary,introduced_event,superseded_content_id)
       VALUES (?,?,?,?,?,?,?,NULL)`,
      [contentId, rec.stableId, rec.kind, rec.version, JSON.stringify(rec.body), summary, introducedEvent]
    );
  }
  return {
    contentId,
    stableId: rec.stableId,
    kind: rec.kind,
    version: rec.version,
    body: rec.body,
    summary: rec.summary ?? summarize(rec.kind, rec.body)
  };
}

export function getContent(db: Database, contentId: string): ContentRecord | null {
  const row = queryOne<{ stable_id: string; kind: string; version: number; json: string; summary: string }>(
    db,
    'SELECT stable_id,kind,version,json,summary FROM object_contents WHERE content_id=?',
    [contentId]
  );
  if (!row) return null;
  return {
    contentId,
    stableId: row.stable_id,
    kind: row.kind,
    version: row.version,
    body: JSON.parse(row.json),
    summary: row.summary
  };
}

export function nextVersion(db: Database, stableId: string): number {
  const row = queryOne<{ v: number }>(
    db,
    'SELECT COALESCE(MAX(version),0) AS v FROM object_contents WHERE stable_id=?',
    [stableId]
  );
  return (row?.v ?? 0) + 1;
}
