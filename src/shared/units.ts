/**
 * 派生层单位规范化。导入层只保留原始表示（RawQuantity.rawText/rawUnit），
 * 规范化发生在这里；无法转换的值留在原位置并附诊断。
 */
import type { RawQuantity } from './domain.js';

const UNIT_ALIASES: Record<string, string> = {
  'deg': 'deg', 'degree': 'deg', 'degrees': 'deg', '°': 'deg',
  'nm': 'nm', 'nanometer': 'nm', 'nanometre': 'nm',
  'nm/px': 'nm/px', 'nm/pixel': 'nm/px',
  'ang/px': 'ang/px', 'a/px': 'ang/px', 'angstrom/px': 'ang/px', 'angstrom/pixel': 'ang/px',
  'px': 'px', 'pixel': 'px', 'pixels': 'px',
  'e-/a2': 'e-/A2', 'e/a2': 'e-/A2', 'e-/ang^2': 'e-/A2', 'e-/angstrom^2': 'e-/A2',
  'e-/nm2': 'e-/nm2',
};

/** 换算到规范单位的倍率。角度、像素尺度、剂量各有自己的规范单位。 */
const CONVERSIONS: Record<string, { canonical: string; factor: number }> = {
  'deg': { canonical: 'deg', factor: 1 },
  'nm': { canonical: 'nm', factor: 1 },
  'nm/px': { canonical: 'nm/px', factor: 1 },
  'ang/px': { canonical: 'nm/px', factor: 0.1 },
  'px': { canonical: 'px', factor: 1 },
  'e-/A2': { canonical: 'e-/A2', factor: 1 },
  'e-/nm2': { canonical: 'e-/A2', factor: 100 },
};

export function makeRaw(rawText: string, rawUnit: string): RawQuantity {
  return { rawText, rawUnit };
}

/** 规范化一个原始量；失败时返回带诊断、无 normalized 的原对象。 */
export function normalize(raw: RawQuantity): RawQuantity {
  const value = Number.parseFloat(raw.rawText);
  if (!Number.isFinite(value)) {
    return { ...raw, diagnostic: `unparseable-numeric: "${raw.rawText}"` };
  }
  const unitKey = raw.rawUnit.trim().toLowerCase();
  const canonicalUnit = UNIT_ALIASES[unitKey];
  if (!canonicalUnit) {
    return { ...raw, diagnostic: `unknown-unit: "${raw.rawUnit}"` };
  }
  const conv = CONVERSIONS[canonicalUnit];
  if (!conv) {
    return { ...raw, diagnostic: `no-conversion-for: "${canonicalUnit}"` };
  }
  return {
    ...raw,
    normalized: value * conv.factor,
    normalizedUnit: conv.canonical,
  };
}

/** 取规范化值；缺诊断时抛错（调用方需要值就必须面对诊断）。 */
export function requireNormalized(raw: RawQuantity, expectedUnit: string): number {
  if (raw.normalized === undefined || raw.normalizedUnit !== expectedUnit) {
    throw new Error(
      `quantity not normalized to ${expectedUnit}: ${raw.diagnostic ?? `unit=${raw.normalizedUnit}`}`,
    );
  }
  return raw.normalized;
}
