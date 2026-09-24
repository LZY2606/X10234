import type { DataAccess, BlobRec, FactRec, EventRec, RefRec, DepRec } from "./dataAccess";
import { asBytes, type Store } from "./dataAccess";

/** node:sqlite 的 DataAccess 实现。 */
export class SqliteData implements DataAccess {
  readonly engine = "sqlite";

  constructor(private store: Store) {}

  getMeta(key: string): string | null {
    const row = this.store.get("SELECT value FROM meta WHERE key = ?", [key]);
    return row ? (row.value as string) : null;
  }
  setMeta(key: string, value: string): void {
    this.store.run(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    );
  }

  getBlob(blobId: string): BlobRec | null {
    const row = this.store.get(
      "SELECT blob_id, bytes, size, created_event_id FROM blobs WHERE blob_id = ?",
      [blobId]
    );
    if (!row) return null;
    return {
      blobId: row.blob_id as string,
      bytes: asBytes(row.bytes),
      size: row.size as number,
      createdEventId: (row.created_event_id as string) ?? null
    };
  }
  putBlob(rec: BlobRec): void {
    this.store.run(
      "INSERT OR IGNORE INTO blobs(blob_id, bytes, size, created_event_id) VALUES(?, ?, ?, ?)",
      [rec.blobId, rec.bytes, rec.size, rec.createdEventId]
    );
  }
  listBlobIds(): string[] {
    return this.store.all("SELECT blob_id FROM blobs ORDER BY blob_id", []).map((r) => r.blob_id as string);
  }

  getFact(stableId: string, version: number): FactRec | null {
    const row = this.store.get(
      "SELECT stable_id, version, kind, entity_json, content_digest, created_event_id, supersedes_version FROM facts WHERE stable_id = ? AND version = ?",
      [stableId, version]
    );
    return row ? factFromRow(row) : null;
  }
  latestFact(stableId: string): FactRec | null {
    const row = this.store.get(
      "SELECT stable_id, version, kind, entity_json, content_digest, created_event_id, supersedes_version FROM facts WHERE stable_id = ? ORDER BY version DESC LIMIT 1",
      [stableId]
    ) as never;
    return row ? factFromRow(row as Record<string, unknown>) : null;
  }
  putFact(rec: FactRec): void {
    this.store.run(
      "INSERT INTO facts(stable_id, version, kind, entity_json, content_digest, created_event_id, supersedes_version) VALUES(?,?,?,?,?,?,?)",
      [rec.stableId, rec.version, rec.kind, rec.entityJson, rec.contentDigest, rec.createdEventId, rec.supersedesVersion]
    );
  }
  listFacts(): FactRec[] {
    return this.store
      .all("SELECT stable_id, version, kind, entity_json, content_digest, created_event_id, supersedes_version FROM facts", [])
      .map(factFromRow);
  }
  factsByKind(kind: string): FactRec[] {
    return this.store
      .all("SELECT stable_id, version, kind, entity_json, content_digest, created_event_id, supersedes_version FROM facts WHERE kind = ? ORDER BY stable_id, version", [kind])
      .map(factFromRow);
  }
  listVersions(stableId: string): number[] {
    return this.store
      .all("SELECT version FROM facts WHERE stable_id = ? ORDER BY version", [stableId])
      .map((r) => r.version as number);
  }

  getEvent(eventId: string): EventRec | null {
    const row = this.store.get(
      "SELECT event_id, seq, parent_event_id, branch, event_type, payload_json, author, created_at, baseline_id, conflict_status FROM events WHERE event_id = ?",
      [eventId]
    );
    return row ? eventFromRow(row) : null;
  }
  putEvent(rec: EventRec): void {
    this.store.run(
      "INSERT INTO events(event_id, seq, parent_event_id, branch, event_type, payload_json, author, created_at, baseline_id, conflict_status) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [rec.eventId, rec.seq, rec.parentEventId, rec.branch, rec.eventType, rec.payloadJson, rec.author, rec.createdAt, rec.baselineId, rec.conflictStatus]
    );
  }
  listEvents(): EventRec[] {
    return this.store
      .all("SELECT event_id, seq, parent_event_id, branch, event_type, payload_json, author, created_at, baseline_id, conflict_status FROM events ORDER BY seq", [])
      .map(eventFromRow);
  }
  eventsOnBranch(branch: string): EventRec[] {
    return this.store
      .all("SELECT event_id, seq, parent_event_id, branch, event_type, payload_json, author, created_at, baseline_id, conflict_status FROM events WHERE branch = ? ORDER BY seq", [branch])
      .map(eventFromRow);
  }
  maxSeq(): number {
    const row = this.store.get("SELECT MAX(seq) AS m FROM events", []);
    return (row?.m as number) ?? 0;
  }

  getRef(branch: string): RefRec | null {
    const row = this.store.get(
      "SELECT branch, head_event_id, head_seq, expected_parent_event_id FROM refs WHERE branch = ?",
      [branch]
    );
    if (!row) return null;
    return {
      branch: row.branch as string,
      headEventId: row.head_event_id as string,
      headSeq: row.head_seq as number,
      expectedParentEventId: (row.expected_parent_event_id as string) ?? null
    };
  }
  putRef(rec: RefRec): void {
    this.store.run(
      "INSERT INTO refs(branch, head_event_id, head_seq, expected_parent_event_id) VALUES(?,?,?,?) ON CONFLICT(branch) DO UPDATE SET head_event_id=excluded.head_event_id, head_seq=excluded.head_seq, expected_parent_event_id=excluded.expected_parent_event_id",
      [rec.branch, rec.headEventId, rec.headSeq, rec.expectedParentEventId]
    );
  }
  listRefs(): RefRec[] {
    return this.store
      .all("SELECT branch, head_event_id, head_seq, expected_parent_event_id FROM refs ORDER BY branch", [])
      .map((r) => ({
        branch: r.branch as string,
        headEventId: r.head_event_id as string,
        headSeq: r.head_seq as number,
        expectedParentEventId: (r.expected_parent_event_id as string) ?? null
      }));
  }

  addDep(rec: DepRec): void {
    this.store.run(
      "INSERT OR IGNORE INTO dependencies(from_id, from_version, to_id, to_version, relation) VALUES(?,?,?,?,?)",
      [rec.fromId, rec.fromVersion, rec.toId, rec.toVersion, rec.relation]
    );
  }
  depsFrom(fromId: string, fromVersion: number): DepRec[] {
    return this.store
      .all("SELECT from_id, from_version, to_id, to_version, relation FROM dependencies WHERE from_id = ? AND from_version = ?", [fromId, fromVersion])
      .map(depFromRow);
  }
  depsTo(toId: string, toVersion: number): DepRec[] {
    return this.store
      .all("SELECT from_id, from_version, to_id, to_version, relation FROM dependencies WHERE to_id = ? AND to_version = ?", [toId, toVersion])
      .map(depFromRow);
  }
  listDeps(): DepRec[] {
    return this.store
      .all("SELECT from_id, from_version, to_id, to_version, relation FROM dependencies ORDER BY from_id, from_version", [])
      .map(depFromRow);
  }

  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }
  close(): void {
    this.store.close();
  }
  clearAll(): void {
    this.store.exec(
      "DELETE FROM blobs; DELETE FROM facts; DELETE FROM events; DELETE FROM refs; DELETE FROM dependencies; DELETE FROM meta;"
    );
  }
}

function factFromRow(r: Record<string, unknown>): FactRec {
  return {
    stableId: r.stable_id as string,
    version: r.version as number,
    kind: r.kind as string,
    entityJson: r.entity_json as string,
    contentDigest: r.content_digest as string,
    createdEventId: r.created_event_id as string,
    supersedesVersion: (r.supersedes_version as number) ?? null
  };
}
function eventFromRow(r: Record<string, unknown>): EventRec {
  return {
    eventId: r.event_id as string,
    seq: r.seq as number,
    parentEventId: (r.parent_event_id as string) ?? null,
    branch: r.branch as string,
    eventType: r.event_type as string,
    payloadJson: r.payload_json as string,
    author: r.author as string,
    createdAt: r.created_at as string,
    baselineId: (r.baseline_id as string) ?? null,
    conflictStatus: (r.conflict_status as string) ?? null
  };
}
function depFromRow(r: Record<string, unknown>): DepRec {
  return {
    fromId: r.from_id as string,
    fromVersion: r.from_version as number,
    toId: r.to_id as string,
    toVersion: r.to_version as number,
    relation: r.relation as string
  };
}
