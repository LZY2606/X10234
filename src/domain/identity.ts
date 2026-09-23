import { createHash } from 'node:crypto';

/**
 * Stable identity for the tilt-assembly-room archive.
 *
 *  - raw bytes get a content identity (sha256) so a shared raw fragment is
 *    stored exactly once and never mutated;
 *  - domain entities carry a semantic slug so exports keep readable, stable ids;
 *  - events form a tamper-evident hash chain;
 *  - versions are per-entity integer revisions plus the content hash of the
 *    exact byte content they cite.
 */

export type ContentHash = `sha256:${string}`;

export function sha256Bytes(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function sha256Json(value: unknown): ContentHash {
  const canonical = canonicalJson(value);
  return sha256Bytes(new TextEncoder().encode(canonical));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

/** Stable id for an imported fragment, independent of where it was imported. */
export function sourceRecordId(input: {
  caseId: string;
  fragmentKind: string;
  localRef: string;
}): string {
  return `${input.caseId}.src.${input.fragmentKind}.${slug(input.localRef)}`;
}

export function interpretationId(input: {
  caseId: string;
  kind: string;
  subjectRef: string;
  branchId: string;
  revision: number;
}): string {
  return `${input.caseId}.int.${input.kind}.${slug(input.subjectRef)}.${input.branchId}.v${input.revision}`;
}

export function candidateId(input: {
  caseId: string;
  scenarioId: string;
  family: string;
  branchId: string;
  serial: number;
}): string {
  return `${input.caseId}.cand.${input.scenarioId}.${input.family}.${input.branchId}.n${input.serial}`;
}

export function branchId(caseId: string, name: string): string {
  return `${caseId}.br.${slug(name)}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}

/** Next link of the append-only, tamper-evident event chain. */
export function chainEventHash(prevHash: ContentHash | 'GENESIS', payload: unknown): ContentHash {
  return sha256Json({ prev: prevHash, payload });
}
