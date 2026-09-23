import { generateBaselineMaterial } from "../src/domain/synthetic.js";
import { searchAxis } from "../src/domain/geometry.js";

const mat = generateBaselineMaterial();
const frames = mat.frames;
const correct: Record<string, number> = {
  "seg-0": 0, "seg-1": 1, "seg-2": 2, "seg-3": 3,
  "seg-4a": 4, "seg-4b": 4, "seg-5a": 5, "seg-5b": 5,
};
function run(map: Record<string, number>, label: string) {
  const obs = mat.observations
    .filter((o) => o.frameId !== "f09")
    .map((o) => ({
      trackIndex: map[o.segmentId],
      frameIndex: frames.findIndex((f) => f.frameId === o.frameId),
      x: o.x, y: o.y,
    }));
  const res = searchAxis(frames.map((f) => f.angleDeg), 6, obs, { x: 48, y: 48 },
    { offsetRangePx: 30, coarseStepPx: 4, dirStepDeg: 2, nonUniqueRatio: 1.1 });
  console.log(label, JSON.stringify({
    dir: res.best.dirDeg,
    origin: [res.best.origin.x.toFixed(2), res.best.origin.y.toFixed(2)],
    rms: res.best.solve.rms.toFixed(4),
    nearBest: res.nearBest.length,
  }));
}
run(correct, "correct links:");
run({ ...correct, "seg-4b": 5, "seg-5b": 4 }, "swapped links:");
console.log("truth origin:", mat.truth.originX, mat.truth.originY, "dir:", mat.truth.axisDirDeg);
