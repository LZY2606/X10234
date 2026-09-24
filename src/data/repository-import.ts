import type { Database } from './db';
import { queryAll, queryOne } from './db';
import { sha256Hex, stableId, eventId, nowIso } from '../domain/ids';
import { parseAngle, parseDose, parsePixelScale, quantitySummary } from '../domain/units';
import type { DomainEvent, RationaleCode } from '../domain/events';
import type { TiltPack, PackVariant } from './pack';
import type { Quantity } from '../domain/types';

export interface ImportedMaterial {
  tiltSeriesId: string;
  name: string;
  signConvention: string;
  widthPx: number;
  heightPx: number;
  sourceVersion: number;
  pixelScale: Quantity;
  frames: Array<{
    frameSeq: number; blobSha: string; byteLength: number;
    dose: Quantity; angle: Quantity;
  }>;
  observations: Array<{ markerId: string; frameSeq: number; xPx: number | null; yPx: number | null; observed: boolean }>;
  gaps: TiltPack['gaps'];
  exclusions: TiltPack['exclusions'];
  batchId: string;
}

function putBlob(db: Database, bytes: Uint8Array): { sha: string; inserted: boolean } {
  const sha = sha256Hex(bytes);
  const exists = queryOne(db, `SELECT 1 FROM blobs WHERE sha=$s`, { $s: sha });
  if (!exists) {
    db.run(`INSERT INTO blobs(sha,byte_length,media_type,bytes) VALUES($s,$l,$m,$b)`,
      { $s: sha, $l: bytes.length, $m: 'application/octet-stream', $b: bytes });
  }
  return { sha, inserted: !exists };
}

function nextSeq(db: Database): number {
  const row = queryOne<{ mx: number | null }>(db, `SELECT MAX(seq) AS mx FROM events`);
  return (row?.mx ?? 0) + 1;
}

export function appendEvent(db: Database, e: Omit<DomainEvent, 'eventId' | 'seq'> & { seq?: number }): DomainEvent {
  const seq = e.seq ?? nextSeq(db);
  const full: DomainEvent = { ...e, seq, eventId: eventId(seq) } as DomainEvent;
  db.run(
    `INSERT INTO events(seq,event_id,code,branch_id,at_iso,author,refs_json,rationale_json,payload_json,invalidation_json)
     VALUES($seq,$id,$code,$br,$at,$au,$refs,$rat,$pay,$inv)`,
    {
      $seq: seq, $id: full.eventId, $code: full.code, $br: full.branchId, $at: full.atIso, $au: full.author,
      $refs: JSON.stringify(full.refs), $rat: JSON.stringify(full.rationaleCodes),
      $pay: JSON.stringify(full.payload),
      $inv: full.invalidation ? JSON.stringify(full.invalidation) : null
    }
  );
  return full;
}

function latestSourceVersion(db: Database, tiltSeriesId: string): number {
  const row = queryOne<{ v: number | null }>(
    db, `SELECT MAX(source_version) AS v FROM frames WHERE tilt_series_id=$id`, { $id: tiltSeriesId });
  return row?.v ?? 0;
}

interface ResolvedVariant {
  pixelScaleRaw: string;
  presentSeqs: Set<number>;
  frames: TiltPack['frames'];
  angles: TiltPack['angles'];
  obs: TiltPack['markerObservations'];
  gaps: TiltPack['gaps'];
  exclusions: TiltPack['exclusions'];
}

function resolveVariant(pack: TiltPack, variant: PackVariant | null): ResolvedVariant {
  const frames = [...pack.frames];
  const angles = [...pack.angles];
  const obs = [...pack.markerObservations];
  const gaps = variant?.gaps ? [...variant.gaps] : [...pack.gaps];
  const exclusions = variant?.exclusions ? [...variant.exclusions] : [...pack.exclusions];
  if (variant) {
    for (const f of variant.frameOverrides ?? []) {
      const idx = frames.findIndex((x) => x.frameSeq === f.frameSeq);
      if (idx >= 0) frames[idx] = f; else frames.push(f);
    }
    for (const a of variant.angleOverrides ?? []) {
      const idx = angles.findIndex((x) => x.frameSeq === a.frameSeq);
      if (idx >= 0) angles[idx] = a; else angles.push(a);
    }
    for (const o of variant.markerOverrides ?? []) {
      const idx = obs.findIndex((x) => x.markerId === o.markerId && x.frameSeq === o.frameSeq);
      if (idx >= 0) obs[idx] = o; else obs.push(o);
    }
  }
  const presentSeqs = new Set(frames.map((f) => f.frameSeq));
  for (const missing of variant?.missingFrameSeqs ?? []) presentSeqs.delete(missing);
  return {
    pixelScaleRaw: variant?.pixelScaleRaw ?? pack.pixelScaleRaw,
    presentSeqs, frames: frames.filter((f) => presentSeqs.has(f.frameSeq)),
    angles: angles.filter((a) => presentSeqs.has(a.frameSeq)),
    obs: obs.filter((o) => presentSeqs.has(o.frameSeq)),
    gaps, exclusions
  };
}

/**
 * 事务化导入：任何失败都回滚，绝不留下半份记录。
 * 不做不可逆清洗——无法转换的值留在原位并附诊断。
 */
export function importTiltPack(
  db: Database,
  pack: TiltPack,
  opts: { variant?: PackVariant | null; author?: string } = {}
): ImportedMaterial {
  const variant = opts.variant ?? null;
  const variantKey = variant?.key ?? 'baseline';
  const isFirst = queryOne(db, `SELECT 1 FROM tilt_series WHERE tilt_series_id=$id`, { $id: pack.tiltSeriesId }) == null;
  db.run('SAVEPOINT import');
  const insertedBlobs: string[] = [];
  try {
    const r = resolveVariant(pack, variant);
    const sourceVersion = isFirst ? 1 : latestSourceVersion(db, pack.tiltSeriesId) + 1;
    const pixelScale = parsePixelScale(r.pixelScaleRaw);
    const batchId = stableId('batch', pack.tiltSeriesId, sourceVersion, variantKey);

    if (isFirst) {
      db.run(
        `INSERT INTO tilt_series(tilt_series_id,name,source_version,width_px,height_px,pixel_scale_json,sign_convention,created_at_iso)
         VALUES($id,$nm,$sv,$w,$h,$ps,$sc,$at)`,
        { $id: pack.tiltSeriesId, $nm: pack.name, $sv: sourceVersion, $w: pack.widthPx, $h: pack.heightPx,
          $ps: JSON.stringify(pixelScale), $sc: pack.signConvention, $at: nowIso() }
      );
    }

    for (const f of r.frames) {
      const { sha, inserted } = putBlob(db, f.bytes);
      if (inserted) insertedBlobs.push(sha);
      const dose = parseDose(f.doseRaw);
      const ang = r.angles.find((x) => x.frameSeq === f.frameSeq);
      const angle = parseAngle(ang?.raw ?? '0deg', pack.signConvention);
      db.run(
        `INSERT INTO frames(tilt_series_id,frame_seq,source_version,blob_sha,byte_length,dose_per_frame_json,angle_json)
         VALUES($id,$seq,$sv,$sha,$len,$dose,$ang)`,
        { $id: pack.tiltSeriesId, $seq: f.frameSeq, $sv: sourceVersion, $sha, $len: f.bytes.length,
          $dose: JSON.stringify(dose), $ang: JSON.stringify(angle) }
      );
    }
    for (const o of r.obs) {
      db.run(
        `INSERT INTO marker_observations(tilt_series_id,marker_id,frame_seq,source_version,x_px,y_px,observed)
         VALUES($id,$mk,$seq,$sv,$x,$y,$ob)`,
        { $id: pack.tiltSeriesId, $mk: o.markerId, $seq: o.frameSeq, $sv: sourceVersion,
          $x: o.observed ? (o.xPx ?? null) : null, $y: o.observed ? (o.yPx ?? null) : null,
          $ob: o.observed ? 1 : 0 }
      );
    }
    for (const g of r.gaps) {
      const gapId = stableId('gap', pack.tiltSeriesId, g.markerId, g.fromFrameSeq, g.toFrameSeq, sourceVersion);
      db.run(
        `INSERT INTO track_gaps(gap_id,tilt_series_id,marker_id,from_frame_seq,to_frame_seq,reason,source_version)
         VALUES($gid,$id,$mk,$f,$t,$r,$sv)`,
        { $gid: gapId, $id: pack.tiltSeriesId, $mk: g.markerId, $f: g.fromFrameSeq, $t: g.toFrameSeq, $r: g.reason, $sv: sourceVersion }
      );
    }
    for (const ex of r.exclusions) {
      const exId = stableId('excl', pack.tiltSeriesId, ex.frameSeq, sourceVersion);
      db.run(
        `INSERT INTO manual_exclusions(exclusion_id,tilt_series_id,frame_seq,reason,author,at_iso,revoked,source_version)
         VALUES($eid,$id,$seq,$r,$au,$at,0,$sv)`,
        { $eid: eid, $id: pack.tiltSeriesId, $seq: ex.frameSeq, $r: ex.reason, $au: ex.author, $at: ex.atIso, $sv: sourceVersion }
      );
    }

    const refs = [
      { ref: pack.tiltSeriesId, version: sourceVersion, kind: 'tilt-series',
        summary: `${pack.name} variant=${variantKey}` },
      ...(pixelScale.unconvertible
        ? [{ ref: stableId('qty', 'pixelScale', pack.tiltSeriesId, sourceVersion), version: sourceVersion,
             kind: 'pixel-scale', summary: quantitySummary(pixelScale) }]
        : [])
    ];
    const rationale: RationaleCode[] = ['NO_IRREVERSIBLE_IMPORT_CLEANING'];
    if (pixelScale.unconvertible) rationale.push('UNCONVERTIBLE_VALUE_KEPT');

    db.run(
      `INSERT INTO import_batches(batch_id,tilt_series_id,source_version,committed,created_at_iso)
       VALUES($b,$id,$sv,1,$at)`,
      { $b: batchId, $id: pack.tiltSeriesId, $sv: sourceVersion, $at: nowIso() }
    );
    appendEvent(db, {
      code: 'import.commit', branchId: null, atIso: nowIso(), author: opts.author ?? 'em-team',
      refs, rationaleCodes: rationale,
      payload: { tiltSeriesId: pack.tiltSeriesId, sourceVersion, variantKey,
                 frameCount: r.frames.length, blobCount: insertedBlobs.length,
                 pixelScale: quantitySummary(pixelScale),
                 unconvertibleValues: pixelScale.unconvertible ? [{ field: 'pixelScale', raw: r.pixelScaleRaw, diagnostic: pixelScale.diagnostic }] : [] }
    });

    db.run('RELEASE SAVEPOINT import');
    return {
      tiltSeriesId: pack.tiltSeriesId, name: pack.name, signConvention: pack.signConvention,
      widthPx: pack.widthPx, heightPx: pack.heightPx, sourceVersion, pixelScale, batchId,
      frames: r.frames.map((f) => ({
        frameSeq: f.frameSeq, blobSha: sha256Hex(f.bytes), byteLength: f.bytes.length,
        dose: parseDose(f.doseRaw),
        angle: parseAngle(r.angles.find((a) => a.frameSeq === f.frameSeq)?.raw ?? '0deg', pack.signConvention)
      })),
      observations: r.obs.map((o) => ({ markerId: o.markerId, frameSeq: o.frameSeq,
        xPx: o.observed ? (o.xPx ?? null) : null, yPx: o.observed ? (o.yPx ?? null) : null, observed: o.observed })),
      gaps: r.gaps, exclusions: r.exclusions
    };
  } catch (e) {
    db.run('ROLLBACK TO SAVEPOINT import');
    db.run('RELEASE SAVEPOINT import');
    // blob 是不可变内容，保存点回滚已撤销其插入；记录一次回滚事件（若事件表可用）
    throw new ImportRollbackError(e instanceof Error ? e.message : String(e), insertedBlobs);
  }
}

export class ImportRollbackError extends Error {
  insertedBlobShas: string[];
  constructor(message: string, shas: string[]) {
    super(`import rolled back: ${message}`);
    this.name = 'ImportRollbackError';
    this.insertedBlobShas = shas;
  }
}

/** 故意触发失败的导入用于回滚测试：注入一个会在解析阶段抛错的畸形 pack */
export function importMalformedForRollback(db: Database): void {
  const bad = { tiltSeriesId: 'ts_should_rollback', name: 'x', signConvention: 's',
    widthPx: 1, heightPx: 1, pixelScaleRaw: '1 nm/px',
    angles: [{ frameSeq: 0, raw: '0deg' }],
    frames: [{ frameSeq: 0, bytes: new Uint8Array([1]), widthPx: 1, heightPx: 1, doseRaw: '1 e-/A^2' }],
    markerObservations: [], gaps: [], exclusions: [], timeline: [], variants: [] } as unknown as TiltPack;
  importTiltPack(db, bad);
  // 强制一个后续失败：重复主键
  db.run('INSERT INTO tilt_series(tilt_series_id) VALUES($id)', { $id: 'ts_should_rollback' });
}

export function listSourceVersions(db: Database, tiltSeriesId: string): number[] {
  return queryAll<{ v: number }>(
    db, `SELECT DISTINCT source_version AS v FROM frames WHERE tilt_series_id=$id ORDER BY v`,
    { $id: tiltSeriesId }).map((r) => r.v);
}
