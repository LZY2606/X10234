import type { CoordinateBasis, DomainQuantity } from '../shared/types';

/**
 * 导入层：保留原始表示，只在可安全转换时给出规范化数值。
 * 无法转换的值留在原位置（raw）并附诊断，绝不为了画图而丢弃。
 */
export function quantity(raw: unknown, expectedUnit: string): DomainQuantity {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { raw: String(raw), value: raw, unit: expectedUnit };
  }
  const text = String(raw ?? '').trim();
  if (text === '') {
    return { raw: text, value: null, unit: expectedUnit, diagnostics: ['EMPTY_VALUE'] };
  }
  const parsed = parseFloat(text.replace(',', '.'));
  if (!Number.isFinite(parsed)) {
    return { raw: text, value: null, unit: expectedUnit, diagnostics: ['UNPARSEABLE_VALUE'] };
  }
  const detectedUnit = detectUnit(text);
  if (detectedUnit && detectedUnit !== expectedUnit) {
    const converted = convertUnit(parsed, detectedUnit, expectedUnit);
    if (converted === null) {
      return {
        raw: text,
        value: null,
        unit: expectedUnit,
        diagnostics: [`INCOMPATIBLE_UNIT:${detectedUnit}->${expectedUnit}`],
      };
    }
    return { raw: text, value: converted, unit: expectedUnit };
  }
  return { raw: text, value: parsed, unit: expectedUnit };
}

function detectUnit(text: string): string | null {
  const t = text.toLowerCase();
  if (/deg|°/.test(t)) return 'degree';
  if (/rad/.test(t)) return 'radian';
  if (/nm\/?pix|nm\/pixel/.test(t)) return 'nm_per_pixel';
  if (/angstrom\/?pix|a\/pix|Å\/pix/.test(t)) return 'angstrom_per_pixel';
  if (/e[- ]?\/[- ]?[aÅÅ]|electron/.test(t)) return 'electrons_per_angstrom_squared';
  if (/px|pixel/.test(t)) return 'pixel';
  return null;
}

const CONVERSIONS: Record<string, Record<string, (v: number) => number>> = {
  radian: { degree: (v) => (v * 180) / Math.PI },
  degree: { radian: (v) => (v * Math.PI) / 180 },
  angstrom_per_pixel: { nm_per_pixel: (v) => v / 10 },
};

function convertUnit(v: number, from: string, to: string): number | null {
  return CONVERSIONS[from]?.[to]?.(v) ?? null;
}

export const PIXEL_BASIS: CoordinateBasis = {
  name: 'image_pixel_topleft',
  origin: 'top_left',
  unit: 'pixel',
};

export function requireValue(q: DomainQuantity, label: string): number {
  if (q.value === null) throw new Error(`${label} 无法规范化: ${q.diagnostics?.join(',') ?? 'unknown'}`);
  return q.value;
}
