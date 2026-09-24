import { createHash } from 'node:crypto';

/** 领域量：所有数值都携带单位或坐标基准，导入时保留原始表示。 */
export interface Quantity {
  value: number;
  unit: string;
}

export interface Coord2 {
  x: number;
  y: number;
  basis: 'pixel' | 'specimen';
  origin: 'top-left' | 'center';
}

export interface EntityRef {
  entityId: string;
  versionNo: number;
  kind?: string;
}

export const q = (value: number, unit: string): Quantity => ({ value, unit });

/** 派生层规范化：倾角统一为 deg。无法转换返回 null（原值留在原位并附诊断）。 */
export function normalizeAngle(input: Quantity): Quantity | null {
  if (input.unit === 'deg') return { value: input.value, unit: 'deg' };
  if (input.unit === 'mrad') return { value: (input.value * 180) / (1000 * Math.PI), unit: 'deg' };
  return null;
}

/** 派生层规范化：像素尺度统一为 Å/px。 */
export function normalizePixelSize(input: Quantity): Quantity | null {
  if (input.unit === 'Å/px') return { value: input.value, unit: 'Å/px' };
  if (input.unit === 'nm/px') return { value: input.value * 10, unit: 'Å/px' };
  return null;
}

/** 派生层规范化：曝光剂量统一为 e-/Å²。 */
export function normalizeDose(input: Quantity): Quantity | null {
  if (input.unit === 'e-/Å²') return { value: input.value, unit: 'e-/Å²' };
  if (input.unit === 'e-/nm²') return { value: input.value / 100, unit: 'e-/Å²' };
  return null;
}

/** 派生层规范化：坐标统一为 pixel/top-left。specimen 基准缺少校准，返回 null。 */
export function normalizeCoord(
  input: Coord2,
  image: { width: number; height: number }
): Coord2 | null {
  if (input.basis !== 'pixel') return null;
  if (input.origin === 'top-left') return input;
  return {
    x: input.x + image.width / 2,
    y: input.y + image.height / 2,
    basis: 'pixel',
    origin: 'top-left'
  };
}

/** 稳定序列化（键排序），用于内容摘要与有效点集哈希。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(obj[key]))
      .join(',') +
    '}'
  );
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** 反例档案覆盖的七种情形。 */
export const SCENARIOS = [
  'axis-eccentricity',
  'trajectory-identity-swap',
  'missing-high-tilt',
  'bad-frame-exclusion',
  'local-deform-overfit',
  'multiple-solutions',
  'concurrent-freeze'
] as const;
export type ScenarioKind = (typeof SCENARIOS)[number];

/** 三条判断依据，以机器可读事件落库。 */
export const RULES = {
  AXIS_NOT_CENTER: 'rule.axis-not-fixed-at-image-center',
  TRAJECTORY_FRAGILE: 'rule.fiducial-trajectory-may-break-or-swap',
  SAME_POINT_SET: 'rule.compare-candidates-on-same-effective-point-set'
} as const;

export const ENTITY_KIND_LABELS: Record<string, string> = {
  'tilt-series': '倾转序列',
  'raw-frame': '原始帧',
  'fiducial-trajectory': 'fiducial 轨迹',
  'track-gap': '跟踪缺口',
  'manual-exclusion': '手工排除原因',
  'tilt-axis': '倾转轴',
  'alignment-candidate': '配准候选',
  'scenario-input': '反例输入',
  'counterexample-archive': '反例档案'
};
