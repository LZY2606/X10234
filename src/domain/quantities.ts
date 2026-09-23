/**
 * 领域量（domain quantities）
 *
 * 所有物理量都携带单位与坐标基准；导入时保留原始表示（raw），
 * 只有派生层才做规范化。无法转换的值保留在原位置并附诊断，
 * 绝不允许为了画图而丢弃。
 */

export type AngleUnit = 'deg' | 'rad';
export type LengthUnit = 'px' | 'nm' | 'A';
export type DoseUnit = 'e/A^2' | 'e/nm^2';

export interface Quantity<V = number> {
  /** 规范化后的值；无法转换时为 null，值仍保留在 raw 中 */
  readonly value: V | null;
  /** 规范化单位（派生层使用） */
  readonly unit: string;
  /** 导入时的原始表示，永不改写 */
  readonly raw: string;
  /** 原始单位 */
  readonly rawUnit: string;
  /** 是否可以规范化；false 时 value=null 并带诊断 */
  readonly convertible: boolean;
  /** 坐标基准 / 测量基准，例如 'image-top-left' | 'microscope-stage' */
  readonly basis: string;
  /** 无法转换等问题的诊断 */
  readonly diagnostic?: string;
}

export function quantity(
  raw: string | number,
  rawUnit: string,
  canonicalUnit: string,
  basis: string,
  convert?: (v: number) => number,
): Quantity {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    return {
      value: null,
      unit: canonicalUnit,
      raw: String(raw),
      rawUnit,
      convertible: false,
      basis,
      diagnostic: `unparseable quantity '${raw}' (unit ${rawUnit}); kept in place`,
    };
  }
  if (!convert) {
    return { value: parsed, unit: rawUnit || canonicalUnit, raw: String(raw), rawUnit, convertible: true, basis };
  }
  try {
    const v = convert(parsed);
    if (!Number.isFinite(v)) throw new Error('non-finite conversion');
    return { value: v, unit: canonicalUnit, raw: String(raw), rawUnit, convertible: true, basis };
  } catch (err) {
    return {
      value: null,
      unit: canonicalUnit,
      raw: String(raw),
      rawUnit,
      convertible: false,
      basis,
      diagnostic: `cannot convert ${raw} ${rawUnit} -> ${canonicalUnit}: ${(err as Error).message}`,
    };
  }
}

export const degToRad = (d: number) => (d * Math.PI) / 180;
export const radToDeg = (r: number) => (r * 180) / Math.PI;

export function angle(raw: string | number, rawUnit: AngleUnit = 'deg', basis = 'microscope-stage'): Quantity {
  return quantity(raw, rawUnit, 'deg', basis, (v) => (rawUnit === 'rad' ? radToDeg(v) : v));
}

export function lengthPx(raw: string | number, basis = 'image-top-left'): Quantity {
  return quantity(raw, 'px', 'px', basis);
}

export function lengthNm(raw: string | number, basis = 'microscope-stage'): Quantity {
  return quantity(raw, 'nm', 'nm', basis);
}

/** 剂量：统一规范化到 e/A^2；1 e/nm^2 = 0.01 e/A^2 */
export function dose(raw: string | number, rawUnit: DoseUnit = 'e/A^2', basis = 'microscope-stage'): Quantity {
  return quantity(raw, rawUnit, 'e/A^2', basis, (v) => (rawUnit === 'e/nm^2' ? v / 100 : v));
}

/** 像素尺度：nm/px，用于把像素残差换算成物理长度 */
export interface PixelScale {
  readonly scaleX: Quantity;
  readonly scaleY: Quantity;
  readonly unit: 'nm/px';
  readonly basis: string;
  readonly valid: boolean;
  readonly diagnostic?: string;
}

export function pixelScale(
  scaleXRaw: string | number,
  scaleYRaw: string | number,
  rawUnit = 'nm/px',
  basis = 'image-top-left',
): PixelScale {
  const sx = quantity(scaleXRaw, rawUnit, 'nm/px', basis);
  const sy = quantity(scaleYRaw, rawUnit, 'nm/px', basis);
  const valid = sx.convertible && sy.convertible && (sx.value ?? 0) > 0 && (sy.value ?? 0) > 0;
  return {
    scaleX: sx,
    scaleY: sy,
    unit: 'nm/px',
    basis,
    valid,
    diagnostic: valid ? undefined : 'pixel scale missing or non-positive; physical residuals unavailable, px residuals retained',
  };
}
