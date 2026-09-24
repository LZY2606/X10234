import type { DB } from './db.ts';
import { applyMigrations } from './db.ts';
import { CorruptReferenceError } from './errors.ts';
import { sha256Bytes } from './hash.ts';

interface ExportedArchive {
  format: string;
  blobs: { digest: string; kind: string; bytesBase64: string }[];
  versions: Record<string, unknown>[];
  heads: Record<string, unknown>[];
  events: Record<string, unknown>[];
  locks: Record<string, unknown>[];
}

/**
 * Load an archive into an empty database. Identities, order and provenance are
 * restored byte-for-byte: same event ids/seqs, same entity versions, same refs.
 * Any missing reference aborts the whole import with rollback (no half archive).
 */
export function importArchive(db: DB, data: unknown): { imported: number } {
  const archive = validateShape(data);
  db.raw.exec('BEGIN');
  try {
    const existing = (db.raw.prepare('SELECT COUNT(*) AS c FROM entity_versions').get() as { c: number }).c;
    if (existing > 0) throw new Error('target database is not empty; refuse to merge archives');

    let importedBlobs = 0;
    const blobInsert = db.raw.prepare('INSERT INTO content_blobs(digest, kind, bytes, imported_at) VALUES(?,?,?,?)');
    for (const blob of archive.blobs) {
      const bytes = new Uint8Array(Buffer.from(blob.bytesBase64, 'base64'));
      const actualDigest = sha256Bytes(bytes);
      if (actualDigest !== blob.digest) {
        throw new Error(`blob digest mismatch for ${blob.digest}: content changed`);
      }
      blobInsert.run(blob.digest, blob.kind, bytes, new Date().toISOString());
      importedBlobs++;
    }

    const vInsert = db.raw.prepare(
      `INSERT INTO entity_versions(entity_id, version, kind, content_digest, summary, payload, refs, created_by_event, created_at, branch_id)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    const present = new Set<string>();
    for (const row of archive.versions) {
      const entityId = String(row.entity_id);
      const version = Number(row.version);
      present.add(`${entityId}@${version}`);
      vInsert.run(
        entityId,
        version,
        String(row.kind),
        String(row.content_digest),
        String(row.summary),
        String(row.payload),
        String(row.refs),
        String(row.created_by_event),
        String(row.created_at),
        String(row.branch_id ?? 'main'),
      );
    }

    // Referential integrity: missing refs are corruption, never a silent fallback.
    for (const row of archive.versions) {
      const refs = JSON.parse(String(row.refs)) as { entityId: string; version: number }[];
      for (const ref of refs) {
        if (!present.has(`${ref.entityId}@${ref.version}`)) {
          throw new CorruptReferenceError(
            `archive integrity check failed: ${row.entity_id}@v${row.version} references missing ${ref.entityId}@v${ref.version}`,
            ref,
          );
        }
      }
    }

    const headInsert = db.raw.prepare(
      'INSERT INTO entity_heads(entity_id, head_version, locked_ref) VALUES(?,?,?)',
    );
    for (const h of archive.heads) headInsert.run(String(h.entity_id), Number(h.head_version), h.locked_ref ?? null);

    const eventInsert = db.raw.prepare('INSERT INTO events(event_id, seq, at, type, payload) VALUES(?,?,?,?,?)');
    for (const e of archive.events) {
      eventInsert.run(String(e.event_id), Number(e.seq), String(e.at), String(e.type), String(e.payload));
    }

    const lockInsert = db.raw.prepare(
      'INSERT INTO adjudication_locks(scope, event_id, revision) VALUES(?,?,?)',
    );
    for (const l of archive.locks) lockInsert.run(String(l.scope), String(l.event_id), Number(l.revision));

    db.raw.exec('COMMIT');
    return { imported: importedBlobs };
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}

function validateShape(data: unknown): ExportedArchive {
  if (!data || typeof data !== 'object') throw new Error('archive is not an object');
  const a = data as Partial<ExportedArchive>;
  if (a.format !== 'tilt-series-registration-archive/v1') throw new Error('unknown archive format');
  for (const key of ['blobs', 'versions', 'heads', 'events', 'locks'] as const) {
    if (!Array.isArray(a[key])) throw new Error(`archive field ${key} missing or not an array`);
  }
  return a as ExportedArchive;
}

export function resetDatabase(db: DB): void {
  const tables = ['adjudication_locks', 'events', 'entity_heads', 'entity_versions', 'content_blobs', 'archive_manifests'];
  db.raw.exec('BEGIN');
  try {
    for (const t of tables) db.raw.exec(`DELETE FROM ${t}`);
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}

export { applyMigrations };
