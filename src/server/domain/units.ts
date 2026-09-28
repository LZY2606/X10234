// 导入层：保留原始表示；派生层才做规范化。
// 无法转换的值留在原位置并附诊断，不为画图丢弃。

export interface ParseResult {
  value: number | null;
  unit: string;
  raw: string;
  canonicalUnit: string;
  diagnostic?: string;
}

const ANGLE_TO_DEG: Record<string, number> = {
  deg: 1, "°": 1, degree: 1, degrees: 1,
  rad: 180 / Math.PI, radian: 180 / Math.PI,
};

const LENGTH_TO_NM: Record<string, number> = {
  nm: 1, um: 1000, "μm": 1000, A: 0.1, "Å": 0.1, angstrom: 0.1,
};

const DOSE_TO_E_PER_A2: Record<string, number> = {
  "e/A^2": 1, "e/Å^2": 1, "electron/A^2": 1, "e/nm^2": 0.01,
};

function split(raw: string): { num: number; unit: string } | null {
  const m = raw.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(.*)$/);
  if (!m) return null;
  return { num: Number(m[1]), unit: m[2].trim() };
}

export function parseAngle(raw: string): ParseResult {
  const parts = split(raw);
  const base: ParseResult = { value: null, unit: parts?.unit ?? raw, raw, canonicalUnit: "deg" };
  if (!parts) return { ...base, diagnostic: `unconvertible-angle:${raw}` };
  const f = ANGLE_TO_DEG[parts.unit];
  if (f === undefined) return { ...base, unit: parts.unit, diagnostic: `unknown-angle-unit:${parts.unit}` };
  return { ...base, value: parts.num * f, unit: parts.unit };
}

export function parseLengthPerPx(raw: string): ParseResult {
  const parts = split(raw);
  const base: ParseResult = { value: null, unit: parts?.unit ?? raw, raw, canonicalUnit: "nm/px" };
  if (!parts) return { ...base, diagnostic: `unconvertible-pixelsize:${raw}` };
  const f = LENGTH_TO_NM[parts.unit.replace("/px", "")];
  if (f === undefined) return { ...base, diagnostic: `unknown-length-unit:${parts.unit}` };
  return { ...base, value: parts.num * f, unit: parts.unit };
}

export function parseDose(raw: string): ParseResult {
  const parts = split(raw);
  const base: ParseResult = { value: null, unit: parts?.unit ?? raw, raw, canonicalUnit: "e/A^2" };
  if (!parts) return { ...base, diagnostic: `unconvertible-dose:${raw}` };
  const f = DOSE_TO_E_PER_A2[parts.unit];
  if (f === undefined) return { ...base, diagnostic: `unknown-dose-unit:${parts.unit}` };
  return { ...base, value: parts.num * f, unit: parts.unit };
}

export function parseQuantity(raw: string, kind: "angle" | "pixelsize" | "dose"): ParseResult {
  if (kind === "angle") return parseAngle(raw);
  if (kind === "pixelsize") return parseLengthPerPx(raw);
  return parseDose(raw);
}
