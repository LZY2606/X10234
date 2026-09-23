import { fitAtBeta } from '../src/domain/fit.ts';
import { quantity } from '../src/domain/quantities.js';
import type { MarkerObservation } from '../src/domain/types.js';
const W=96,H=72;
const beads=[{t:'t1',bx:0,by:0},{t:'t2',bx:12,by:0},{t:'t3',bx:-4,by:14},{t:'t4',bx:18,by:-12}];
const frames=[] as any[], obs=[] as MarkerObservation[];
// alpha=0 => theta=0 => no tilt movement; beta=0,h=0,no translation: obs = bead + center
for(let i=0;i<5;i++){const fid='f'+i;frames.push({frameId:fid,index:i,tiltDeg:0,width:W,height:H});
for(const bead of beads){obs.push({kind:'MarkerObservation',trackId:bead.t,frameId:fid,observed:true,coordFrame:'image-pixel',
x:quantity('length',W/2+bead.bx,'pixel','image-pixel'),y:quantity('length',H/2+bead.by,'pixel','image-pixel')});}}
const fo=obs.map(o=>({trackId:o.trackId,frameId:o.frameId,x:o.x.value!,y:o.y.value!}));
const sol=fitAtBeta(frames,fo,0,0,{localWarp:false,excluded:new Set()});
console.log('rms',sol?.rms,'beads',sol?.beadPoints);
