import type { DatabaseSync } from 'node:sqlite';
import { sha256Hex, canonicalJson, stableId, uid } from './util';
import {
  applyEvent,
  emptySeriesState,
  HIGH_TILT_DEG,
  replay,
  RULE_VERSION,
  type SeriesState,
} from './state';
import { proposeAxes, proposeCandidates, type AxisHypothesis } from '../shared/derive';
import { parseDQ, toDegrees } from '../shared/domain';
import type {
  BranchInfo,
  CandidateDiagnostic,
  DecisionVerdict,
  Derivation,
  DomainEvent,
  EntityView,
  ID,
  InputEntity,
  InterpretedEntity,
  RegistrationCandidate,
  SeriesMeta,
  TiltAxisGeometry,
  TrackIdentity,
  Vec2,
} from '../shared/types';

export class VersionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly diff: ConflictDiff,
  ) {
    super('VERSION_CONFLICT');
  }
}

export interface ConflictDiff {
  branchId: ID;
  expectedVersion: number;
  currentVersion: number;
  yourEvents: DomainEvent[];
  theirEvents: DomainEvent[];
}

export class IntegrityError extends Error {}

export interface StoredBlob {
  sha256: string;
  mediaType: string;
  bytes: Buffer;
}

export interface CommitInput {
  branchId: ID;
  type: DomainEvent['type'];
  author: string;
  payload: unknown;
  expectedVersion?: number;
  derivation?: Derivation;
  conflictWithEventId?: ID;
}

export class TiltReviewApp {
  constructor(private readonly db: DatabaseSync) {}

  // ---------- blob ----------

  putBlob(blob: StoredBlob): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO blobs (sha256, media_type, byte_length, bytes) VALUES (?, ?, ?, ?)',
      )
      .run(blob.sha256, blob.mediaType, blob.bytes.length, Buffer.from(blob.bytes));
  }

  getBlob(sha256: string): { bytes: Buffer; mediaType: string } | null {
    const row = this.db.prepare('SELECT bytes, media_type FROM blobs WHERE sha256 = ?').get(sha256) as
      | { bytes: Buffer; media_type: string }
      | undefined;
    return row ? { bytes: Buffer.from(row.bytes), mediaType: row.media_type } : null;
  }

  // ---------- 分支 ----------

  listBranches(): BranchInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM branches ORDER BY created_at')
      .all() as BranchRow[];
    return rows.map(rowToBranch);
  }

  getBranch(branchId: ID): BranchInfo {
    const row = this.db.prepare('SELECT * FROM branches WHERE branch_id = ?').get(branchId) as
      | BranchRow
      | undefined;
    if (!row) throw new IntegrityError(`未知分支: ${branchId}`);
    return rowToBranch(row);
  }

  createBranch(name: string, parentBranchId: ID | undefined, note: string, author: string): BranchInfo {
    const branchId = uid('br');
    let parentEventId: ID | undefined;
    if (parentBranchId) {
      const last = this.db
        .prepare('SELECT event_id FROM events WHERE branch_id = ? ORDER BY version DESC LIMIT 1')
        .get(parentBranchId) as { event_id: ID } | undefined;
      parentEventId = last?.event_id;
    }
    const info: BranchInfo = {
      branchId,
      name,
      parentBranchId,
      parentEventId,
      note,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO branches (branch_id, name, parent_branch_id, parent_event_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(branchId, name, parentBranchId ?? null, parentEventId ?? null, note, info.createdAt);
    // 从父分支复制事件链（旧分支、人工裁定和原始字节都可继续读取）
    if (parentBranchId) {
      const events = this.getEvents(parentBranchId);
      for (const e of events) this.insertEventRow({ ...e, branchId, expectedVersion: 0 });
    }
    this.commit({
      branchId,
      type: 'branch.created',
      author,
      payload: info,
      expectedVersion: 0,
    });
    return info;
  }

  // ---------- 事件提交（乐观并发） ----------

  commit(input: CommitInput): DomainEvent {
    const head = this.headVersion(input.branchId);
    const expected = input.expectedVersion ?? 0;
    if (expected !== 0 && expected !== head) {
      const yourEvents = this.eventsSince(input.branchId, expected);
      const theirEvents = this.eventsSince(input.branchId, expected);
      throw new VersionConflictError(expected, head, {
        branchId: input.branchId,
        expectedVersion: expected,
        currentVersion: head,
        yourEvents: [previewEvent(input)],
        theirEvents,
      });
    }
    const event: DomainEvent = {
      eventId: uid('ev'),
      branchId: input.branchId,
      version: head + 1,
      type: input.type,
      at: new Date().toISOString(),
      author: input.author,
      payload: input.payload,
      derivation: input.derivation,
      expectedVersion: expected,
      conflictWithEventId: input.conflictWithEventId,
      parentEventId: this.headEventId(input.branchId),
    };
    this.insertEventRow(event);
    return event;
  }

  getEvents(branchId: ID): DomainEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE branch_id = ? ORDER BY version ASC')
      .all(branchId) as EventRow[];
    return rows.map(rowToEvent);
  }

  headVersion(branchId: ID): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM events WHERE branch_id = ?')
      .get(branchId) as { v: number };
    return row.v;
  }

  private headEventId(branchId: ID): ID | undefined {
    const row = this.db
      .prepare('SELECT event_id FROM events WHERE branch_id = ? ORDER BY version DESC LIMIT 1')
      .get(branchId) as { event_id: ID } | undefined;
    return row?.event_id;
  }

  private eventsSince(branchId: ID, version: number): DomainEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE branch_id = ? AND version > ? ORDER BY version ASC')
      .all(branchId, version) as EventRow[];
    return rows.map(rowToEvent);
  }

  private insertEventRow(event: DomainEvent): void {
    const payloadJson = canonicalJson(event.payload);
    this.db
      .prepare(
        `INSERT INTO events
          (event_id, branch_id, version, type, author, at, payload_json, derivation_json,
           expected_version, conflict_with_event_id, parent_event_id, payload_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.branchId,
        event.version,
        event.type,
        event.author,
        event.at,
        payloadJson,
        event.derivation ? canonicalJson(event.derivation) : null,
        event.expectedVersion,
        event.conflictWithEventId ?? null,
        event.parentEventId ?? null,
        sha256Hex(payloadJson),
      );
  }
}

interface BranchRow {
  branch_id: string;
  name: string;
  parent_branch_id: string | null;
  parent_event_id: string | null;
  note: string;
  created_at: string;
}

function rowToBranch(r: BranchRow): BranchInfo {
  return {
    branchId: r.branch_id,
    name: r.name,
    parentBranchId: r.parent_branch_id ?? undefined,
    parentEventId: r.parent_event_id ?? undefined,
    note: r.note,
    createdAt: r.created_at,
  };
}

interface EventRow {
  event_id: string;
  branch_id: string;
  version: number;
  type: DomainEvent['type'];
  author: string;
  at: string;
  payload_json: string;
  derivation_json: string | null;
  expected_version: number;
  conflict_with_event_id: string | null;
  parent_event_id: string | null;
  payload_sha256: string | null;
}

function rowToEvent(r: EventRow): DomainEvent {
  return {
    eventId: r.event_id,
    branchId: r.branch_id,
    version: r.version,
    type: r.type,
    author: r.author,
    at: r.at,
    payload: JSON.parse(r.payload_json),
    derivation: r.derivation_json ? (JSON.parse(r.derivation_json) as Derivation) : undefined,
    expectedVersion: r.expected_version,
    conflictWithEventId: r.conflict_with_event_id ?? undefined,
    parentEventId: r.parent_event_id ?? undefined,
  };
}

function previewEvent(input: CommitInput): DomainEvent {
  return {
    eventId: '(pending)',
    branchId: input.branchId,
    version: -1,
    type: input.type,
    at: new Date().toISOString(),
    author: input.author,
    payload: input.payload,
    expectedVersion: input.expectedVersion ?? 0,
  };
}

// ---------- 状态重放 / 实体查询 ----------

export function stateOf(app: TiltReviewApp, branchId: ID, untilEventId?: ID): SeriesState {
  return replay(app.getEvents(branchId), untilEventId);
}

const ENTITY_BUCKETS: { kind: string; bucket: keyof SeriesState; idField: string }[] = [
  { kind: 'RawFrame', bucket: 'frames', idField: 'frameId' },
  { kind: 'TiltAngle', bucket: 'tilts', idField: 'tiltId' },
  { kind: 'PixelScale', bucket: 'scales', idField: 'scaleId' },
  { kind: 'ExposureDose', bucket: 'doses', idField: 'doseId' },
  { kind: 'MarkerObservation', bucket: 'observations', idField: 'observationId' },
  { kind: 'TrackingGap', bucket: 'gaps', idField: 'gapId' },
  { kind: 'ManualExclusion', bucket: 'exclusions', idField: 'exclusionId' },
  { kind: 'TiltAxisGeometry', bucket: 'axes', idField: 'axisId' },
  { kind: 'TrackIdentity', bucket: 'tracks', idField: 'trackId' },
  { kind: 'RegistrationCandidate', bucket: 'candidates', idField: 'candidateId' },
  { kind: 'RegistrationDecision', bucket: 'decisions', idField: 'decisionId' },
  { kind: 'LockedRegistration', bucket: 'locks', idField: 'lockId' },
];

export function queryEntity(app: TiltReviewApp, branchId: ID, entityId: ID, untilEventId?: ID): EntityView {
  const state = stateOf(app, branchId, untilEventId);
  for (const { kind, bucket, idField } of ENTITY_BUCKETS) {
    const map = state[bucket] as Map<ID, unknown>;
    const value = map.get(entityId);
    if (value) {
      const origin = state.entityOrigin.get(entityId);
      const view: EntityView = {
        entityId,
        entityKind: kind,
        branchId,
        version: origin?.version ?? 0,
        lastChangedEventId: origin?.eventId ?? '',
        value: value as EntityView['value'],
        derivation: origin?.derivation,
        integrity: { status: 'ok' },
      };
      view.integrity = checkEntityIntegrity(state, value as Record<string, unknown>);
      return view;
    }
    void idField;
  }
  throw new IntegrityError(`实体不存在或已失效: ${entityId}`);
}
