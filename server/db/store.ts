import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DomainEvent } from '../core/types.ts';
import { canonicalJson, eventId } from '../core/identity.ts';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, SCHEMA_V1 } from './schema.ts';
import { Corruption } from '../engine/reducer.ts';

export interface PersistedBlob {
  sha256: string;
  bytes: number;
  data: string;
}

export class EventStore {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(SCHEMA_V1);
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      { value?: string } | undefined;
    let version = row ? Number(row.value) : 1;
    if (!row) {
      this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
    }
    for (const migration of MIGRATIONS) {
      if (version === migration.from) {
        this.db.exec(migration.sql);
        version = migration.to;
        this.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(version), 'schema_version');
      }
    }
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`unsupported schema version ${version}`);
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      { value: string };
    return Number(row.value);
  }

  registerArchive(archiveId: string, role: string, createdAtSeq: number): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO archives(archive_id, role, created_at_seq) VALUES (?, ?, ?)'
    ).run(archiveId, role, createdAtSeq);
  }

  appendEvent(event: DomainEvent, archiveId: string): void {
    const digest = canonicalJson({
      eventId: event.eventId, seq: event.seq, type: event.type, payload: event.payload
    });
    this.db.prepare(`
      INSERT INTO events(seq, archive_id, event_id, branch, type, payload_json,
        dependency_json, scope_json, provenance_json, author, at_iso, probe_id, replay_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.seq, archiveId, event.eventId, event.branch, event.type,
      JSON.stringify(event.payload),
      JSON.stringify(event.dependencyRefs),
      JSON.stringify(event.invalidationScope),
      JSON.stringify(event.provenance),
      event.author, event.atIso, event.probeId ?? null,
      digest
    );
  }

  putBlob(blob: PersistedBlob): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO blobs(sha256, bytes, data) VALUES (?, ?, ?)'
    ).run(blob.sha256, blob.bytes, blob.data);
  }

  loadEvents(archiveId: string): DomainEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE archive_id = ? ORDER BY seq ASC'
    ).all(archiveId) as EventRow[];
    return rows.map(rowToEvent);
  }

  loadAllEvents(): DomainEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as EventRow[];
    // 每个档案独立 seq 空间，重放按 archive_id 分组
    return rows.map(rowToEvent);
  }

  listArchives(): Array<{ archive_id: string; role: string; created_at_seq: number }> {
    return this.db.prepare('SELECT archive_id, role, created_at_seq FROM archives ORDER BY created_at_seq')
      .all() as Array<{ archive_id: string; role: string; created_at_seq: number }>;
  }

  loadBlobs(): PersistedBlob[] {
    return this.db.prepare('SELECT sha256, bytes, data FROM blobs').all() as PersistedBlob[];
  }

  wipe(): void {
    this.db.exec('DELETE FROM events; DELETE FROM blobs; DELETE FROM archives; DELETE FROM entity_heads;');
  }

  /** 重新导入校验：事件身份（含 seq 与负载哈希）必须逐字保持 */
  verifyEventIdentity(events: DomainEvent[]): void {
    for (const event of events) {
      const expected = eventId(event.seq, {
        type: event.type, branch: event.branch, payload: event.payload,
        dependencyRefs: event.dependencyRefs, invalidationScope: event.invalidationScope,
        provenance: event.provenance, atIso: event.atIso
      });
      if (expected !== event.eventId) {
        throw new Corruption('CORRUPT_ORDER',
          `event id mismatch at seq ${event.seq}: ${event.eventId} != ${expected}`,
          event.eventId, event.seq);
      }
    }
  }
}

interface EventRow {
  seq: number;
  archive_id: string;
  event_id: string;
  branch: string;
  type: string;
  payload_json: string;
  dependency_json: string;
  scope_json: string;
  provenance_json: string;
  author: string;
  at_iso: string;
  probe_id: string | null;
}

function rowToEvent(row: EventRow): DomainEvent {
  return {
    eventId: row.event_id,
    seq: row.seq,
    type: JSON.parse(`"${row.type}"`) as DomainEvent['type'],
    branch: row.branch,
    dependencyRefs: JSON.parse(row.dependency_json),
    invalidationScope: JSON.parse(row.scope_json),
    payload: JSON.parse(row.payload_json),
    author: row.author,
    atIso: row.at_iso,
    probeId: row.probe_id ?? undefined,
    provenance: JSON.parse(row.provenance_json)
  };
}
