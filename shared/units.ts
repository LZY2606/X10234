import type { Quantity, RawQuantity, Diagnostic } from './types.js';

// 单位规范化只发生在派生层；无法转换的值留在原位置并附诊断。
const UNIT_ALIASES: Record<string, string> = {
  'nm/px': 'nm/px', 'nm/pixel': 'nm/px',
  'deg': 'deg', 'degree': 'deg', '°': 'deg',
  'e-/A2': 'e-/A2', 'e-/Å²': 'e-/A2', 'e-/A^2': 'e-/A2',
  'px': 'px', 'pixel': 'px',
};

export function normalizeQuantity(rawq: RawQuantity, path: string): { qty?: Quantity; diagnostic?: Diagnostic } {
  const m = rawq.raw.trim().match(/^([-+0-9.eE]+)\s*(.*)$/);
  if (!m) {
    return { diagnostic: { code: 'VALUE_UNPARSEABLE', message: `无法解析数值: "${rawq.raw}"`, path } };
  }
  const value = Number(m[1]);
  const unitRaw = m[2] || '';
  const unit = UNIT_ALIASES[unitRaw];
  if (!unit) {
    return { diagnostic: { code: 'UNIT_UNCONVERTIBLE', message: `无法转换的单位: "${unitRaw}"，值保留在原位置`, path } };
  }
  return { qty: { value, unit, basis: rawq.basis } };
}

export function hashContent(content: string): string {
  // FNV-1a 64bit —— 稳定、确定性的内容摘要（非安全用途）
  let h1 = 0xcbf29ce484222325n, h2 = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < content.length; i++) {
    const c = BigInt(content.charCodeAt(i));
    h1 = ((h1 ^ c) * 0x100000001b3n) & 0xffffffffffffffffn;
    h2 = ((h2 ^ c) * 0x100000001b3n ^ (h1 & 0xffffn)) & 0xffffffffffffffffn;
  }
  return h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0');
}
