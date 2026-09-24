import { randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { sha256Json, sha256Bytes, canonicalJson } from './hash.ts';
import { CorruptReferenceError, OptimisticLockError } from './errors.ts';
import type { EntityRef, EntityVersion, DomainEvent } from './types.ts';

export class Store {
  constructor(readonly db: DB) {}

  // ---- content blobs (immutable raw bytes, shared once across scenarios) ----

  putBlob(kind: string, bytes: Uint8Array): { digest: string; existing: boolean } {
    const digest = sha256Bytes(bytes);
    const found = this.db.raw.prepare('SELECT digest FROM content_blobs WHERE digest = ?').get(digest);
    if (found) return { digest, existing: true };
    this.db.raw
      .prepare('INSERT INTO content_blobs(digest, kind, bytes, imported_at) VALUES(?,?,?,?)')
      .run(digest, kind, bytes, new Date().toISOString());
    return { digest, existing: false };
  }

  getBlob(digest: string): { kind: string; bytes: Uint8Array } | null {
    const row = this.db.raw.prepare('SELECT kind, bytes FROM content_blobs WHERE digest = ?').get(digest) as
      | { kind: string; bytes: Uint8Array }
      | undefined;
    return row ?? null;
  }

  listBlobs(): { digest: string; kind: string }[] {
    return (this.db.raw.prepare('SELECT digest, kind FROM content_blobs ORDER BY digest').all() as {
      digest: string;
      kind: string;
    }[]);
  }

  // ---- event log ----

  appendEvent(type: string, payload: Record<string, unknown>, at?: string): DomainEvent {
    const row = this.db.raw.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number | null };
    const seq = (row.m ?? 0) + 1;
    const event: DomainEvent = {
      eventId: randomUUID(),
      seq,
      at: at ?? new Date().toISOString(),
      type,
      payload,
    };
    this.db.raw
      .prepare('INSERT INTO events(event_id, seq, at, type, payload) VALUES(?,?,?,?,?)')
      .run(event.eventId, event.seq, event.at, event.type, canonicalJson(payload));
    return event;
  }

  listEvents(): DomainEvent[] {
    const rows = this.db.raw.prepare('SELECT event_id, seq, at, type, payload FROM events ORDER BY seq').all() as {
      event_id: string;
      seq: number;
      at: string;
      type: string;
      payload: string;
    }[];
    return rows.map((r) => ({ eventId: r.event_id, seq: r.seq, at: r.at, type: r.type, payload: JSON.parse(r.payload) }));
  }

  // ---- entity versions (append-only, branched) ----

  private currentVersion(entityId: string): number {
    const row = this.db.raw
      .prepare('SELECT MAX(version) AS v FROM entity_versions WHERE entity_id = ?')
      .get(entityId) as { v: number | null };
    return row.v ?? 0;
  }

  /**
   * Add a new interpretation/decision version. All refs must resolve, otherwise the
   * archive is corrupt: we never silently fall back to the newest version.
   */
  addVersion(args: {
    entityId: string;
    kind: string;
    payload: unknown;
    summary: string;
    refs?: EntityRef[];
    branchId?: string;
    expectedBaseVersion?: number;
    createdByEvent?: string;
  }): { event: DomainEvent; version: EntityVersion } {
    const refs = args.refs ?? [];
    for (const ref of refs) this.requireRef(ref);

    const base = this.currentVersion(args.entityId);
    if (args.expectedBaseVersion !== undefined && args.expectedBaseVersion !== base) {
      throw new OptimisticLockError(
        `version conflict on ${args.entityId}: base ${args.expectedBaseVersion} vs current ${base}`,
        { entityId: args.entityId, baseVersion: args.expectedBaseVersion, currentVersion: base },
      );
    }

    const version = base + 1;
    const contentDigest = sha256Json(args.payload);
    const event =
      args.createdByEvent !== undefined
        ? { eventId: args.createdByEvent }
        : this.appendEvent('entity.versioned', {
            entityId: args.entityId,
            kind: args.kind,
            version,
            branchId: args.branchId ?? 'main',
            summary: args.summary,
            refs,
          });

    this.db.raw
      .prepare(
        `INSERT INTO entity_versions(entity_id, version, kind, content_digest, summary, payload, refs, created_by_event, created_at, branch_id)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        args.entityId,
        version,
        args.kind,
        contentDigest,
        args.summary,
        canonicalJson(args.payload),
        canonicalJson(refs),
        event.eventId,
        new Date().toISOString(),
        args.branchId ?? 'main',
      );
    this.db.raw
      .prepare(`INSERT INTO entity_heads(entity_id, head_version, locked_ref) VALUES(?,1,?)
                ON CONFLICT(entity_id) DO UPDATE SET head_version = excluded.head_version`)
      .run(args.entityId, version, null);
    return { event, version: this.getVersion(args.entityId, version)! };
  }

  requireRef(ref: EntityRef): EntityVersion {
    const v = this.getVersion(ref.entityId, ref.version);
    if (!v) {
      throw new CorruptReferenceError(
        `missing referenced entity ${ref.entityId}@v${ref.version}; refusing to fall back to latest`,
        { entityId: ref.entityId, version: ref.version },
      );
    }
    return v;
  }

  getVersion(entityId: string, version: number): EntityVersion | null {
    const row = this.db.raw
      .prepare(
        `SELECT entity_id, version, kind, content_digest, summary, payload, refs, created_by_event
         FROM entity_versions WHERE entity_id = ? AND version = ?`,
      )
      .get(entityId, version) as
      | {
          entity_id: string;
          version: number;
          kind: string;
          content_digest: string;
          summary: string;
          payload: string;
          refs: string;
          created_by_event: string;
        }
      | undefined;
    if (!row) return null;
    return {
      entityId: row.entity_id,
      version: row.version,
      kind: row.kind,
      contentDigest: row.content_digest,
      summary: row.summary,
      payload: JSON.parse(row.payload),
      refs: JSON.parse(row.refs),
      createdByEvent: row.created_by_event,
    };
  }

  listVersions(entityId: string): EntityVersion[] {
    const rows = this.db.raw
      .prepare('SELECT version FROM entity_versions WHERE entity_id = ? ORDER BY version')
      .all(entityId) as { version: number }[];
    return rows.map((r) => this.getVersion(entityId, r.version)!).filter(Boolean);
  }

  listEntities(): { entityId: string; headVersion: number; kind: string; lockedRef: string | null }[] {
    const rows = this.db.raw
      .prepare(
        `SELECT h.entity_id AS entity_id, h.head_version AS head_version, h.locked_ref AS locked_ref,
                (SELECT kind FROM entity_versions e WHERE e.entity_id = h.entity_id
                 ORDER BY e.version DESC LIMIT 1) AS kind
         FROM entity_heads h ORDER BY h.entity_id`,
      )
      .all() as { entity_id: string; head_version: number; locked_ref: string | null; kind: string }[];
    return rows.map((r) => ({
      entityId: r.entity_id,
      headVersion: r.head_version,
      kind: r.kind,
      lockedRef: r.lockedRef,
    }));
  }

  getHead(entityId: string): EntityVersion | null {
    const row = this.db.raw.prepare('SELECT head_version FROM entity_heads WHERE entity_id = ?').get(entityId) as
      | { head_version: number }
      | undefined;
    return row ? this.getVersion(entityId, row.head_version) : null;
  }

  setLockedRef(entityId: string, lockedRef: string | null): void {
    this.db.raw
      .prepare('UPDATE entity_heads SET locked_ref = ? WHERE entity_id = ?')
      .run(lockedRef, entityId);
  }

  getLockedRef(entityId: string): string | null {
    const row = this.db.raw.prepare('SELECT locked_ref FROM entity_heads WHERE entity_id = ?').get(entityId) as
      | { locked_ref: string | null }
      | undefined;
    return row?.locked_ref ?? null;
  }

  // ---- adjudication lock (optimistic concurrency for two-window saves) ----

  withAdjudicationLock<T>(scope: string, expectedRevision: number | null, fn: () => T): T {
    const row = this.db.raw.prepare('SELECT revision FROM adjudication_locks WHERE scope = ?').get(scope) as
      | { revision: number }
      | undefined;
    if (expectedRevision !== null && (!row || row.revision !== expectedRevision)) {
      throw new OptimisticLockError(
        `concurrent adjudication on ${scope}: expected revision ${expectedRevision}, found ${row?.revision ?? 'none'}`,
        { entityId: scope, baseVersion: expectedRevision ?? -1, currentVersion: row?.revision ?? 0 },
      );
    }
    const result = fn();
    const next = (row?.revision ?? 0) + 1;
    const eventId = (this.db.raw
      .prepare('SELECT event_id FROM events ORDER BY seq DESC LIMIT 1')
      .get() as { event_id: string } | undefined)?.eventId!;
    this.db.raw
      .prepare(
        `INSERT INTO adjudication_locks(scope, event_id, revision) VALUES(?,?,?)
         ON CONFLICT(scope) DO UPDATE SET event_id = excluded.event_id, revision = excluded.revision`,
      )
      .run(scope, eventId, next);
    return result;
  }

  getAdjudicationRevision(scope: string): number {
    const row = this.db.raw.prepare('SELECT revision FROM adjudication_locks WHERE scope = ?').get(scope) as
      | { revision: number }
      | undefined;
    return row?.revision ?? 0;
  }

  // ---- archive export / import ----

  exportArchive(): unknown {
    return {
      format: 'tilt-series-registration-archive/v1',
      exportedAt: new Date().toISOString(),
      blobs: this.listBlobs().map((b) => {
        const full = this.getBlob(b.digest)!;
        return { digest: b.digest, kind: b.kind, bytesBase64: Buffer.from(full.bytes).toString('base64') };
      }),
      versions: this.db.raw
        .prepare(
          `SELECT entity_id, version, kind, content_digest, summary, payload, refs, created_by_event, created_at, branch_id
           FROM entity_versions ORDER BY entity_id, version`,
        )
        .all() as Record<string, unknown>[],
      heads: this.db.raw.prepare('SELECT entity_id, head_version, locked_ref FROM entity_heads').all(),
      events: this.db.raw.prepare('SELECT event_id, seq, at, type, payload FROM events ORDER BY seq').all(),
      locks: this.db.raw.prepare('SELECT scope, event_id, revision FROM adjudication_locks').all(),
    };
  }
}
