import type { DomainQuantity } from "./domain.js";

/**
 * 派生层规范化：导入时保留原始表示（raw），这里才做单位换算。
 * 无法转换的值返回 diagnostic，调用方必须把它留在原位置，不能丢掉。
 */

type UnitFamily = "angle" | "dose" | "pixel_scale" | "length_px";

interface UnitDef {
  canonical: string;
  factor: number;
}

const UNIT_TABLE: Record<UnitFamily, Record<string, UnitDef>> = {
  angle: {
    deg: { canonical: "deg", factor: 1 },
    "°": { canonical: "deg", factor: 1 },
    degree: { canonical: "deg", factor: 1 },
    degrees: { canonical: "deg", factor: 1 },
    rad: { canonical: "deg", factor: 180 / Math.PI },
  },
  dose: {
    "e-/nm2": { canonical: "e-/nm2", factor: 1 },
    "e/nm^2": { canonical: "e-/nm2", factor: 1 },
    "e-/nm^2": { canonical: "e-/nm2", factor: 1 },
    "e-/A2": { canonical: "e-/nm2", factor: 100 },
    "e-/Å²": { canonical: "e-/nm2", factor: 100 },
  },
  pixel_scale: {
    "nm/px": { canonical: "nm/px", factor: 1 },
    "nm/pixel": { canonical: "nm/px", factor: 1 },
    "A/px": { canonical: "nm/px", factor: 0.1 },
    "Å/px": { canonical: "nm/px", factor: 0.1 },
  },
  length_px: {
    px: { canonical: "px", factor: 1 },
    pixel: { canonical: "px", factor: 1 },
    pixels: { canonical: "px", factor: 1 },
  },
};

const NUMBER_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/;

export function makeQuantity(raw: string): DomainQuantity {
  return { raw };
}

export function normalizeQuantity(raw: string, family: UnitFamily, basis?: string): DomainQuantity {
  const q: DomainQuantity = { raw };
  if (basis) q.basis = basis;
  const m = NUMBER_RE.exec(raw.trim());
  if (!m) {
    q.diagnostic = `无法解析数值：「${raw}」，原值保留在原位置`;
    return q;
  }
  const value = Number(m[1]);
  const unitRaw = (m[2] ?? "").trim();
  const table = UNIT_TABLE[family];
  const def = table[unitRaw];
  if (!def) {
    q.diagnostic = `无法转换的单位：「${unitRaw || "(无单位)"}」（期望 ${Object.keys(table).join(" / ")}），原值保留在原位置`;
    return q;
  }
  q.value = value * def.factor;
  q.unit = def.canonical;
  return q;
}

export function normalizeAngle(raw: string): DomainQuantity {
  return normalizeQuantity(raw, "angle");
}

export function normalizeDose(raw: string): DomainQuantity {
  return normalizeQuantity(raw, "dose");
}

export function normalizePixelScale(raw: string): DomainQuantity {
  return normalizeQuantity(raw, "pixel_scale");
}

export function normalizePx(raw: string): DomainQuantity {
  return normalizeQuantity(raw, "length_px", "frame-px:origin-top-left");
}

/** 查询时返回的内容摘要：版本号 + 规范化结果或诊断。 */
export function summarizeQuantity(q: DomainQuantity): string {
  if (q.value !== undefined && q.unit) return `${q.raw} → ${q.value} ${q.unit}`;
  return `${q.raw}（未规范化：${q.diagnostic ?? "未知原因"}）`;
}
