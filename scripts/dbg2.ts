import { fitAtBeta } from '../src/domain/fit.ts';
import { quantity } from '../src/domain/quantities.js';
import type { MarkerObservation } from '../src/domain/types.js';
const W=96,H=72,beta=20,alpha=1.2,h=10;
const beads=[{t:'t1',bx:-15,by:-8},{t:'t2',bx:12,by:5},{t:'t3',bx:-4,by:14},{t:'t4',bx:18,by:-12},{t:'t5',bx:6,by:-16},{t:'t6',bx:-19,by:10}];
const cbc=Math.cos(beta*Math.PI/180),sbc=Math.sin(beta*Math.PI/180);
const frames=[] as any[], obs=[] as MarkerObservation[];
for(let i=0;i<21;i++){const tau=-60+i*6;const fid='f'+i;frames.push({frameId:fid,index:i,tiltDeg:tau,width:W,height:H});
const theta=alpha*Math.tan(tau*Math.PI/180),ct=Math.cos(-theta),st=Math.sin(-theta),tx=(i-10)*.4,ty=(i%3)*.2;
for(const bead of beads){const pu=cbc*bead.bx+sbc*bead.by,pv=-sbc*bead.bx+cbc*bead.by;
const u=ct*pu-st*pv+(cbc*tx-sbc*ty),v=st*pu+ct*pv+(sbc*tx+cbc*ty)+h;
obs.push({kind:'MarkerObservation',trackId:bead.t,frameId:fid,observed:true,coordFrame:'image-pixel',
x:quantity('length',cbc*u-sbc*v+W/2,'pixel','image-pixel'),y:quantity('length',sbc*u+cbc*v+H/2,'pixel','image-pixel')});}}
const fo=obs.map(o=>({trackId:o.trackId,frameId:o.frameId,x:o.x.value!,y:o.y.value!}));
for(const b of [10,15,19,20,21,25,30]){
  for(const a of [1.1,1.2,1.3]){
    const sol=fitAtBeta(frames,fo,b,a,{localWarp:false,excluded:new Set()});
    console.log('beta',b,'alpha',a,sol?('rms '+sol.rms.toFixed(4)):'null');
  }
}
