import type {
  Angle,
  Diagnostic,
  DoseUnit,
  DoseValue,
  Length,
  LengthUnit
} from "./types.js";

/**
 * 派生层规范化：只在派生时换算；原始表示留在输入实体里。
 * 无法转换的值返回 undefined 并把诊断留在原位置（不丢值、不静默）。
 */

export function angleToDegrees(angle: Angle): number | undefined {
  if (Number.isNaN(angle.value) || !Number.isFinite(angle.value)) {
    return undefined;
  }
  if (angle.unit === "degree") return angle.value;
  if (angle.unit === "radian") return (angle.value * 180) / Math.PI;
  return undefined;
}

export function lengthToPixels(
  length: Length,
  scaleNmPerPixel?: number
): number | undefined {
  if (length.unit === "pixel") return length.value;
  if (scaleNmPerPixel === undefined) return undefined;
  if (length.unit === "nm") return length.value / scaleNmPerPixel;
  if (length.unit === "um") return (length.value * 1000) / scaleNmPerPixel;
  return undefined;
}

export function pixelsToNm(px: number, scaleNmPerPixel?: number): number | undefined {
  return scaleNmPerPixel === undefined ? undefined : px * scaleNmPerPixel;
}

const DOSE_TO_E_PER_A2: Record<DoseUnit, number> = {
  "e-/A^2": 1,
  "e-/nm^2": 1 / 100, // 1 nm^2 = 100 A^2
  counts: NaN // 无标定，不可转换
};

export function doseToEPerA2(dose: DoseValue): number | undefined {
  const factor = DOSE_TO_E_PER_A2[dose.unit];
  if (Number.isNaN(factor)) return undefined;
  return dose.value * factor;
}

export function diagnostic(
  code: string,
  message: string,
  severity: Diagnostic["severity"] = "error",
  extra?: { atFrameId?: string; atObservationId?: string }
): Diagnostic {
  return { code, severity, message, ...extra };
}

export function lengthUnitLabel(u: LengthUnit): string {
  return u;
}
