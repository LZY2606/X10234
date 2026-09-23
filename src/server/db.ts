import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from '../shared/ids';

export let db: DatabaseSync;

const SCHEMA_V1 = `
create table if not exists meta (
  key text primary key,
  value text not null
);
create table if not exists blobs (
  sha256 text primary key,
  bytes blob not null,
  size integer not null
);
create table if not exists entity_versions (
  id text not null,
  version integer not null,
  kind text not null,
  name text,
  content text not null,
  content_hash text not null,
  supersedes_event_id text,
  basis text not null default '[]',
  primary key (id, version)
);
create table if not exists events (
  event_id text primary key,
  seq integer not null unique,
  branch text not null,
  type text not null,
  timestamp_ms integer not null,
  actor text not null,
  parent_event_id text,
  payload text not null,
  basis text not null default '[]',
  labels text not null default '[]'
);
create table if not exists branches (
  branch text primary key,
  head_event_id text,
  parent_branch text,
  kind text not null,
  title text not null,
  frozen integer not null default 0,
  accepted_event_id text
);
create table if not exists event_versions (
  event_id text not null,
  entity_id text not null,
  version integer not null,
  primary key (event_id, entity_id, version)
);
create table if not exists invalidations (
  invalidation_id text primary key,
  event_id text not null,
  scope_event_ids text not null,
  scope_entity_refs text not null,
  changed_ref text not null,
  reason text not null
);
`;

const SCHEMA_V2 = `
create table if not exists advisory_locks (
  resource text primary key,
  session_id text not null,
  base_event_id text not null,
  acquired_ms integer not null
);
`;

export function openDb(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('pragma journal_mode = WAL;');
  db.exec('pragma foreign_keys = on;');
  migrate(db);
  return db;
}

export function migrate(database: DatabaseSync) {
  database.exec(SCHEMA_V1);
  const userVersion = (database.prepare('pragma user_version').get() as { user_version: number }).user_version;
  if (userVersion < 2) {
    database.exec(SCHEMA_V2);
    database.exec('pragma user_version = 2');
  }
  const v = (database.prepare('pragma user_version').get() as { user_version: number }).user_version;
  database.prepare('insert or ignore into meta(key,value) values(?,?)').run('schema_version', String(v));
}

export function schemaVersion(): number {
  return (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
}

export function putBlob(bytes: Uint8Array): string {
  const hash = sha256Bytes(bytes);
  const existing = db.prepare('select sha256 from blobs where sha256=?').get(hash);
  if (!existing) db.prepare('insert into blobs(sha256,bytes,size) values(?,?,?)').run(hash, bytes, bytes.length);
  return hash;
}

export function getBlob(hash: string): Uint8Array | null {
  const row = db.prepare('select bytes from blobs where sha256=?').get(hash) as { bytes: Uint8Array } | undefined;
  return row?.bytes ?? null;
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
