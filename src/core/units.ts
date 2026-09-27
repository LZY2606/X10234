import type { DomainQuantity } from '../domain/types.ts';

/**
 * 领域量：导入时保留原始表示；只有派生层才规范化。
 * 无法转换的值留在原位置并附诊断，绝不为画图而丢弃。
 */
export function quantity(
  raw: string,
  basis: string,
  opts: { normalized?: number; normalizedUnit?: string; unconverted?: boolean; diagnostic?: string } = {}
): DomainQuantity {
  return {
    raw,
    basis,
    normalized: opts.normalized,
    normalizedUnit: opts.normalizedUnit,
    unconverted: opts.unconverted,
    diagnostic: opts.diagnostic
  };
}

const ANGLE_TO_DEG: Record<string, number> = {
  'deg': 1,
  '°': 1,
  'degree': 1,
  'degrees': 1,
  'rad': 180 / Math.PI,
  'radian': 180 / Math.PI
};

const DOSE_PER_A2: Record<string, number> = {
  'e-/Å²': 1,
  'e/A^2': 1,
  'e/Å²': 1,
  'electrons/Å²': 1
};

const SCALE: Record<string, number> = {
  'Å/pix': 1,
  'nm/pix': 10,
  'Å/pixel': 1,
  'nm/pixel': 10
};

/** 解析 "61.2 e-/Å²" 这类领域量，保留原文，规范化失败时不丢弃。 */
export function parseQuantity(raw: string, basis: string, family: 'angle' | 'dose' | 'scale' | 'text'): DomainQuantity {
  const trimmed = raw.trim();
  if (family === 'text') return quantity(trimmed, basis);
  const m = trimmed.match(/^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(.+)$/);
  if (!m) {
    return quantity(trimmed, basis, { unconverted: true, diagnostic: `无法解析数值/单位：${trimmed}` });
  }
  const value = Number(m[1]);
  const unit = m[2].trim();
  const table = family === 'angle' ? ANGLE_TO_DEG : family === 'dose' ? DOSE_PER_A2 : SCALE;
  const factor = table[unit];
  if (factor === undefined) {
    return quantity(trimmed, basis, {
      unconverted: true,
      diagnostic: `未知单位「${unit}」，原值保留在 raw 字段`
    });
  }
  const canonicalUnit = family === 'angle' ? 'deg' : family === 'dose' ? 'e-/Å²' : 'Å/pix';
  return quantity(trimmed, basis, { normalized: value * factor, normalizedUnit: canonicalUnit });
}

export function requireNormalized(q: DomainQuantity): number {
  if (q.normalized === undefined) {
    throw new Error(`领域量未规范化：raw="${q.raw}" 诊断=${q.diagnostic ?? '无'}`);
  }
  return q.normalized;
}
