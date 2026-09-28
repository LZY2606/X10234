import type { QuantifiedValue } from "./types.ts";

/**
 * 单位/坐标基准处理：导入层只解析，不丢原值。
 * 无法转换的值 value=null 且带 diagnostic，留在原位置。
 */
export function quantified(raw: string, unit: string, targetUnit: string): QuantifiedValue {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return { raw, unit, targetUnit, value: null, diagnostic: `unparseable-number: ${raw}` };
  }
  const normalized = convertUnit(value, unit, targetUnit);
  if (normalized === null) {
    return { raw, unit, targetUnit, value: null, diagnostic: `no-conversion: ${unit} -> ${targetUnit}` };
  }
  return { raw, value: normalized, unit, targetUnit };
}

const ANGLE_TO_RAD: Record<string, number> = {
  degree: Math.PI / 180,
  degrees: Math.PI / 180,
  deg: Math.PI / 180,
  radian: 1,
  radians: 1,
  rad: 1,
};

const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  um: 1000,
  "µm": 1000,
  micron: 1000,
  A: 0.1,
  angstrom: 0.1,
  "e/A^2": 1,
};

export function convertUnit(value: number, unit: string, target: string): number | null {
  if (unit === target) return value;
  if (ANGLE_TO_RAD[target] !== undefined && ANGLE_TO_RAD[unit] !== undefined) {
    return (value * ANGLE_TO_RAD[unit]!) / ANGLE_TO_RAD[target]!;
  }
  if (target === "nm" && LENGTH_TO_NM[unit] !== undefined) return value * LENGTH_TO_NM[unit]!;
  if (target === "e/A^2") {
    if (unit === "e/A^2" || unit === "e-/A^2" || unit === "electrons/A^2") return value;
  }
  return null;
}

export function degrees(raw: string): QuantifiedValue {
  return quantified(raw, "degree", "radian");
}
export function nmPerPixel(raw: string, unit = "nm"): QuantifiedValue {
  return quantified(raw, unit, "nm");
}
export function dose(raw: string, unit = "e/A^2"): QuantifiedValue {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return { raw, unit, targetUnit: "e/A^2", value: null, diagnostic: `unparseable-number: ${raw}` };
  }
  if (unit !== "e/A^2" && unit !== "e-/A^2" && unit !== "electrons/A^2") {
    return { raw, unit, targetUnit: "e/A^2", value: null, diagnostic: `no-conversion: ${unit} -> e/A^2` };
  }
  return { raw, value, unit, targetUnit: "e/A^2" };
}
