import type { ChamberDB } from './db/database.js';
import { bumpRevision } from './db/database.js';
import { all, run, tx } from './db/sqlutil.js';
import { sha256Hex } from './hash.js';
import { makeStableId } from './ids.js';
import { decodePgm } from './pgm.js';
import { parseTsf } from './parse-tsf.js';
import type { ImportReport } from './import-report.js';
import type { BundleFile, ParsedPlate } from './model.js';

export interface ImportOptions {
  actor?: string;
  createBaseBranch?: boolean;
}

interface ResolvedImage {
  name: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

interface BlobPlan {
  blobId: string;
  key: string;
  name: string;
  bytes: Uint8Array;
  mediaType: string;
  sha: string;
  reused: boolean;
}

interface IdentityMap {
  seriesEntityId: string;
  frameEntityIds: Record<number, string>;
  frameVersionIds: Record<number, string>;
  angleEntityIds: Record<number, string>;
  angleVersionIds: Record<number, string>;
  doseEntityIds: Record<number, string>;
  doseVersionIds: Record<number, string>;
  trackEntityIds: Record<string, string>;
  trackVersionIds: Record<string, string>;
  scaleEntityId: string | null;
  scaleVersionId: string | null;
  axisEntityId: string | null;
  axisVersionId: string | null;
  gapEntityIds: Record<string, string>;
  swapEntityIds: string[];
  exclusionEntityIds: Record<number, string>;
}

export interface ImportedSeries {
  report: ImportReport;
  identity: IdentityMap;
}

export async function importTsfBundle(
  chamber: ChamberDB,
  bundle: BundleFile[],
  options: ImportOptions = {}
): Promise<ImportedSeries> {
  const plates = bundle.filter((f) => f.name.endsWith('.tsf'));
  if (plates.length === 0) throw new Error('IMPORT_FAILED: bundle contains no .tsf plate');
  if (plates.length > 1) throw new Error('IMPORT_FAILED: one import batch accepts exactly one .tsf plate');
  const plateFile = plates[0];

  // Parse + decode fully before touching the database, so failures roll back the whole batch.
  const { plate, embeddedImages } = parseTsf(new TextDecoder().decode(plateFile.bytes));
  if (!plate.seriesSlug) throw new Error('IMPORT_FAILED: SERIES slug missing');
  if (plate.frames.length === 0) throw new Error('IMPORT_FAILED: no FRAME records');
  const images = resolveImages(plate, bundle, embeddedImages);
  const plateSha = await sha256Hex(plateFile.bytes);
  const importBatch = `BATCH__${plate.seriesSlug}__${plateSha.slice(0, 12)}`;

  const blobInputs: { key: string; name: string; bytes: Uint8Array; mediaType: string }[] = [
    { key: '@plate', name: baseName(plateFile.name), bytes: plateFile.bytes, mediaType: 'text/x-tsf' },
    ...images.map((image) => ({ key: image.name, name: image.name, bytes: image.bytes, mediaType: 'image/x-portable-graymap' }))
  ];
  const blobPlans: BlobPlan[] = [];
  let reusedBlobs = 0;
  for (const input of blobInputs) {
    const sha = await sha256Hex(input.bytes);
    const existing = all<{ blob_id: string }>(chamber.db, 'SELECT blob_id FROM raw_blob WHERE sha256=?', [sha]);
    const blobId = existing.length > 0 ? existing[0].blob_id : makeStableId('RAW_BLOB', [importBatch.replace('BATCH__', ''), input.name]);
    if (existing.length > 0) reusedBlobs++;
    blobPlans.push({ blobId, key: input.key, name: input.name, bytes: input.bytes, mediaType: input.mediaType, sha, reused: existing.length > 0 });
  }

  const now = new Date().toISOString();
  try {
    const identity = tx(chamber.db, () => {
      for (const plan of blobPlans) {
        if (plan.reused) continue;
        run(
          chamber.db,
          `INSERT INTO raw_blob (blob_id, sha256, byte_length, media_type, original_name, bytes, imported_at)
           VALUES (?,?,?,?,?,?,?)`,
          [plan.blobId, plan.sha, plan.bytes.length, plan.mediaType, plan.name, plan.bytes, now]
        );
      }
      return writeSourceLayer(chamber, plate, images, importBatch, blobPlans, now, options.actor ?? 'microscopy_team');
    });
    bumpRevision(chamber);
    const report: ImportReport = {
      importBatch,
      seriesEntityId: identity.seriesEntityId,
      seriesVersionId: makeStableId('TS', [plate.seriesSlug, 'v1']),
      blobCount: blobPlans.length,
      reusedBlobs,
      documentCount: 1,
      frameCount: plate.frames.length,
      trackCount: new Set(plate.fiducials.map((f) => f.label)).size,
      unconvertible: plate.unconvertible,
      warnings: collectWarnings(plate)
    };
    return { report, identity };
  } catch (err) {
    throw new Error(`IMPORT_FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveImages(
  plate: ParsedPlate,
  bundle: BundleFile[],
  embedded: { name: string; bytes: Uint8Array }[]
): ResolvedImage[] {
  const byName = new Map<string, Uint8Array>();
  for (const file of bundle) byName.set(baseName(file.name), file.bytes);
  for (const image of embedded) byName.set(image.name, image.bytes);
  const images: ResolvedImage[] = [];
  for (const frame of plate.frames) {
    const bytes = byName.get(frame.imageName);
    if (!bytes) throw new Error(`IMPORT_FAILED: frame ${frame.ordinal} image ${frame.imageName} missing from bundle`);
    let decoded: ReturnType<typeof decodePgm>;
    try {
      decoded = decodePgm(bytes);
    } catch (err) {
      throw new Error(`IMPORT_FAILED: frame ${frame.ordinal}: ${err instanceof Error ? err.message : String(err)}`);
    }
    images.push({ name: frame.imageName, bytes, width: decoded.width, height: decoded.height });
  }
  return images;
}

function baseName(name: string): string {
  return name.split(/[/\\]/).pop() ?? name;
}

function collectWarnings(plate: ParsedPlate): string[] {
  const warnings = plate.unconvertible.map((u) => `line ${u.lineNo}: ${u.diagnostic}`);
  if (plate.axis?.assumedCenter) warnings.push('tilt axis assumed at image center; eccentricity unverified');
  if (plate.axis && !plate.axis.eccentricityKnown) warnings.push('tilt axis eccentricity not established by evidence');
  const maxAbs = Math.max(0, ...plate.angles.map((a) => Math.abs(a.valueDeg ?? 0)));
  if (maxAbs < 55) warnings.push('high-tilt frames absent: angular coverage truncated');
  return warnings;
}

export function appendEvent(
  db: ChamberDB['db'],
  branchId: string,
  eventType: string,
  eventJson: unknown,
  actor: string,
  now: string,
  undoneBy: string | null = null
): string {
  const seqRow = all<{ m: number }>(db, 'SELECT COALESCE(MAX(seq), 0) AS m FROM branch_event WHERE branch_id=?', [branchId]);
  const seq = (seqRow[0]?.m ?? 0) + 1;
  const eventId = makeStableId('EVT', [branchId, `s${seq}`]);
  run(
    db,
    `INSERT INTO branch_event (event_id, branch_id, seq, event_type, event_json, actor, created_at, undone_by_event_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [eventId, branchId, seq, eventType, JSON.stringify(eventJson), actor, now, undoneBy]
  );
  return eventId;
}

function writeSourceLayer(
  chamber: ChamberDB,
  plate: ParsedPlate,
  images: ResolvedImage[],
  importBatch: string,
  blobPlans: BlobPlan[],
  now: string,
  actor: string
): IdentityMap {
  const db = chamber.db;
  const slug = plate.seriesSlug;
  const blobByKey = new Map(blobPlans.map((p) => [p.key, p]));

  const plateBlob = blobByKey.get('@plate');
  if (!plateBlob) throw new Error('plate blob plan missing');
  run(
    db,
    `INSERT INTO source_document (document_id, import_batch, kind, blob_id, raw_repr, parse_status, diagnostic, imported_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      makeStableId('DOC', [slug, 'plate']),
      importBatch,
      'tilt_series_manifest',
      plateBlob.blobId,
      new TextDecoder().decode(plateBlob.bytes),
      'parsed',
      plate.unconvertible.length ? JSON.stringify(plate.unconvertible) : null,
      now
    ]
  );

  const seriesEntityId = makeStableId('SER', [slug]);
  const seriesVersionId = makeStableId('TS', [slug, 'v1']);
  run(db, 'INSERT INTO tilt_series_entity (series_entity_id, current_version_id) VALUES (?,?)', [
    seriesEntityId,
    seriesVersionId
  ]);
  run(
    db,
    `INSERT INTO tilt_series_version
       (version_id, series_entity_id, version_no, slug, title, coordinate_frame, created_at, created_by_event)
     VALUES (?,?,?,?,?,?,?,?)`,
    [seriesVersionId, seriesEntityId, 1, slug, plate.title || slug, plate.coordinateFrame, now, null]
  );

  const identity: IdentityMap = {
    seriesEntityId,
    frameEntityIds: {},
    frameVersionIds: {},
    angleEntityIds: {},
    angleVersionIds: {},
    doseEntityIds: {},
    doseVersionIds: {},
    trackEntityIds: {},
    trackVersionIds: {},
    scaleEntityId: null,
    scaleVersionId: null,
    axisEntityId: null,
    axisVersionId: null,
    gapEntityIds: {},
    swapEntityIds: [],
    exclusionEntityIds: {}
  };

  images.forEach((image, index) => {
    const frame = plate.frames[index];
    const blob = blobByKey.get(image.name);
    if (!blob) throw new Error(`blob plan missing for ${image.name}`);
    const frameEntityId = makeStableId('FRAME', [slug, `f${frame.ordinal}`]);
    const frameVersionId = makeStableId('FRAME', [slug, `f${frame.ordinal}`, 'v1']);
    run(db, 'INSERT INTO frame_entity (frame_entity_id, series_entity_id, ordinal, current_version_id) VALUES (?,?,?,?)', [
      frameEntityId, seriesEntityId, frame.ordinal, frameVersionId
    ]);
    run(
      db,
      `INSERT INTO frame_version
         (version_id, frame_entity_id, version_no, blob_id, width_px, height_px, source_repr, diagnostic, created_by_event)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [frameVersionId, frameEntityId, 1, blob.blobId, image.width, image.height, `FRAME ${frame.ordinal} ${image.name}`, null, null]
    );
    identity.frameEntityIds[frame.ordinal] = frameEntityId;
    identity.frameVersionIds[frame.ordinal] = frameVersionId;
  });

  writeAngles(db, plate, identity, slug);
  writeDoses(db, plate, identity, slug);
  writePixelScale(db, plate, identity, slug);
  writeTracks(chamber, plate, identity, slug);
  writeExclusions(db, plate, identity, slug);
  writeAxis(db, plate, identity, slug);

  const branchId = makeStableId('BR', [slug, 'baseline']);
  run(
    db,
    `INSERT INTO review_branch (branch_id, series_entity_id, parent_branch_id, name, created_from_event_id, status, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [branchId, seriesEntityId, null, 'baseline import', null, 'open', now]
  );
  const eventId = appendEvent(db, branchId, 'import_baseline', { importBatch, actor, unconvertible: plate.unconvertible }, actor, now);
  run(db, 'UPDATE review_branch SET created_from_event_id=? WHERE branch_id=?', [eventId, branchId]);

  return identity;
}

function writeAngles(db: ChamberDB['db'], plate: ParsedPlate, identity: IdentityMap, slug: string): void {
  for (const angle of plate.angles) {
    const entityId = makeStableId('ANG', [slug, `f${angle.frameOrdinal}`]);
    const versionId = makeStableId('ANG', [slug, `f${angle.frameOrdinal}`, 'v1']);
    run(db, 'INSERT INTO tilt_angle_entity (angle_entity_id, frame_entity_id, current_version_id) VALUES (?,?,?)', [
      entityId, identity.frameEntityIds[angle.frameOrdinal], versionId
    ]);
    run(
      db,
      `INSERT INTO tilt_angle_version
         (version_id, angle_entity_id, version_no, value_deg, unit, raw_value, direction, diagnostic, created_by_event)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [versionId, entityId, 1, angle.valueDeg ?? null, angle.unit, angle.rawValue, angle.direction, angle.diagnostic ?? null, null]
    );
    identity.angleEntityIds[angle.frameOrdinal] = entityId;
    identity.angleVersionIds[angle.frameOrdinal] = versionId;
  }
}

function writeDoses(db: ChamberDB['db'], plate: ParsedPlate, identity: IdentityMap, slug: string): void {
  for (const dose of plate.doses) {
    const entityId = makeStableId('DOSE', [slug, `f${dose.frameOrdinal}`]);
    const versionId = makeStableId('DOSE', [slug, `f${dose.frameOrdinal}`, 'v1']);
    run(db, 'INSERT INTO dose_entity (dose_entity_id, frame_entity_id, current_version_id) VALUES (?,?,?)', [
      entityId, identity.frameEntityIds[dose.frameOrdinal], versionId
    ]);
    run(
      db,
      `INSERT INTO dose_version
         (version_id, dose_entity_id, version_no, electrons_per_angstrom2, raw_value, raw_unit, diagnostic, created_by_event)
       VALUES (?,?,?,?,?,?,?,?)`,
      [versionId, entityId, 1, dose.electronsPerAngstrom2 ?? null, dose.rawValue, dose.rawUnit, dose.diagnostic ?? null, null]
    );
    identity.doseEntityIds[dose.frameOrdinal] = entityId;
    identity.doseVersionIds[dose.frameOrdinal] = versionId;
  }
}

function writePixelScale(db: ChamberDB['db'], plate: ParsedPlate, identity: IdentityMap, slug: string): void {
  const scale = plate.pixelScale;
  if (!scale) return;
  const entityId = makeStableId('PX', [slug, 'series']);
  const versionId = makeStableId('PX', [slug, 'series', 'v1']);
  run(db, 'INSERT INTO pixel_scale_entity (scale_entity_id, scope, target_entity_id, current_version_id) VALUES (?,?,?,?)', [
    entityId, 'series', identity.seriesEntityId, versionId
  ]);
  run(
    db,
    `INSERT INTO pixel_scale_version
       (version_id, scale_entity_id, version_no, angstrom_per_px, raw_value, raw_unit, coordinate_basis, binning, diagnostic, created_by_event)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [versionId, entityId, 1, scale.angstromPerPx ?? null, scale.rawValue, scale.rawUnit, scale.coordinateBasis, scale.binning ?? null, scale.diagnostic ?? null, null]
  );
  identity.scaleEntityId = entityId;
  identity.scaleVersionId = versionId;
}

function writeTracks(chamber: ChamberDB, plate: ParsedPlate, identity: IdentityMap, slug: string): void {
  const db = chamber.db;
  const labels = [...new Set(plate.fiducials.map((f) => f.label))];
  const gapFrames = new Map<string, Set<number>>();
  for (const gap of plate.gaps) {
    if (!gapFrames.has(gap.label)) gapFrames.set(gap.label, new Set());
    gapFrames.get(gap.label)!.add(gap.frameOrdinal);
  }
  const swappedLabels = new Set<string>();
  for (const swap of plate.swaps) {
    swappedLabels.add(swap.labelA);
    swappedLabels.add(swap.labelB);
  }

  for (const label of labels) {
    const trackEntityId = makeStableId('TRACK', [slug, label]);
    const trackVersionId = makeStableId('TRACK', [slug, label, 'v1']);
    const hasGap = gapFrames.has(label);
    const ambiguous = swappedLabels.has(label);
    run(db, 'INSERT INTO track_entity (track_entity_id, series_entity_id, nominal_label, current_version_id) VALUES (?,?,?,?)', [
      trackEntityId, identity.seriesEntityId, label, trackVersionId
    ]);
    run(db, 'INSERT INTO track_version (version_id, track_entity_id, version_no, status, note, created_by_event) VALUES (?,?,?,?,?,?)', [
      trackVersionId,
      trackEntityId,
      1,
      ambiguous ? 'identity_ambiguous' : hasGap ? 'broken' : 'intact',
      hasGap ? 'track contains tracking gaps' : null,
      null
    ]);
    identity.trackEntityIds[label] = trackEntityId;
    identity.trackVersionIds[label] = trackVersionId;

    for (const obs of plate.fiducials.filter((f) => f.label === label)) {
      const pointId = makeStableId('PT', [slug, label, `f${obs.frameOrdinal}`]);
      const frameVersionId = identity.frameVersionIds[obs.frameOrdinal];
      if (!frameVersionId) throw new Error(`IMPORT_FAILED: fiducial ${label} references unknown frame ordinal ${obs.frameOrdinal}`);
      run(
        db,
        `INSERT INTO fiducial_point (point_id, track_version_id, frame_version_id, x_px, y_px, coordinate_basis)
         VALUES (?,?,?,?,?,?)`,
        [pointId, trackVersionId, frameVersionId, obs.xPx, obs.yPx, plate.coordinateFrame]
      );
    }

    for (const gap of plate.gaps.filter((g) => g.label === label)) {
      const gapEntityId = makeStableId('GAP', [slug, label, `f${gap.frameOrdinal}`]);
      const gapVersionId = makeStableId('GAP', [slug, label, `f${gap.frameOrdinal}`, 'v1']);
      run(db, 'INSERT INTO gap_entity (gap_entity_id, track_entity_id, current_version_id) VALUES (?,?,?)', [
        gapEntityId, trackEntityId, gapVersionId
      ]);
      run(
        db,
        `INSERT INTO gap_version (version_id, gap_entity_id, version_no, frame_entity_id, reason_code, raw_repr, created_by_event)
         VALUES (?,?,?,?,?,?,?)`,
        [gapVersionId, gapEntityId, 1, identity.frameEntityIds[gap.frameOrdinal], gap.reasonCode, `GAP ${label} ${gap.frameOrdinal} ${gap.reasonCode}`, null]
      );
      identity.gapEntityIds[`${label}:${gap.frameOrdinal}`] = gapEntityId;
    }
  }

  plate.swaps.forEach((swap, index) => {
    const swapEntityId = makeStableId('SWAP', [slug, `${swap.labelA}_${swap.labelB}`, `b${swap.betweenOrdinal}`, `n${index}`]);
    const swapVersionId = makeStableId('SWAP', [slug, `${swap.labelA}_${swap.labelB}`, `b${swap.betweenOrdinal}`, 'v1']);
    const trackA = identity.trackEntityIds[swap.labelA];
    const trackB = identity.trackEntityIds[swap.labelB];
    if (!trackA || !trackB) throw new Error(`IMPORT_FAILED: SWAP references unknown fiducial label ${swap.labelA}/${swap.labelB}`);
    run(db, 'INSERT INTO swap_entity (swap_entity_id, series_entity_id, current_version_id) VALUES (?,?,?)', [
      swapEntityId, identity.seriesEntityId, swapVersionId
    ]);
    run(
      db,
      `INSERT INTO swap_version
         (version_id, swap_entity_id, version_no, track_a_entity_id, track_b_entity_id, between_frame_ordinal, confidence, raw_repr, created_by_event)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        swapVersionId, swapEntityId, 1, trackA, trackB, swap.betweenOrdinal, swap.confidence,
        `SWAP ${swap.labelA} ${swap.labelB} ${swap.betweenOrdinal} ${swap.confidence}`, null
      ]
    );
    identity.swapEntityIds.push(swapEntityId);
  });
}

function writeExclusions(db: ChamberDB['db'], plate: ParsedPlate, identity: IdentityMap, slug: string): void {
  for (const exclusion of plate.exclusions) {
    const entityId = makeStableId('EXCL', [slug, `f${exclusion.frameOrdinal}`]);
    const versionId = makeStableId('EXCL', [slug, `f${exclusion.frameOrdinal}`, 'v1']);
    run(db, 'INSERT INTO exclusion_entity (exclusion_entity_id, frame_entity_id, current_version_id) VALUES (?,?,?)', [
      entityId, identity.frameEntityIds[exclusion.frameOrdinal], versionId
    ]);
    run(
      db,
      `INSERT INTO exclusion_version
         (version_id, exclusion_entity_id, version_no, reason_code, reason_detail, author, raw_repr, created_by_event)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        versionId, entityId, 1, exclusion.reasonCode, exclusion.reasonDetail, exclusion.author,
        `EXCLUDE ${exclusion.frameOrdinal} ${exclusion.reasonCode} ${exclusion.reasonDetail}`, null
      ]
    );
    identity.exclusionEntityIds[exclusion.frameOrdinal] = entityId;
  }
}

function writeAxis(db: ChamberDB['db'], plate: ParsedPlate, identity: IdentityMap, slug: string): void {
  const axis = plate.axis;
  if (!axis) return;
  const entityId = makeStableId('AXIS', [slug]);
  const versionId = makeStableId('AXIS', [slug, 'v1']);
  run(db, 'INSERT INTO tilt_axis_entity (axis_entity_id, series_entity_id, current_version_id) VALUES (?,?,?)', [
    entityId, identity.seriesEntityId, versionId
  ]);
  run(
    db,
    `INSERT INTO tilt_axis_version
       (version_id, axis_entity_id, version_no, angle_deg, pivot_x_px, pivot_y_px, assumed_center, eccentricity_known, raw_repr, diagnostic, created_by_event)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      versionId, entityId, 1, axis.angleDeg, axis.pivotXPx ?? null, axis.pivotYPx ?? null,
      axis.assumedCenter ? 1 : 0, axis.eccentricityKnown ? 1 : 0, axis.rawRepr, axis.diagnostic ?? null, null
    ]
  );
  identity.axisEntityId = entityId;
  identity.axisVersionId = versionId;
}
