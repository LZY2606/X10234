import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../server/db.js';
import { ReviewService } from '../server/service.js';
import { generateCaseBundle, CASE_BRANCH_MAIN, CASE_BRANCH_AXIS } from '../case/generate.js';

describe('smoke', () => {
  it('imports case', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const svc = new ReviewService(db);
    const r = svc.importCase(generateCaseBundle());
    const snap = svc.snapshot(CASE_BRANCH_MAIN);
    console.log('imported', r.imported);
    console.log('frames', snap.frameCount, 'recorded', snap.recordedFrames, 'points', snap.pointCount);
    console.log('candidates', snap.candidates.map((c) => [c.kind, Number(c.overallRmsPx.toFixed(3)), c.ambiguity]));
    console.log('tracks', snap.tracks?.segments.length, snap.tracks?.gaps.length, snap.tracks?.swaps.length);
    console.log('scenarios', snap.scenarios.map((s: any) => s.code));
    const axisSnap = svc.snapshot(CASE_BRANCH_AXIS);
    console.log('axis ecc', axisSnap.axis?.eccentricityPx, 'origin', axisSnap.axis?.originX, axisSnap.axis?.originY);
    expect(r.imported).toBeGreaterThan(10);
  });
});
