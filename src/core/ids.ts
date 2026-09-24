// Stable, human-readable identity scheme. Identities survive export/import.
export type IdPrefix =
  | 'RAW_BLOB'
  | 'DOC'
  | 'SER'
  | 'TS'
  | 'FRAME'
  | 'ANG'
  | 'PX'
  | 'DOSE'
  | 'TRACK'
  | 'PT'
  | 'GAP'
  | 'SWAP'
  | 'EXCL'
  | 'AXIS'
  | 'PARAM'
  | 'CAND'
  | 'RESID'
  | 'FIND'
  | 'BR'
  | 'EVT'
  | 'LOCK'
  | 'EDGE'
  | 'VIEW'
  | 'SCEN'
  | 'AMB';

let counter = 0;

export function makeId(prefix: IdPrefix, stableKey: string): string {
  counter = (counter + 1) % 1_000_000;
  const tail = stableKey.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);
  return `${prefix}__${tail}`;
}

// Deterministic id used so re-import of the same archive never remaps identities.
export function makeStableId(prefix: IdPrefix, parts: (string | number)[]): string {
  return `${prefix}__${parts.map((p) => String(p).replace(/[^A-Za-z0-9_.-]+/g, '_')).join('__')}`;
}

export function newEventId(branchId: string, seq: number): string {
  return makeStableId('EVT', [branchId, `s${seq}`]);
}

export function idPrefix(id: string): string {
  return id.split('__')[0];
}
