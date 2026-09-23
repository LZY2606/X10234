import type {
  AngleMeasure,
  AngleUnit,
  DoseMeasure,
  DoseUnit,
  LengthMeasure,
  LengthUnit,
  ValueDiagnostic,
} from "./types.js";

/**
 * 单位规范化只发生在派生层。原始表示 (rawValue/rawUnit) 永远保留；
 * 无法转换时 normalized*=null 并追加诊断，值留在原位。
 */

export function makeAngle(
  rawValue: number,
  rawUnit: AngleUnit,
  at: string,
  diags: ValueDiagnostic[],
): AngleMeasure {
  if (!Number.isFinite(rawValue)) {
    diags.push({
      code: "VALUE_MISSING",
      severity: "error",
      message: `倾转角不是有限数值，保留原始表示`,
      at,
    });
    return { rawValue, rawUnit, normalizedDeg: null };
  }
  const normalizedDeg = rawUnit === "degree" ? rawValue : (rawValue * 180) / Math.PI;
  return { rawValue, rawUnit, normalizedDeg };
}

export function makeLength(
  rawValue: number,
  rawUnit: LengthUnit,
  at: string,
  diags: ValueDiagnostic[],
): LengthMeasure {
  // pixel 单位无法在没有额外物理标尺时换算成 nm/pixel；保留原位。
  if (rawUnit === "pixel") {
    diags.push({
      code: "PIXELSCALE_UNRESOLVABLE",
      severity: "warning",
      message: `像素尺度以 pixel 给出，无法规范化为 nm/pixel；原值保留`,
      at,
    });
    return { rawValue, rawUnit, normalizedNmPerPx: null };
  }
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    diags.push({
      code: "VALUE_OUT_OF_RANGE",
      severity: "error",
      message: `像素尺度必须为正有限值，得到 ${rawValue}`,
      at,
    });
    return { rawValue, rawUnit, normalizedNmPerPx: null };
  }
  // rawValue 以 nm/pixel 语义存储（microscope 像元尺寸）
  const normalizedNmPerPx = rawUnit === "nm" ? rawValue : rawValue * 1000;
  return { rawValue, rawUnit, normalizedNmPerPx };
}

export function makeDose(
  rawValue: number,
  rawUnit: DoseUnit,
  at: string,
  diags: ValueDiagnostic[],
): DoseMeasure {
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    diags.push({
      code: "DOSE_NONPOSITIVE",
      severity: "error",
      message: `曝光剂量必须为正有限值，得到 ${rawValue}`,
      at,
    });
    return { rawValue, rawUnit, normalizedEPerA2: null };
  }
  // 1 nm^2 = 100 A^2 => e-/nm^2 / 100 = e-/A^2
  const normalizedEPerA2 = rawUnit === "e-/A^2" ? rawValue : rawValue / 100;
  return { rawValue, rawUnit, normalizedEPerA2 };
}

/** 未知单位字符串：保留为原值（这里调用方负责不丢弃），返回是否受支持 */
export function isKnownAngleUnit(u: string): u is AngleUnit {
  return u === "degree" || u === "radian";
}
export function isKnownLengthUnit(u: string): u is LengthUnit {
  return u === "nm" || u === "um" || u === "pixel";
}
export function isKnownDoseUnit(u: string): u is DoseUnit {
  return u === "e-/A^2" || u === "e-/nm^2";
}
