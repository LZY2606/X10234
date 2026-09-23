/**
 * 领域量单位与坐标基准。
 * 导入层保留原始表示（raw），派生层才调用这里的规范化；
 * 无法转换的值返回诊断，原值留在原位置，绝不为了画图丢弃。
 */

export interface RawQuantity {
  value: number | string;
  unit: string;
  coord_frame?: string;
}

export interface UnitDiagnostic {
  code: 'unit.unconvertible' | 'unit.unknown-coordinate-frame';
  message: string;
  raw: RawQuantity;
}

export type NormResult<T> =
  | { ok: true; value: T; raw: RawQuantity }
  | { ok: false; diagnostic: UnitDiagnostic };

function fail(code: UnitDiagnostic['code'], message: string, raw: RawQuantity): NormResult<never> {
  return { ok: false, diagnostic: { code, message, raw } };
}

/** 倾角规范化为度（deg）。支持 deg / rad / mrad。 */
export function normalizeTiltAngle(raw: RawQuantity): NormResult<number> {
  const v = typeof raw.value === 'number' ? raw.value : Number(raw.value);
  if (!Number.isFinite(v)) return fail('unit.unconvertible', `倾角数值不可解析: ${String(raw.value)}`, raw);
  switch (raw.unit) {
    case 'deg':
    case 'degree':
      return { ok: true, value: v, raw };
    case 'rad':
      return { ok: true, value: (v * 180) / Math.PI, raw };
    case 'mrad':
      return { ok: true, value: (v / 1000) * (180 / Math.PI), raw };
    default:
      return fail('unit.unconvertible', `未知倾角单位: ${raw.unit}`, raw);
  }
}

/** 像素尺度规范化为 nm/px。支持 nm/px、Å/px、A/px、angstrom/px。 */
export function normalizePixelSize(raw: RawQuantity): NormResult<number> {
  const v = typeof raw.value === 'number' ? raw.value : Number(raw.value);
  if (!Number.isFinite(v) || v <= 0) return fail('unit.unconvertible', `像素尺度不可解析: ${String(raw.value)}`, raw);
  switch (raw.unit) {
    case 'nm/px':
      return { ok: true, value: v, raw };
    case 'Å/px':
    case 'A/px':
    case 'angstrom/px':
      return { ok: true, value: v / 10, raw };
    default:
      return fail('unit.unconvertible', `未知像素尺度单位: ${raw.unit}`, raw);
  }
}

/** 曝光剂量规范化为 e-/Å²。 */
export function normalizeDose(raw: RawQuantity): NormResult<number> {
  const v = typeof raw.value === 'number' ? raw.value : Number(raw.value);
  if (!Number.isFinite(v)) return fail('unit.unconvertible', `剂量不可解析: ${String(raw.value)}`, raw);
  switch (raw.unit) {
    case 'e-/Å²':
    case 'e-/A^2':
    case 'e-/Å2':
    case 'e-/A2':
      return { ok: true, value: v, raw };
    case 'e-/nm²':
    case 'e-/nm2':
      return { ok: true, value: v / 100, raw };
    default:
      return fail('unit.unconvertible', `未知剂量单位: ${raw.unit}`, raw);
  }
}

/** 图像坐标（px），必须声明坐标基准（coord_frame），只接受 image 基准。 */
export function normalizeImageCoord(raw: RawQuantity): NormResult<number> {
  const v = typeof raw.value === 'number' ? raw.value : Number(raw.value);
  if (!Number.isFinite(v)) return fail('unit.unconvertible', `坐标不可解析: ${String(raw.value)}`, raw);
  if (raw.unit !== 'px') return fail('unit.unconvertible', `未知坐标单位: ${raw.unit}`, raw);
  if (raw.coord_frame !== undefined && raw.coord_frame !== 'image') {
    return fail('unit.unknown-coordinate-frame', `未知坐标基准: ${raw.coord_frame}`, raw);
  }
  return { ok: true, value: v, raw };
}
