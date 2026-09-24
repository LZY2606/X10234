/**
 * 离线案例包「倾转帧拼合室」：电镜 tilt-series 轴线、fiducial 轨迹与配准分支。
 * 完整叙事：初始导入（原始帧/倾角/像素尺度/剂量/标记点/跟踪缺口/手工排除全部版本化）
 * → 参数修订 → 局部源数据改动 → 冲突人工决定 → 七种反例情形 → 规则复核分支。
 */
import { Store, ConflictError } from './store';
import {
  q,
  digestOf,
  RULES,
  SCENARIOS,
  type EntityRef,
  type ScenarioKind
} from '../domain';
import {
  projectPoint,
  fitAxisOffset,
  detectIdentitySwap,
  effectivePointSet,
  residuals,
  perFrameResiduals,
  rms,
  isOverfit,
  ambiguousGroups,
  deterministicNoise,
  type Observation
} from './derive';

export const W = 64;
export const H = 64;
export const CENTER = { x: W / 2, y: H / 2 };
export const AXIS_OFFSET = 12.5;

export const ANGLES: number[] = [];
for (let angle = -60; angle <= 60; angle += 3) ANGLES.push(angle);

export const MARKERS = [
  { id: 'M1', x: -22, y: -20 },
  { id: 'M2', x: -14, y: 12 },
  { id: 'M3', x: -6, y: -8 },
  { id: 'M4', x: 2, y: 16 },
  { id: 'M5', x: 8, y: -22 },
  { id: 'M6', x: 14, y: 6 },
  { id: 'M7', x: 20, y: -12 },
  { id: 'M8', x: 24, y: 20 }
];

const GAP_MARKER = 4; // M5：frameIndex 12..16 跟踪缺口
const GAP_RANGE: [number, number] = [12, 16];
const SWAP_A = 2; // M3
const SWAP_B = 3; // M4
const SWAP_AFTER = 25;
const EXCLUDED: Record<number, string> = { 27: '冰污染遮挡标记点', 33: '帧内漂移过大' };

export interface CaseHandles {
  seriesId: string;
  mainBranch: string;
  compareBranch: string;
  archiveBranch: string;
  frameIds: string[];
  trajectoryIds: string[];
  gapId: string;
  exclusionIds: string[];
  axisId: string;
  candidateIds: { rigid: string; localDeform: string; badFrameExclusion: string };
  scenarioIds: Record<ScenarioKind, { minimal: string; combined: string }>;
  archiveId: string;
}

function noise(markerIdx: number, frameIndex: number): number {
  return deterministicNoise(markerIdx * 1000 + frameIndex);
}

/** 观测位置：投影 + 确定性噪声；M3/M4 在 SWAP_AFTER 之后身份交换。 */
function observedPosition(markerIdx: number, frameIndex: number, tiltDeg: number) {
  const effectiveIdx =
    frameIndex > SWAP_AFTER && (markerIdx === SWAP_A || markerIdx === SWAP_B)
      ? markerIdx === SWAP_A
        ? SWAP_B
        : SWAP_A
      : markerIdx;
  const marker = MARKERS[effectiveIdx];
  const projected = projectPoint(marker, tiltDeg, AXIS_OFFSET, CENTER);
  return {
    x: projected.x + noise(markerIdx, frameIndex),
    y: projected.y + noise(markerIdx + 100, frameIndex)
  };
}

export function renderFrame(tiltDeg: number): Uint8Array {
  const image = new Uint8Array(W * H).fill(32);
  MARKERS.forEach((marker, markerIdx) => {
    const projected = projectPoint(marker, tiltDeg, AXIS_OFFSET, CENTER);
    const px = Math.round(projected.x);
    const py = Math.round(projected.y);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = px + dx;
        const y = py + dy;
        if (x >= 0 && x < W && y >= 0 && y < H) image[y * W + x] = 200 + markerIdx * 4;
      }
    }
  });
  return image;
}

function observations(markerIdx: number, frameIds: string[]): Observation[] {
  const output: Observation[] = [];
  for (let frameIndex = 0; frameIndex < ANGLES.length; frameIndex += 1) {
    if (markerIdx === GAP_MARKER && frameIndex >= GAP_RANGE[0] && frameIndex <= GAP_RANGE[1]) continue;
    const position = observedPosition(markerIdx, frameIndex, ANGLES[frameIndex]);
    output.push({
      frameId: frameIds[frameIndex],
      frameIndex,
      tiltDeg: ANGLES[frameIndex],
      x: position.x,
      y: position.y
    });
  }
  return output;
}
