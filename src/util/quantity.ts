import type { Quantity, Diagnostic } from '../core/domain';

/** 保留原始表示；派生层才做规范化。无法转换的值留在原位并附诊断。 */
export function makeQuantity(value: number | string | null, unit: string, raw: string, frame?: string, diagnostics?: Diagnostic[]): Quantity {
  return { value: value as never, unit, raw, frame, diagnostics };
}

const ANGLE_TO_DEG: Record<string, number> = { degree: 1, radian: 180 / Math.PI, deg: 1, rad: 180 / Math.PI };
const LENGTH_TO_NM: Record<string, number> = { nm: 1, um: 1000, A: 0.1, 'Å': 0.1 };
const DOSE_TO_E_PER_A2: Record<string, number> = { 'e-/A^2': 1, 'e-/nm^2': 0.01, 'e-/Å^2': 1 };

function parseNumber(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/);
  if (!m) return null;
  return Number(m[0]);
}

export function normalizeAngle(q: Quantity<number>): Quantity<number> {
  const v = q.value ?? parseNumber(q.raw);
  const f = ANGLE_TO_DEG[q.unit];
  if (v === null || f === undefined) {
    return { ...q, value: null, unit: 'degree', diagnostics: [...(q.diagnostics ?? []), { code: 'unconvertible-angle', severity: 'error', message: `无法把倾角 ${q.raw} (${q.unit}) 规范化为 degree` }] };
  }
  return { ...q, value: v * f, unit: 'degree' };
}

export function normalizeLength(q: Quantity<number>): Quantity<number> {
  const v = q.value ?? parseNumber(q.raw);
  const f = LENGTH_TO_NM[q.unit];
  if (v === null || f === undefined) {
    return { ...q, value: null, diagnostics: [...(q.diagnostics ?? []), { code: 'unconvertible-length', severity: 'error', message: `无法把尺度 ${q.raw} (${q.unit}) 规范化为 nm` }] };
  }
  return { ...q, value: v * f, unit: 'nm' };
}

export function normalizeDose(q: Quantity<number>): Quantity<number> {
  const v = q.value ?? parseNumber(q.raw);
  const f = DOSE_TO_E_PER_A2[q.unit];
  if (v === null || f === undefined) {
    return { ...q, value: null, unit: 'e-/A^2', diagnostics: [...(q.diagnostics ?? []), { code: 'unconvertible-dose', severity: 'error', message: `无法把剂量 ${q.raw} (${q.unit}) 规范化为 e-/A^2` }] };
  }
  return { ...q, value: v * f, unit: 'e-/A^2' };
}

export function summarize(q: Quantity): string {
  return q.value === null ? `${q.raw} [不可转换:${q.unit}]` : `${q.value}${q.unit}`;
}
