import type { UnitMeasure } from './types.js';

/**
 * 单位处理：导入时保留原始表示；只在派生层做规范化。
 * 无法转换的值留在原位置并附诊断，绝不为画图而丢弃。
 */

export function makeMeasure(raw: string, unit: string, basis: string, value: number | null, diagnostics?: string[]): UnitMeasure {
  return { raw, value, unit, basis, diagnostics };
}

const ANGLE_TO_DEG: Record<string, number> = {
  deg: 1,
  degree: 1,
  degrees: 1,
  '°': 1,
  rad: 180 / Math.PI,
  radian: 180 / Math.PI,
};

const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  'nm/px': 1,
  um: 1000,
  'μm': 1000,
  angstrom: 0.1,
  Å: 0.1,
  A: 0.1,
};

/** 剂量规范：e-/angstrom^2。接受常见写法；无法换算则保留 + 诊断。 */
export function parseAngle(raw: string, basis = 'stage'): UnitMeasure {
  const r = raw.trim();
  const m = r.match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(°|deg(?:ree)?s?|rad(?:ian)?s?)?$/i);
  if (!m) return makeMeasure(r, 'deg', basis, null, [`unparseable-angle: ${r}`]);
  const num = Number(m[1]);
  const u = (m[2] ?? 'deg').toLowerCase();
  const factor = ANGLE_TO_DEG[u] ?? ANGLE_TO_DEG[m[2] ?? 'deg'];
  if (factor === undefined) return makeMeasure(r, 'deg', basis, null, [`unknown-angle-unit: ${m[2]}`]);
  return makeMeasure(r, 'deg', basis, num * factor);
}

export function parsePixelScale(raw: string, basis = 'image-x'): UnitMeasure {
  const m = raw.trim().match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*(\/px|\/pixel)?\s*(nm|um|μm|angstrom|Å|A)?$/i);
  if (!m) return makeMeasure(raw, 'nm/pixel', basis, null, [`unparseable-pixel-scale: ${raw}`]);
  const num = Number(m[1]);
  const u = (m[3] ?? 'nm').toLowerCase();
  const f = LENGTH_TO_NM[u];
  if (f === undefined) return makeMeasure(raw, 'nm/pixel', basis, null, [`unknown-length-unit: ${m[3]}`]);
  return makeMeasure(raw, 'nm/pixel', basis, num * f);
}

export function parseDose(raw: string, basis = 'cumulative'): UnitMeasure {
  const r = raw.trim();
  // e-/Å^2, e-/A^2, e-/angstrom^2
  let m = r.match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*e-?\s*\/?\s*(Å|A|angstrom|\^?2|\s)+$/i);
  if (m) return makeMeasure(r, 'e-/angstrom^2', basis, Number(m[1]));
  m = r.match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*e\^?-?\s*\/?\s*(?:Å|A|angstrom)\^?2$/i);
  if (m) return makeMeasure(r, 'e-/angstrom^2', basis, Number(m[1]));
  // e-/nm^2 -> *100
  m = r.match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*e-?\/?\s*nm\^?2$/i);
  if (m) return makeMeasure(r, 'e-/angstrom^2', basis, Number(m[1]) * 100);
  return makeMeasure(r, 'e-/angstrom^2', basis, null, [`unparseable-dose: ${r}`]);
}

/** 派生层统一取规范值；若有诊断且 value 为 null，调用方必须显式处理。 */
export function requireValue(m: UnitMeasure, context: string): number {
  if (m.value === null || Number.isNaN(m.value)) {
    throw new Error(`missing-convertible-value at ${context}: ${m.raw} (${(m.diagnostics ?? []).join('; ')})`);
  }
  return m.value;
}
