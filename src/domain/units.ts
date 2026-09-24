import type { Diagnostic, Measured } from "./types.ts";

function diag(code: string, message: string, severity: Diagnostic["severity"] = "warning"): Diagnostic {
  return { code, message, severity };
}

/** 角度：原始表示保留，派生层规范化为 deg */
export function parseAngle(raw: string, unit: "deg" | "rad" = "deg"): Measured<"deg" | "rad"> {
  const text = raw.trim();
  const num = Number(text);
  if (!Number.isFinite(num)) {
    return { raw, unit: "unknown", value: null, diagnostics: [diag("angle.unparseable", `倾角「${raw}」无法转换，保留在原位置`, "error")] };
  }
  const value = unit === "rad" ? (num * 180) / Math.PI : num;
  return { raw, unit, value: num, normalized: { value, unit: "deg" }, diagnostics: [] };
}

export function parsePixelScale(raw: string, unit: "nm/px" | "um/px" | "A/px" = "nm/px"): Measured<"nm/px" | "um/px" | "A/px"> {
  const num = Number(raw.trim());
  if (!Number.isFinite(num) || num <= 0) {
    return { raw, unit: "unknown", value: null, diagnostics: [diag("pixel-scale.invalid", `像素尺度「${raw}」无法转换，原始表示保留`, "error")] };
  }
  const factor = unit === "um/px" ? 1000 : unit === "A/px" ? 0.1 : 1;
  return { raw, unit, value: num, normalized: { value: num * factor, unit: "nm/px" }, diagnostics: [] };
}

export function parseDose(raw: string, unit: "e-/A^2" | "e-/nm^2" | "e-/A^2/frame" = "e-/A^2"): Measured<string> {
  const num = Number(raw.trim());
  if (!Number.isFinite(num) || num < 0) {
    return { raw, unit: "unknown", value: null, diagnostics: [diag("dose.unconvertible", `剂量「${raw}」无法转换，不删除、不画图替代`, "error")] };
  }
  const factor = unit === "e-/nm^2" ? 0.01 : 1; // 1 e-/nm^2 = 0.01 e-/A^2
  return { raw, unit, value: num, normalized: { value: num * factor, unit: "e-/A^2" }, diagnostics: [] };
}

export function parsePixelCoord(raw: string): Measured<"px"> {
  const num = Number(raw.trim());
  if (!Number.isFinite(num)) {
    return { raw, unit: "unknown", value: null, diagnostics: [diag("coord.unparseable", `坐标「${raw}」无法转换，保留原位`, "error")] };
  }
  return { raw, unit: "px", value: num, normalized: { value: num, unit: "px" }, diagnostics: [] };
}

export function parseEnum<U extends string>(raw: string, allowed: readonly U[]): Measured<U> {
  const text = raw.trim() as U;
  if (!allowed.includes(text)) {
    return { raw, unit: "unknown", value: null, diagnostics: [diag("enum.unknown", `值「${raw}」不在 {${allowed.join("|")}}，保留原位`, "warning")] };
  }
  return { raw, unit: text, value: text, normalized: { value: text, unit: "code" }, diagnostics: [] };
}
