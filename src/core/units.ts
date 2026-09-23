/**
 * 单位 / 坐标基准。
 * 导入层保留原始表示；只有派生层做规范化。
 * 无法转换的值留在原位置并附诊断，绝不为了画图而丢弃。
 */
import type { Measured } from "./types.js";

/** 角度归一化到度。 */
export function normalizeAngle(raw: string | number, unit: string): Measured<number> {
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed)) {
    return { raw, normalized: null, unit, basis: "stage", diagnostic: `无法把倾角解析为数字: ${JSON.stringify(raw)}` };
  }
  const u = unit.trim().toLowerCase();
  if (u === "degree" || u === "deg" || u === "°") return { raw, normalized: parsed, unit, basis: "stage" };
  if (u === "radian" || u === "rad") return { raw, normalized: (parsed * 180) / Math.PI, unit, basis: "stage" };
  return { raw, normalized: null, unit, basis: "stage", diagnostic: `未知角度单位: ${unit}` };
}

/** 像素尺度归一化到 nm/px。 */
export function normalizePixelScale(raw: string | number, unit: string): Measured<number> {
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed)) {
    return { raw, normalized: null, unit, basis: "image", diagnostic: `无法把像素尺度解析为数字: ${JSON.stringify(raw)}` };
  }
  const u = unit.trim().toLowerCase();
  if (u === "nm/px" || u === "nm/pixel" || u === "nm") return { raw, normalized: parsed, unit, basis: "image" };
  if (u === "å/px" || u === "angstrom/px" || u === "å") return { raw, normalized: parsed / 10, unit, basis: "image" };
  if (u === "µm/px" || u === "um/px") return { raw, normalized: parsed * 1000, unit, basis: "image" };
  return { raw, normalized: null, unit, basis: "image", diagnostic: `无法转换的像素尺度单位: ${unit}` };
}

/** 剂量归一化到 e-/Å^2。 */
export function normalizeDose(raw: string | number, unit: string): Measured<number> {
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed)) {
    return { raw, normalized: null, unit, basis: "frame", diagnostic: `无法把剂量解析为数字: ${JSON.stringify(raw)}` };
  }
  const u = unit.trim().toLowerCase();
  if (u === "e-/å^2" || u === "e/angstrom^2" || u === "e-/a^2" || u === "e/a^2") {
    return { raw, normalized: parsed, unit, basis: "frame" };
  }
  if (u === "e-/nm^2" || u === "e/nm^2") return { raw, normalized: parsed / 100, unit, basis: "frame" };
  return { raw, normalized: null, unit, basis: "frame", diagnostic: `无法转换的剂量单位: ${unit}` };
}

/** 像素坐标：始终保留像素原值，坐标基准显式。 */
export function pixelCoord(raw: string | number, axis: "x" | "y", basis = "image_origin_topleft"): Measured<number> {
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed)) {
    return { raw, normalized: null, unit: "px", basis, diagnostic: `无法把 ${axis} 坐标解析为数字: ${JSON.stringify(raw)}` };
  }
  return { raw, normalized: parsed, unit: "px", basis };
}

export function pxToNm(px: number, nmPerPx: number | null): number {
  return nmPerPx == null ? NaN : px * nmPerPx;
}
