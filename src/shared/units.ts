/**
 * 领域量单位与坐标基准。
 * 导入时保留原始表示（value/unit 原样存储），仅在派生层做规范化。
 * 无法转换的值不丢弃：留原位置并附诊断。
 */
export type UnitKind =
  | 'angle'
  | 'length'
  | 'pixel_scale'
  | 'dose'
  | 'dimensionless'
  | 'pixel';

export interface DomainQuantity {
  /** 原始数值，按 rawUnit 解释 */
  value: number;
  /** 原始单位（保留导入时的表示，不做小写归一以外的改写） */
  rawUnit: string;
  /** 量纲类别 */
  kind: UnitKind;
}

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  mrad: 1e-3,
  degree: Math.PI / 180,
  deg: Math.PI / 180,
};

const LENGTH_TO_M: Record<string, number> = {
  m: 1,
  nm: 1e-9,
  um: 1e-6,
  µm: 1e-6,
  angstrom: 1e-10,
  'Å': 1e-10,
};

/** 像素尺度：物理长度/像素 */
const SCALE_TO_M_PER_PX: Record<string, number> = {
  'nm/px': 1e-9,
  'nm/pixel': 1e-9,
  'um/px': 1e-6,
  'angstrom/px': 1e-10,
  'Å/px': 1e-10,
  'm/px': 1,
};

const DOSE_TO_E_PER_A2: Record<string, number> = {
  'e-/A^2': 1,
  'e-/Å^2': 1,
  'e/A^2': 1,
  'e/Å^2': 1,
  'electrons/A^2': 1,
  'e-/nm^2': 1e-2,
  'e/nm^2': 1e-2,
};

const DIMENSIONLESS = { '': 1, ratio: 1, px: 1, pixel: 1, pixels: 1 };

export interface ConversionResult {
  /** SI/内部规范化值；无法转换时为 null，原始值仍保留 */
  canonical: number | null;
  canonicalUnit: string | null;
  convertible: boolean;
  reason?: string;
}

export function canonicalUnit(kind: UnitKind): string {
  switch (kind) {
    case 'angle': return 'rad';
    case 'length': return 'm';
    case 'pixel_scale': return 'm/px';
    case 'dose': return 'e-/A^2';
    case 'dimensionless': return '';
    case 'pixel': return 'px';
  }
}

export function convertQuantity(q: DomainQuantity): ConversionResult {
  const u = q.rawUnit.trim();
  let factor: number | undefined;
  switch (q.kind) {
    case 'angle': factor = ANGLE_TO_RAD[u]; break;
    case 'length': factor = LENGTH_TO_M[u]; break;
    case 'pixel_scale': factor = SCALE_TO_M_PER_PX[u]; break;
    case 'dose': factor = DOSE_TO_E_PER_A2[u]; break;
    case 'dimensionless': factor = DIMENSIONLESS[u as keyof typeof DIMENSIONLESS]; break;
    case 'pixel': factor = u === 'px' || u === 'pixel' || u === 'pixels' ? 1 : undefined; break;
  }
  if (factor === undefined) {
    return { canonical: null, canonicalUnit: null, convertible: false,
      reason: `unknown unit "${q.rawUnit}" for kind ${q.kind}` };
  }
  if (!Number.isFinite(q.value)) {
    return { canonical: null, canonicalUnit: null, convertible: false,
      reason: 'non-finite value' };
  }
  return { canonical: q.value * factor, canonicalUnit: canonicalUnit(q.kind), convertible: true };
}

export function toRadians(q: DomainQuantity): number | null {
  const r = convertQuantity(q);
  return r.kind === 'angle' && q.kind === 'angle' ? r.canonical : r.canonical;
}
