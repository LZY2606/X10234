import type { Dimensioned, Unit } from './types.js';

const TO_CANONICAL: Partial<Record<Unit, Unit>> = {
  degree: 'radian',
  um: 'nm',
  'e_per_nm2': 'e_per_A2',
};

const FACTORS: Record<string, number> = {
  'degree->radian': Math.PI / 180,
  'um->nm': 1000,
  // 1 e-/nm^2 = 0.01 e-/Å^2  (1 nm^2 = 100 Å^2)
  'e_per_nm2->e_per_A2': 0.01,
};

export function makeDimensioned(
  raw: string | number,
  unit: Unit,
  coordinateFrame?: string,
): Dimensioned {
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  const canonicalUnit = TO_CANONICAL[unit] ?? unit;
  const diagnostics: string[] = [];
  let value: number | null = numeric;
  if (!Number.isFinite(numeric)) {
    value = null;
    diagnostics.push(`UNCONVERTIBLE: 原始表示 ${JSON.stringify(raw)} 无法转换为数值，保留原位`);
  } else if (canonicalUnit !== unit) {
    const f = FACTORS[`${unit}->${canonicalUnit}`];
    if (f === undefined) {
      value = null;
      diagnostics.push(`NO_CONVERSION: ${unit} -> ${canonicalUnit}`);
    } else {
      value = numeric * f;
    }
  }
  const d: Dimensioned = { raw, value, unit, canonicalUnit, coordinateFrame };
  if (diagnostics.length) d.diagnostics = diagnostics;
  return d;
}

export function canonical(d: Dimensioned): number {
  if (d.value === null || d.diagnostics?.length) {
    throw new Error(`DERIVED_FROM_UNCONVERTIBLE: ${d.diagnostics?.join(';')}`);
  }
  return d.value;
}

export function summaryOf(d: Dimensioned): string {
  return d.value === null
    ? `${String(d.raw)} ${d.unit}(未转换)`
    : `${d.value.toPrecision(6)} ${d.canonicalUnit}`;
}
