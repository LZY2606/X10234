/**
 * 领域量：始终携带单位或坐标基准。
 * 导入时保留原始表示（raw），派生层才做规范化（canonical）。
 * 无法转换的值留在原位置并附诊断（ConversionDiagnostic），绝不为画图而丢弃。
 */

export type Unit =
  | 'degree'
  | 'radian'
  | 'nm/px'
  | 'angstrom/px'
  | 'e-/A^2'
  | 'e-/nm^2'
  | 'px'
  | 'pixel-fraction'
  | 'frame-index';

export interface Quantity {
  value: number;
  unit: Unit;
  rawText?: string;
  basis: CoordinateBasis | null;
}

export interface CoordinateBasis {
  frame: FrameId;
  origin: 'top-left' | 'tilt-axis-normal';
  axes: { x: 'right'; y: 'down' };
}

export interface PixelCoord {
  x: number;
  y: number;
  unit: 'px';
  basis: CoordinateBasis;
  rawText?: string;
}

export interface ConversionDiagnostic {
  code:
    | 'UNPARSEABLE_QUANTITY'
    | 'UNKNOWN_UNIT'
    | 'NON_FINITE'
    | 'UNIT_MISMATCH';
  message: string;
  rawText: string;
  targetUnit: string;
}

export interface MaybeConverted {
  quantity: Quantity;
  canonicalValue: number | null;
  diagnostic: ConversionDiagnostic | null;
}

export type FrameId = string;
export type TiltId = string;
export type PixelScaleId = string;
export type DoseId = string;
export type TrackId = string;
export type ObservationId = string;
export type GapId = string;
export type ExclusionId = string;

const TO_CANONICAL: Partial<Record<Unit, (v: number) => number>> = {
  degree: (v) => v,
  radian: (v) => (v * 180) / Math.PI,
  'nm/px': (v) => v,
  'angstrom/px': (v) => v / 10,
  'e-/A^2': (v) => v,
  'e-/nm^2': (v) => v / 100,
  px: (v) => v,
  'pixel-fraction': (v) => v,
  'frame-index': (v) => v,
};

export const CANONICAL_UNIT: Partial<Record<Unit, Unit>> = {
  degree: 'degree',
  radian: 'degree',
  'nm/px': 'nm/px',
  'angstrom/px': 'nm/px',
  'e-/A^2': 'e-/A^2',
  'e-/nm^2': 'e-/A^2',
  px: 'px',
  'pixel-fraction': 'pixel-fraction',
  'frame-index': 'frame-index',
};

const UNIT_ALIASES: Record<string, Unit> = {
  deg: 'degree',
  degree: 'degree',
  degrees: 'degree',
  '°': 'degree',
  rad: 'radian',
  radian: 'radian',
  radians: 'radian',
  'nm/px': 'nm/px',
  'nm/pixel': 'nm/px',
  'angstrom/px': 'angstrom/px',
  'a/px': 'angstrom/px',
  'å/px': 'angstrom/px',
  'e-/a^2': 'e-/A^2',
  'e/a^2': 'e-/A^2',
  'e-/nm^2': 'e-/nm^2',
  'e/nm^2': 'e-/nm^2',
  px: 'px',
  pixel: 'px',
  pixels: 'px',
};

export function normalizeUnitText(text: string): string {
  return text.trim().toLowerCase().replace('Å'.toLowerCase(), 'å');
}

export function parseQuantity(
  rawText: string,
  fallbackUnit: Unit,
  basis: CoordinateBasis | null = null,
): MaybeConverted {
  const text = rawText.trim();
  const m = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/);
  if (!m) {
    return {
      quantity: { value: NaN, unit: fallbackUnit, rawText, basis },
      canonicalValue: null,
      diagnostic: {
        code: 'UNPARSEABLE_QUANTITY',
        message: `无法解析为数值: "${rawText}"`,
        rawText,
        targetUnit: fallbackUnit,
      },
    };
  }
  const value = Number(m[1]);
  const unitText = (m[2] ?? '').trim();
  let unit = fallbackUnit;
  let diagnostic: ConversionDiagnostic | null = null;
  if (unitText) {
    const resolved = UNIT_ALIASES[normalizeUnitText(unitText)];
    if (!resolved) {
      diagnostic = {
        code: 'UNKNOWN_UNIT',
        message: `未知单位: "${unitText}"，原始值保留在原位置`,
        rawText,
        targetUnit: fallbackUnit,
      };
      unit = fallbackUnit;
    } else {
      unit = resolved;
    }
  }
  if (!Number.isFinite(value)) {
    diagnostic = {
      code: 'NON_FINITE',
      message: `数值非有限: "${rawText}"`,
      rawText,
      targetUnit: fallbackUnit,
    };
  }
  const conv = TO_CANONICAL[unit];
  const canonicalValue = diagnostic || !conv ? null : conv(value);
  return {
    quantity: { value, unit, rawText, basis },
    canonicalValue,
    diagnostic,
  };
}

export function toCanonical(q: Quantity): number | null {
  const conv = TO_CANONICAL[q.unit];
  if (!conv || !Number.isFinite(q.value)) return null;
  return conv(q.value);
}

export function canonicalUnitFor(u: Unit): Unit {
  return CANONICAL_UNIT[u] ?? u;
}
