import type { Digest } from './types';
import { digestOf } from './hash';

export interface Vec2 {
  x: number;
  y: number;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 有效点集指纹：候选只有在完全相同的 (轨迹, 帧) 观测集合上才能公平比较。
 * “用少帧换低残差”会立刻表现为不同的指纹，并被比较规则拒绝。
 */
export function pointSetDigest(
  points: Array<{ canonicalTrackId: string; frameId: string }>,
): Digest {
  return digestOf(
    points
      .map((p) => `${p.canonicalTrackId}@${p.frameId}`)
      .sort()
      .join('|'),
  );
}
