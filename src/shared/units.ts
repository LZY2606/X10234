import type {
  Angle, AngleUnit, Dose, DoseUnit, Length, LengthUnit,
  PixelScale, PixelScaleUnit, ConversionDiagnostic,
} from './types.ts';

function parseNumber(raw: string): number | undefined {
  const match = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(raw.trim());
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function diag(code: ConversionDiagnostic['code'], raw: string, message: string): ConversionDiagnostic {
  return { code, rawRepresentation: raw, message };
}

export function normalizeAngle(raw: string, unit: AngleUnit): Angle {
  const num = parseNumber(raw);
  if (num === undefined) {
    return { raw, unit, conversionDiagnostic: diag('UNPARSEABLE_NUMBER', raw, '角度无法解析，保留原位不参与计算') };
  }
  if (unit === 'unknown') {
    return { raw, unit, conversionDiagnostic: diag('UNCONVERTIBLE_UNIT', raw, '角度单位未知，保留原始表示') };
  }
  return { raw, unit, normalizedDeg: unit === 'rad' ? (num * 180) / Math.PI : num };
}

const LENGTH_TO_NM: Record<LengthUnit, number | undefined> = {
  nm: 1, um: 1000, A: 0.1, pixel: undefined, unknown: undefined,
};

export function normalizeLength(raw: string, unit: LengthUnit, pxToNm?: number): Length {
  const num = parseNumber(raw);
  if (num === undefined) {
    return { raw, unit, conversionDiagnostic: diag('UNPARSEABLE_NUMBER', raw, '长度无法解析') };
  }
  if (unit === 'pixel') {
    if (pxToNm === undefined) {
      return {
        raw, unit, basis: 'frame_pixel_xy',
        conversionDiagnostic: diag('UNCONVERTIBLE_UNIT', raw, '像素到纳米缺少像素尺度，像素坐标保留原位'),
      };
    }
    return { raw, unit, basis: 'frame_pixel_xy', normalizedNm: num * pxToNm };
  }
  const factor = LENGTH_TO_NM[unit];
  if (factor === undefined) {
    return { raw, unit, conversionDiagnostic: diag('UNCONVERTIBLE_UNIT', raw, '长度单位无法转换，原值保留') };
  }
  return { raw, unit, normalizedNm: num * factor };
}

const SCALE_TO_NM_PER_PX: Record<PixelScaleUnit, number | undefined> = {
  nm_per_px: 1, A_per_px: 0.1, um_per_px: 1000, unknown: undefined,
};

export function normalizePixelScale(raw: string, unit: PixelScaleUnit): PixelScale {
  const num = parseNumber(raw);
  if (num === undefined) {
    return { raw, unit, conversionDiagnostic: diag('UNPARSEABLE_NUMBER', raw, '像素尺度无法解析') };
  }
  const factor = SCALE_TO_NM_PER_PX[unit];
  if (factor === undefined) {
    return { raw, unit, conversionDiagnostic: diag('UNCONVERTIBLE_UNIT', raw, '像素尺度单位无法转换') };
  }
  return { raw, unit, normalizedNmPerPx: num * factor };
}

const DOSE_TO_E_PER_NM2: Record<DoseUnit, number | undefined> = {
  e_per_nm2: 1, e_per_A2: 100, unknown: undefined,
};

export function normalizeDose(raw: string, unit: DoseUnit): Dose {
  const num = parseNumber(raw);
  if (num === undefined) {
    return { raw, unit, conversionDiagnostic: diag('UNPARSEABLE_NUMBER', raw, '剂量无法解析') };
  }
  const factor = DOSE_TO_E_PER_NM2[unit];
  if (factor === undefined) {
    return { raw, unit, conversionDiagnostic: diag('UNCONVERTIBLE_UNIT', raw, '剂量单位无法转换') };
  }
  return { raw, unit, normalizedEPerNm2: num * factor };
}

export function hasDiagnostic(value: { conversionDiagnostic?: ConversionDiagnostic }): boolean {
  return Boolean(value.conversionDiagnostic);
}
