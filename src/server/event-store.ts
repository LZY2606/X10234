import { db, hashJson } from './db';
import {
  CorruptError,
  ConflictError,
  assertBasis,
  getEntityVersion,
  nextEntityVersion,
  nextSeq,
  requireRef,
  type EntityVersionRecord
} from './store-helpers';
import { sha256Json } from '../shared/ids';

export interface EntityCreate {
  id: string;
  kind: string;
  name?: string;
  content: unknown;
  stableIdentityKey?: unknown;
}

export interface AppendOptions {
  branch: string;
  type: string;
  actor: string;
  payload: unknown;
  basis?: string[];
  labels?: string[];
  entities?: EntityCreate[];
  nonce?: unknown;
  parentOverride?: string | null;
  seqOverride?: number;
  idOverride?: string;
}

export function getBranch(branch: string) {
  return db.prepare('select * from branches where branch=?').get(branch) as
    | { branch: string; head_event_id: string | null; parent_branch: string | null; kind: string; title: string; frozen: number; accepted_event_id: string | null }
    | undefined;
}

export function ensureBranch(branch: string, kind: string, title: string, parentBranch: string | null = null) {
  const existing = getBranch(branch);
  if (existing) return existing;
  db.prepare(
    'insert into branches(branch, head_event_id, parent_branch, kind, title) values(?,?,?,?,?)'
  ).run(branch, null, parentBranch, kind, title);
  return getBranch(branch)!;
}

function insertEntity(evId: string, e: EntityCreate) {
  const version = nextEntityVersion(e.id);
  const content = e.content as any;
  const previous = db.prepare('select supersedes_event_id from entity_versions where id=? order by version desc limit 1').get(e.id) as
    | { supersedes_event_id: string | null }
    | undefined;
  const contentHash = hashJson(content);
  db.prepare(
    `insert into entity_versions(id,version,kind,name,content,content_hash,supersedes_event_id,basis)
     values(?,?,?,?,?,?,?,?)`
  ).run(e.id, version, e.kind, e.name ?? null, JSON.stringify(content), contentHash, previous?.supersedes_event_id ?? evId, JSON.stringify((content.basis as string[]) ?? []));
  db.prepare('insert into event_versions(event_id,entity_id,version) values(?,?,?)').run(evId, e.id, version);
  return version;
}

export function appendEvent(opts: AppendOptions): string {
  const branch = ensureBranch(opts.branch, opts.branch, opts.branch, null);
  const parent = opts.parentOverride !== undefined ? opts.parentOverride : branch.head_event_id;
  const seq = opts.seqOverride ?? nextSeq();
  const basis = opts.basis ?? [];
  assertBasis(basis);
  const payload = opts.payload;
  const eventId =
    opts.idOverride ??
    sha256Json({ branch: opts.branch, type: opts.type, parent, payload, nonce: opts.nonce ?? null });
  db.prepare(
    `insert into events(event_id,seq,branch,type,timestamp_ms,actor,parent_event_id,payload,basis,labels)
     values(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    eventId,
    seq,
    opts.branch,
    opts.type,
    (payload as any)?.timestampMs ?? Date.now(),
    opts.actor,
    parent,
    JSON.stringify(payload),
    JSON.stringify(basis),
    JSON.stringify(opts.labels ?? [])
  );
  for (const e of opts.entities ?? []) insertEntity(eventId, e);
  db.prepare('update branches set head_event_id=? where branch=?').run(eventId, opts.branch);
  return eventId;
}

export function branchEvents(branch: string): any[] {
  const rows = db
    .prepare(
      `with recursive chain(id) as (
         select head_event_id from branches where branch=?
         union all select parent_event_id from events join chain on events.event_id=chain.id where parent_event_id is not null
       )
       select e.* from events e join chain c on e.event_id=c.id order by e.seq asc`
    )
    .all(branch) as any[];
  return rows.map((r) => ({
    eventId: r.event_id,
    seq: r.seq,
    branch: r.branch,
    type: r.type,
    timestampMs: r.timestamp_ms,
    actor: r.actor,
    parent: r.parent_event_id,
    payload: JSON.parse(r.payload),
    basis: JSON.parse(r.basis),
    labels: JSON.parse(r.labels)
  }));
}

export function allEvents(): any[] {
  const rows = db.prepare('select * from events order by seq asc').all() as any[];
  return rows.map((r) => ({
    eventId: r.event_id,
    seq: r.seq,
    branch: r.branch,
    type: r.type,
    timestampMs: r.timestamp_ms,
    actor: r.actor,
    parent: r.parent_event_id,
    payload: JSON.parse(r.payload),
    basis: JSON.parse(r.basis),
    labels: JSON.parse(r.labels)
  }));
}

export function eventAtOrBefore(branch: string, eventId: string | null): any[] {
  const chain = branchEvents(branch);
  if (!eventId || eventId === 'head') return chain;
  const idx = chain.findIndex((e) => e.eventId === eventId);
  if (idx < 0) throw new CorruptError(`event ${eventId} not on branch ${branch}`);
  return chain.slice(0, idx + 1);
}

export function listBranches() {
  return (db.prepare('select * from branches order by branch').all() as any[]).map((r) => ({
    branch: r.branch,
    head: r.head_event_id,
    parentBranch: r.parent_branch,
    kind: r.kind,
    title: r.title,
    frozen: !!r.frozen,
    acceptedEventId: r.accepted_event_id
  }));
}

export function listEntities(): EntityVersionRecord[] {
  const rows = db.prepare('select * from entity_versions order by id, version').all() as any[];
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    kind: r.kind,
    name: r.name,
    content: JSON.parse(r.content),
    contentHash: r.content_hash,
    supersedesEventId: r.supersedes_event_id,
    basis: JSON.parse(r.basis)
  }));
}

export function entityAt(branch: string, ref: string, atEventId?: string | null): { record: EntityVersionRecord; event: any } {
  const m = /^(.+)@v(\d+)$/.exec(ref);
  if (!m) throw new CorruptError(`bad ref ${ref}`);
  const id = m[1];
  const version = Number(m[2]);
  const rec = getEntityVersion(id, version);
  if (!rec) throw new CorruptError(`missing referenced version ${ref} — archive is corrupt; refusing to fall back to latest`);
  const chain = eventAtOrBefore(branch, atEventId ?? 'head');
  const evRow = db
    .prepare('select event_id from event_versions where entity_id=? and version=?')
    .get(id, version) as { event_id: string } | undefined;
  const visible = chain.find((e) => e.eventId === evRow?.event_id);
  if (!visible) {
    throw new CorruptError(`${ref} exists globally but is not visible on branch ${branch} at requested point`);
  }
  return { record: rec, event: visible };
}

export { ConflictError, CorruptError, requireRef };
