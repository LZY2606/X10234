import type { DomainEvent, EventKind } from '../../shared/domain';
import { canonicalJson, contentHash } from '../../shared/ids';
import type { Database } from '../db/database';

/** 追加式事件日志：所有判断依据都是机器可读事件；历史只追加、不改写。 */
export class EventLog {
  constructor(private readonly db: Database) {}

  append(branchId: string, kind: EventKind, payload: Record<string, unknown>, at?: string): DomainEvent {
    const head = this.headSeq(branchId);
    const seq = head + 1;
    const timestamp = at ?? new Date().toISOString();
    const eventId = `evt:${contentHash(canonicalJson({ branchId, seq, kind, payload, at: timestamp })).slice(0, 24)}`;
    this.db.run(
      'INSERT INTO events(event_id, seq, branch_id, kind, at, payload) VALUES (?, ?, ?, ?, ?, ?)',
      eventId,
      seq,
      branchId,
      kind,
      timestamp,
      canonicalJson(payload),
    );
    this.db.run('UPDATE branches SET head_seq = ? WHERE branch_id = ?', seq, branchId);
    return { eventId, seq, branchId, kind, at: timestamp, payload };
  }

  headSeq(branchId: string): number {
    const row = this.db.get<{ h: number }>('SELECT COALESCE(MAX(seq), 0) AS h FROM events WHERE branch_id = ?', branchId);
    return row?.h ?? 0;
  }

  list(branchId: string, uptoSeq?: number): DomainEvent[] {
    const rows = uptoSeq === undefined
      ? this.db.all<{ event_id: string; seq: number; kind: string; at: string; payload: string }>(
          'SELECT event_id, seq, kind, at, payload FROM events WHERE branch_id = ? ORDER BY seq',
          branchId,
        )
      : this.db.all<{ event_id: string; seq: number; kind: string; at: string; payload: string }>(
          'SELECT event_id, seq, kind, at, payload FROM events WHERE branch_id = ? AND seq <= ? ORDER BY seq',
          branchId,
          uptoSeq,
        );
    return rows.map((r) => ({
      eventId: r.event_id,
      seq: r.seq,
      branchId,
      kind: r.kind as EventKind,
      at: r.at,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  allEvents(): DomainEvent[] {
    return this.db
      .all<{ event_id: string; seq: number; branch_id: string; kind: string; at: string; payload: string }>(
        'SELECT event_id, seq, branch_id, kind, at, payload FROM events ORDER BY branch_id, seq',
      )
      .map((r) => ({
        eventId: r.event_id,
        seq: r.seq,
        branchId: r.branch_id,
        kind: r.kind as EventKind,
        at: r.at,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
      }));
  }
}
