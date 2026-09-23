import { computeCandidates, type FitFrame } from '../src/domain/fit.ts';
import type { MarkerObservation } from '../src/domain/types.js';
import { quantity } from '../src/domain/quantities.js';

const W = 96, H = 72;
const beta = 20, alpha = 1.2, h = 10;
const beads = [
  { t: 't1', bx: -15, by: -8 },
  { t: 't2', bx: 12, by: 5 },
  { t: 't3', bx: -4, by: 14 },
  { t: 't4', bx: 18, by: -12 },
  { t: 't5', bx: 6, by: -16 },
  { t: 't6', bx: -19, by: 10 },
];
const frames: FitFrame[] = [];
const obs: MarkerObservation[] = [];
const cb = Math.cos((-beta * Math.PI) / 180); // careful: use same convention as fitter
const sb = Math.sin((beta * Math.PI) / 180);
// fitter rot: u = cosβ x + sinβ y, v = -sinβ x + cosβ y
const cbc = Math.cos((beta * Math.PI) / 180);
const sbc = Math.sin((beta * Math.PI) / 180);
for (let i = 0; i < 21; i++) {
  const tau = -60 + i * 6;
  const fid = `f${i}`;
  frames.push({ frameId: fid, index: i, tiltDeg: tau, width: W, height: H });
  const theta = alpha * Math.tan((tau * Math.PI) / 180);
  const ct = Math.cos((-theta * Math.PI) / 180);
  const st = Math.sin((-theta * Math.PI) / 180);
  const tx = (i - 5) * 0.4, ty = (i % 3) * 0.2;
  for (const bead of beads) {
    const pu = cbc * bead.bx + sbc * bead.by;
    const pv = -sbc * bead.bx + cbc * bead.by;
    const u = ct * pu - st * pv + (cbc * tx + sbc * ty);
    const v = st * pu + ct * pv + (-sbc * tx + cbc * ty) + h;
    const x = cbc * u - sbc * v + W / 2;
    const y = sbc * u + cbc * v + H / 2;
    obs.push({
      kind: 'MarkerObservation', trackId: bead.t, frameId: fid, observed: true, coordFrame: 'image-pixel',
      x: quantity('length', Number(x.toFixed(3)), 'pixel', 'image-pixel'),
      y: quantity('length', Number(y.toFixed(3)), 'pixel', 'image-pixel'),
    });
  }
}
const res = computeCandidates({
  frames, observations: obs, ruleVersion: 'rv-test', interpretationId: 'interp-test',
});
for (const c of res.candidates) {
  console.log(c.strategy.padEnd(18), c.label, 'rms=', c.rmsResidual.value?.toFixed(4), 'common=', c.rmsOnCommonSet.value?.toFixed(4), c.parameterSummary);
}
console.log('basis', res.basis.map(b=>b.code).join(','));
