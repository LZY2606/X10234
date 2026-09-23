import type { Diagnostic, Quantity } from './types.js';

/**
 * 领域量：保留原始表示，派生层才规范化。
 * 无法转换的值留在原位（value 缺失）并附诊断。
 */

const ANGLE_TO_DEGREE: Record<string, number> = {
  degree: 1,
  radian: 180 / Math.PI,
};
const LENGTH_TO_NM: Record<string, number> = {
  pixel: NaN, // pixel 需要像素尺度，不能独立规范化；保留
  nm: 1,
  um: 1000,
};
const DOSE_TO_E_PER_A2: Record<string, number> = {
  'e/angstrom^2': 1,
  'e/nm^2': 0.01, // 1 e/nm^2 = 0.01 e/A^2
};

export function quantity(
  kind: Quantity['kind'],
  raw: string | number,
  unit: string,
  coordFrame?: string,
): Quantity {
  const q: Quantity = { kind, raw, unit, coordFrame };
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed)) {
    q.diagnostics = [
      {
        code: 'UNPARSEABLE_QUANTITY',
        message: `无法解析为数值，原始表示保留在原位: ${JSON.stringify(raw)} ${unit}`,
        severity: 'error',
      },
    ];
    return q;
  }
  normalizeInto(q, parsed);
  return q;
}

function normalizeInto(q: Quantity, parsed: number): void {
  const add = (d: Diagnostic) => (q.diagnostics = [...(q.diagnostics ?? []), d]);
  switch (q.kind) {
    case 'angle': {
      const factor = ANGLE_TO_DEGREE[q.unit];
      if (factor === undefined) {
        add({ code: 'UNKNOWN_ANGLE_UNIT', message: `未知角度单位 ${q.unit}，不做转换`, severity: 'warning' });
        return;
      }
      q.value = parsed * factor;
      q.normalizedUnit = 'degree';
      return;
    }
    case 'length': {
      if (q.unit === 'pixel') {
        q.value = parsed;
        q.normalizedUnit = 'pixel';
        return;
      }
      const factor = LENGTH_TO_NM[q.unit];
      if (factor === undefined) {
        add({ code: 'UNKNOWN_LENGTH_UNIT', message: `未知长度单位 ${q.unit}，不做转换`, severity: 'warning' });
        return;
      }
      q.value = parsed * factor;
      q.normalizedUnit = 'nm';
      return;
    }
    case 'dose': {
      const factor = DOSE_TO_E_PER_A2[q.unit];
      if (factor === undefined) {
        add({ code: 'UNKNOWN_DOSE_UNIT', message: `未知剂量单位 ${q.unit}，不做转换`, severity: 'warning' });
        return;
      }
      q.value = parsed * factor;
      q.normalizedUnit = 'e/angstrom^2';
      return;
    }
    case 'scalar':
      q.value = parsed;
      q.normalizedUnit = q.unit;
      return;
  }
}

export function requireValue(q: Quantity): number {
  if (q.value === undefined || !Number.isFinite(q.value)) {
    throw new Error(`领域量缺少可规范化数值: ${JSON.stringify(q.raw)} ${q.unit}`);
  }
  return q.value;
}

export function scalarQuantity(value: number): Quantity {
  return {
    kind: 'scalar',
    raw: Number(value.toFixed(4)),
    unit: 'pixel',
    value: Number(value.toFixed(4)),
    normalizedUnit: 'pixel',
  };
}
