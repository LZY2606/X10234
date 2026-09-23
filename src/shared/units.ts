import type { CanonicalQuantity, ConversionDiagnostic, RawQuantity } from './domain';

/**
 * 规范化只发生在派生层。原始表示在导入时原样保留；
 * 无法转换的值留在原位置并附诊断，不能为了画图而丢掉。
 */
export function normalizeQuantity(raw: RawQuantity, target: CanonicalQuantity['canonicalUnit']):
  { ok: true; value: CanonicalQuantity } | { ok: false; diagnostic: ConversionDiagnostic } {
  const v = raw.value;
  if (!Number.isFinite(v)) {
    return { ok: false, diagnostic: { code: 'VALUE_MISSING', message: `数值缺失或非有限: ${String(v)}`, keptRaw: raw } };
  }
  const from = raw.unit;
  const conv = (factor: number, unit: CanonicalQuantity['canonicalUnit']): CanonicalQuantity => ({ value: v * factor, canonicalUnit: unit });
  switch (target) {
    case 'nm':
      if (from === 'nm') return { ok: true, value: conv(1, 'nm') };
      if (from === 'A') return { ok: true, value: conv(0.1, 'nm') };
      if (from === 'px') return { ok: true, value: conv(1, 'nm') }; // px 由调用方乘像素尺度
      break;
    case 'deg':
      if (from === 'deg') return { ok: true, value: conv(1, 'deg') };
      if (from === 'rad') return { ok: true, value: conv(180 / Math.PI, 'deg') };
      break;
    case 'e-/A2':
      if (from === 'e-/A2') return { ok: true, value: conv(1, 'e-/A2') };
      if (from === 'e-/nm2') return { ok: true, value: conv(0.01, 'e-/A2') };
      break;
    case 'px':
      if (from === 'px') return { ok: true, value: conv(1, 'px') };
      break;
    case 'dimensionless':
      if (from === 'dimensionless' || from === 'count') return { ok: true, value: conv(1, 'dimensionless') };
      break;
  }
  return {
    ok: false,
    diagnostic: {
      code: 'UNIT_UNCONVERTIBLE',
      message: `单位 ${from} 无法转换为 ${target}，原值保留在原位置`,
      keptRaw: raw,
    },
  };
}

export function pxToNm(px: number, pixelSizeNm: number): number {
  return px * pixelSizeNm;
}
