export const BRANCH_MAIN = 'main';

const PREFIX = {
  rawFrame: 'FRM',
  tiltAngle: 'TILT',
  pixelScale: 'PXSC',
  exposureDose: 'DOSE',
  fiducialObservation: 'FID',
  trackingGap: 'GAP',
  manualExclusion: 'EXCL',
  alignmentParams: 'PARAM',
  tiltAxis: 'AXIS',
  trackIdentity: 'TRKID',
  alignmentCandidate: 'CAND',
  adjudication: 'ADJ',
  registrationLock: 'LOCK'
} as const;

export function prefixFor(kind: string): string {
  return (PREFIX as Record<string, string>)[kind] ?? 'ENT';
}

export function makeStableId(kind: string, key: string): string {
  return `${prefixFor(kind)}-${key}`;
}

export function eventId(seq: number, branch: string): string {
  return `EVT-${branch.replace(/[^A-Za-z0-9]/g, '')}-${String(seq).padStart(4, '0')}`;
}

export function lockRef(branch: string, seq: number): string {
  return `LCK-${branch.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}-${String(seq).padStart(4, '0')}`;
}

export function candidateKey(branch: string, seq: number, scheme: string): string {
  return `${branch}-${String(seq).padStart(4, '0')}-${scheme}`;
}
