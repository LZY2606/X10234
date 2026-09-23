import { db, hashJson } from './db';

export interface EntityVersionRecord {
  id: string;
  version: number;
  kind: string;
  name: string | null;
  content: unknown;
  contentHash: string;
  supersedesEventId: string | null;
  basis: string[];
}

export function nextSeq(): number {
  const row = db.prepare('select coalesce(max(seq),0) as m from events').get() as { m: number };
  return row.m + 1;
}

export function nextEntityVersion(id: string): number {
  const row = db.prepare('select coalesce(max(version),0) as m from entity_versions where id=?').get(id) as { m: number };
  return row.m + 1;
}

export function getEntityVersion(id: string, version: number): EntityVersionRecord | null {
  const row = db
    .prepare('select * from entity_versions where id=? and version=?')
    .get(id, version) as any;
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    name: row.name,
    content: JSON.parse(row.content),
    contentHash: row.content_hash,
    supersedesEventId: row.supersedes_event_id,
    basis: JSON.parse(row.basis)
  };
}

export function refExists(ref: string): boolean {
  const m = /^(.+)@v(\d+)$/.exec(ref);
  if (!m) return false;
  return !!getEntityVersion(m[1], Number(m[2]));
}

export function requireRef(ref: string): EntityVersionRecord {
  const m = /^(.+)@v(\d+)$/.exec(ref);
  if (!m) throw new CorruptError(`bad reference format: ${ref}`);
  const rec = getEntityVersion(m[1], Number(m[2]));
  if (!rec) throw new CorruptError(`dangling reference (missing referenced version): ${ref}`);
  return rec;
}

export class CorruptError extends Error {
  status = 409;
  code = 'DANGLING_REFERENCE';
}

export class ConflictError extends Error {
  status = 409;
  code = 'VERSION_CONFLICT';
  details: unknown;
  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

export function assertBasis(basis: string[]) {
  for (const ref of basis) requireRef(ref);
}

export function resolveRef(ref: string): { record: EntityVersionRecord } {
  return { record: requireRef(ref) };
}

export { hashJson };
