import type { Diagnostic, PixelScalePayload } from '../shared/domain.ts';

// 派生层规范化：原始表示在导入时原样保留，这里才做单位换算。
// 无法转换的值留在原位置并附诊断，绝不为了画图丢掉。
export function pixelScaleToNmPerPx(
  payload: PixelScalePayload,
  diagnostics: Diagnostic[],
  at: string,
): number | null {
  if (payload.unit === 'nm/px') return payload.value;
  if (payload.unit === 'A/px') return payload.value / 10; // 1 nm = 10 Å
  diagnostics.push({
    code: 'unit_unconvertible',
    message: `像素尺度单位 '${payload.unit}' 无法转换为 nm/px，原值保留在原位置`,
    at,
    severity: 'error',
  });
  return null;
}

export function angleToDeg(value: number, unit: string, diagnostics: Diagnostic[], at: string): number | null {
  if (unit === 'deg') return value;
  if (unit === 'mrad') return (value / 1000) * (180 / Math.PI);
  diagnostics.push({
    code: 'unit_unconvertible',
    message: `角度单位 '${unit}' 无法转换为 deg，原值保留`,
    at,
    severity: 'error',
  });
  return null;
}
