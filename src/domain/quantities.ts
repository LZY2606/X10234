import type { Diagnostic, SourceValue, Unit } from "./types.ts";

/** 领域量解析：保留原始表示，派生层才规范化；无法转换的值留在原位置并附诊断。 */

const UNIT_ALIASES: Record<string, Unit> = {
  deg: "degree",
  degree: "degree",
  degrees: "degree",
  rad: "radian",
  radian: "radian",
  px: "pixel",
  pixel: "pixel",
  nm: "nanometer",
  nanometer: "nanometer",
  A: "angstrom",
  angstrom: "angstrom",
  "e/A2": "e_per_angstrom_sq",
  "e-/A^2": "e_per_angstrom_sq",
  "e/nm2": "e_per_nm_sq",
  "e-/nm^2": "e_per_nm_sq",
  s: "second",
  sec: "second"
};

export function parseNumberWithUnit(
  raw: string,
  expectedKinds: Unit[],
  basis: string
): SourceValue<{ value: number; unit: Unit }> {
  const diagnostics: Diagnostic[] = [];
  const trimmed = raw.trim();
  const match = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(.*)$/.exec(trimmed);
  if (!match) {
    diagnostics.push({
      code: "quantity.unparseable",
      severity: "error",
      message: `无法解析数值: "${raw}"`
    });
    return { raw, unit: "", basis, parsed: null, diagnostics };
  }
  const value = Number(match[1]);
  const unitToken = (match[2] ?? "").trim();
  const unit = UNIT_ALIASES[unitToken];
  if (!unit) {
    diagnostics.push({
      code: "quantity.unknown-unit",
      severity: "error",
      message: `未知单位 "${unitToken}"，原值保留在原地，不做规范化`
    });
    return { raw, unit: unitToken, basis, parsed: null, diagnostics };
  }
  if (!expectedKinds.includes(unit)) {
    diagnostics.push({
      code: "quantity.unit-mismatch",
      severity: "error",
      message: `单位 "${unitToken}" 不在期望集合 ${expectedKinds.join("/")} 内`
    });
    return { raw, unit: unitToken, basis, parsed: null, diagnostics };
  }
  return { raw, unit: unitToken, basis, parsed: { value, unit }, diagnostics };
}

export function parseTiltAngle(raw: string): SourceValue<{ degrees: number }> {
  const parsed = parseNumberWithUnit(raw, ["degree", "radian"], "tilt-axis-rotation");
  if (!parsed.parsed) {
    return { raw, unit: parsed.unit, basis: parsed.basis, parsed: null, diagnostics: parsed.diagnostics };
  }
  const degrees = parsed.parsed.unit === "radian" ? (parsed.parsed.value * 180) / Math.PI : parsed.parsed.value;
  return { raw, unit: parsed.unit, basis: parsed.basis, parsed: { degrees }, diagnostics: parsed.diagnostics };
}

export function parsePixelScale(raw: string): SourceValue<{ pixelSize: number; unit: Unit }> {
  const parsed = parseNumberWithUnit(raw, ["nanometer", "angstrom"], "specimen-plane");
  if (!parsed.parsed) {
    return { raw, unit: parsed.unit, basis: parsed.basis, parsed: null, diagnostics: parsed.diagnostics };
  }
  return {
    raw,
    unit: parsed.unit,
    basis: parsed.basis,
    parsed: { pixelSize: parsed.parsed.value, unit: parsed.parsed.unit },
    diagnostics: parsed.diagnostics
  };
}

export function parseDose(raw: string): SourceValue<{ electronsPerArea: number; areaUnit: "angstrom^2" | "nm^2" }> {
  const parsed = parseNumberWithUnit(raw, ["e_per_angstrom_sq", "e_per_nm_sq"], "specimen-plane");
  if (!parsed.parsed) {
    return { raw, unit: parsed.unit, basis: parsed.basis, parsed: null, diagnostics: parsed.diagnostics };
  }
  return {
    raw,
    unit: parsed.unit,
    basis: parsed.basis,
    parsed: {
      electronsPerArea: parsed.parsed.value,
      areaUnit: parsed.parsed.unit === "e_per_angstrom_sq" ? "angstrom^2" : "nm^2"
    },
    diagnostics: parsed.diagnostics
  };
}

/** 派生层规范化：剂量统一为 e/Å²，像素尺度统一为 Å。仅用于显示与比较，不回写来源。 */
export function normalizeDoseToEPerA2(dose: SourceValue<{ electronsPerArea: number; areaUnit: "angstrom^2" | "nm^2" }>): number | null {
  if (!dose.parsed) return null;
  return dose.parsed.areaUnit === "angstrom^2" ? dose.parsed.electronsPerArea : dose.parsed.electronsPerArea / 100;
}

export function normalizePixelScaleToAngstrom(scale: SourceValue<{ pixelSize: number; unit: Unit }>): number | null {
  if (!scale.parsed) return null;
  return scale.parsed.unit === "angstrom" ? scale.parsed.pixelSize : scale.parsed.pixelSize * 10;
}
