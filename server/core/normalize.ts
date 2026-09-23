import type { DomainQuantity, Unit } from './types.ts';

// 内部规范化基准：角度 radian，长度 pixel（像素尺度保留 nm/pixel 原始并派生 nm），
// 剂量 electron/nm^2。
const ANGLE_TO_RAD: Record<string, number> = {
  radian: 1,
  degree: Math.PI / 180
};

const DOSE_TO_E_PER_NM2: Record<string, number> = {
  electron_per_nm2: 1,
  e_per_angstrom2: 100 // 1 e/A^2 = 100 e/nm^2
};

const LENGTH_TO_PX: Record<string, number | undefined> = {
  pixel: 1,
  nm: undefined, // 需要像素尺度，调用方在有尺度时通过 withScale 转换
  angstrom: undefined
};

export function quantity(raw: string | number | null, rawUnit: Unit | string): DomainQuantity {
  const parsed = typeof raw === 'number' ? raw : parseLooseNumber(raw);
  if (parsed === null || Number.isNaN(parsed)) {
    return {
      raw, rawUnit, value: null, unit: null, convertible: false,
      diagnostic: `unparseable quantity "${String(raw)}" (unit ${String(rawUnit)}); kept at source position`
    };
  }
  switch (rawUnit) {
    case 'radian':
    case 'degree':
      return { raw, rawUnit, value: parsed * (ANGLE_TO_RAD[rawUnit] ?? 1), unit: 'radian', convertible: true };
    case 'pixel':
      return { raw, rawUnit, value: parsed, unit: 'pixel', convertible: true };
    case 'nm':
      return { raw, rawUnit, value: parsed, unit: 'nm', convertible: true };
    case 'angstrom':
      return { raw, rawUnit, value: parsed / 10, unit: 'nm', convertible: true };
    case 'electron_per_nm2':
    case 'e_per_angstrom2':
      return { raw, rawUnit, value: parsed * (DOSE_TO_E_PER_NM2[rawUnit] ?? 1), unit: 'electron_per_nm2', convertible: true };
    case 'dimensionless':
    case 'frame_index':
      return { raw, rawUnit, value: parsed, unit: rawUnit as Unit, convertible: true };
    default:
      return {
        raw, rawUnit, value: null, unit: null, convertible: false,
        diagnostic: `unknown unit "${String(rawUnit)}"; value retained verbatim, excluded from normalization`
      };
  }
}

/** 带像素尺度（nm/pixel）时把 nm/angstrom 坐标量转 pixel；不可转换留在原位 */
export function toPixels(q: DomainQuantity, nmPerPixel: number | null): DomainQuantity {
  if (q.convertible && q.unit === 'pixel') return q;
  if (q.convertible && q.unit === 'nm') {
    if (nmPerPixel === null || !Number.isFinite(nmPerPixel)) {
      return { ...q, value: null, unit: null, convertible: false, diagnostic: 'no pixel scale available; retained in nm' };
    }
    return { ...q, value: (q.value as number) / nmPerPixel, unit: 'pixel', convertible: true };
  }
  return q;
}

export function parseLooseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const m = trimmed.match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
  if (!m) return null;
  const value = Number(m[0]);
  return Number.isFinite(value) ? value : null;
}

export function requireValue(q: DomainQuantity, where: string): number {
  if (q.value === null || !q.convertible) {
    throw new Error(`non-convertible quantity at ${where}: ${q.diagnostic ?? 'unknown reason'}`);
  }
  return q.value;
}
