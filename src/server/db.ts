import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyMigrations, SCHEMA_VERSION } from '../migrations/001_init.js';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const current = readVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema ${current} is newer than code ${SCHEMA_VERSION}; refusing to open`);
  }
  applyMigrations(db, current);
  return db;
}

export function readVersion(db: DatabaseSync): number {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key='schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

/** 损坏检测：引用必须存在且内容摘要必须一致；缺失引用必须报损坏，不退回当前最新版。 */
export function verifyIntegrity(db: DatabaseSync): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  const versions = db.prepare('SELECT * FROM entity_version').all() as Array<{
    version_id: string;
    entity_id: string;
    parent_version_id: string | null;
    content_json: string;
    content_digest: string;
  }>;
  const versionIds = new Set(versions.map((v) => v.version_id));
  const entities = new Set((db.prepare('SELECT entity_id FROM entity').all() as Array<{ entity_id: string }>).map((e) => e.entity_id));

  for (const v of versions) {
    if (!entities.has(v.entity_id)) errors.push(`corrupt: version ${v.version_id} references missing entity ${v.entity_id}`);
    if (v.parent_version_id && !versionIds.has(v.parent_version_id)) {
      errors.push(`corrupt: version ${v.version_id} missing parent reference ${v.parent_version_id}`);
    }
  }

  const candidates = db.prepare('SELECT * FROM candidate').all() as Array<{
    candidate_id: string;
    content_json: string;
    content_digest: string;
  }>;
  for (const c of candidates) {
    const digest = shaFromJson(c.content_json);
    if (digest !== c.content_digest) errors.push(`corrupt: candidate ${c.candidate_id} digest mismatch`);
  }

  // 事件哈希链
  const events = db.prepare('SELECT * FROM event ORDER BY seq').all() as Array<{
    event_id: string;
    seq: number;
    parent_hash: string;
    hash: string;
    payload_json: string;
    type: string;
    branch_id: string;
    actor: string;
    at_iso: string;
  }>;
  for (const e of events) {
    const expect = eventHash(e.parent_hash, { seq: e.seq, branchId: e.branch_id, type: e.type, actor: e.actor, atIso: e.at_iso, payload: JSON.parse(e.payload_json) });
    if (expect !== e.hash) errors.push(`corrupt: event ${e.event_id} hash chain broken`);
  }

  return { ok: errors.length === 0, errors };
}

import { createHash } from 'node:crypto';
import { canonicalJson } from '../domain/util.js';

function shaFromJson(contentJson: string): string {
  return createHash('sha256').update(canonicalJson(JSON.parse(contentJson))).digest('hex');
}

export function eventHash(parentHash: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(parentHash + canonicalJson(body)).digest('hex');
}
