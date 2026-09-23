import { DatabaseSync } from 'node:sqlite';
import { ReviewService } from './src/server/service.js';
import { generateCaseBundle } from './src/case/generate.js';
import { exportArchive, importArchive } from './src/server/transfer.js';

const db = new DatabaseSync(':memory:');
// need migrations
const { migrate } = await import('./src/server/db.js');
migrate(db);
const svc = new ReviewService(db);
const r = svc.importCase(generateCaseBundle());
console.log('imported', r.imported, 'branches', r.branches);
const main = generateCaseBundle().manifest.branches[0].branchId;
const snap = svc.snapshot(main);
console.log('frames', snap.frameCount, 'recorded', snap.recordedFrames, 'points', snap.pointCount);
console.log('candidates', snap.candidates.map(c=>[c.kind, c.overallRmsPx.toFixed(3), c.ambiguity]));
console.log('tracks segments', snap.tracks?.segments.length, 'gaps', snap.tracks?.gaps.length, 'swaps', snap.tracks?.swaps.length);
console.log('axis snap?', JSON.stringify(snap.axis).slice(0,120));
const axisSnap = svc.snapshot(generateCaseBundle().manifest.branches[1].branchId);
console.log('axis branch axisVersion', axisSnap.axisVersion, 'ecc', axisSnap.axis?.eccentricityPx);
console.log('scenarios', snap.scenarios.length);
