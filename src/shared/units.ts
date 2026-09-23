import type { DomainValue } from './domain';

// 导入时保留 raw；派生层才规范化。无法转换时返回 undefined + 诊断，绝不丢值。
export function normalizeAngle(v: DomainValue<number>): DomainValue<number> {
  if (typeof v.converted === 'number') return v;
  const unit = (v.rawUnit ?? '').toLowerCase();
  if (unit === '' || unit === 'deg' || unit === 'degree' || unit === 'degrees') {
    return { ...v, converted: v.raw, unit: 'degree' };
  }
  if (unit === 'rad' || unit === 'radian' || unit === 'radians') {
    return { ...v, converted: (v.raw * 180) / Math.PI, unit: 'degree' };
  }
  return { ...v, conversionDiagnostic: `未知角度单位 '${v.rawUnit}'，保留原始值`, unit: undefined };
}

export function normalizeDose(v: DomainValue<number>): DomainValue<number> {
  if (typeof v.converted === 'number') return v;
  const unit = (v.rawUnit ?? '').toLowerCase().replace(/²/g, '2');
  if (unit === 'e/nm2' || unit === 'e/nm^2' || unit === 'electrons/nm2') {
    return { ...v, converted: v.raw, unit: 'e_per_nm2' };
  }
  if (unit === 'e/a2' || unit === 'e/angstrom2' || unit === 'e/a^2') {
    return { ...v, converted: v.raw * 100, unit: 'e_per_nm2' }; // 1 Å² = 0.01 nm²
  }
  return { ...v, conversionDiagnostic: `未知剂量单位 '${v.rawUnit}'，保留原始值` };
}

export function normalizePixelScale(v: DomainValue<number>): DomainValue<number> {
  if (typeof v.converted === 'number') return v;
  const unit = (v.rawUnit ?? '').toLowerCase();
  if (unit === 'nm/px' || unit === 'nm/pixel' || unit === 'nm_per_pixel') {
    return { ...v, converted: v.raw, unit: 'nm_per_pixel' };
  }
  if (unit === 'a/px' || unit === 'angstrom/px' || unit === 'a/pixel') {
    return { ...v, converted: v.raw / 10, unit: 'nm_per_pixel' };
  }
  return { ...v, conversionDiagnostic: `未知像素尺度单位 '${v.rawUnit}'，保留原始值` };
}

export function convertedOrRaw(v: DomainValue<number>): number {
  return typeof v.converted === 'number' ? v.converted : v.raw;
}
