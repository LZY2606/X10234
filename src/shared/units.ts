// 单位与坐标基准：导入时保留原始表示，派生层才规范化；
// 无法转换的值留在原位置并附诊断，不能为了画图丢掉。
export interface NormalizedQuantity {
  ok: true
  value: number
  unit: string // 规范化后的单位
  raw: string
}

export interface UnconvertibleQuantity {
  ok: false
  raw: string
  diagnostic: { code: 'UNIT_UNCONVERTIBLE' | 'UNIT_ASSUMED'; message: string }
  assumedValue?: number
  assumedUnit?: string
}

export type QuantityResult = NormalizedQuantity | UnconvertibleQuantity

const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  A: 0.1,
  'Å': 0.1,
  angstrom: 0.1,
  um: 1000
}

const ANGLE_TO_DEG: Record<string, number> = {
  deg: 1,
  '°': 1,
  rad: 180 / Math.PI
}

const DOSE_TO_E_PER_A2: Record<string, number> = {
  'e-/A^2': 1,
  'e-/Å²': 1,
  'e-/A2': 1,
  'e-/nm^2': 0.01
}

export function normalizeAngle(raw: string): QuantityResult {
  return normalizeWith(raw, ANGLE_TO_DEG, 'deg')
}

export function normalizeLength(raw: string): QuantityResult {
  return normalizeWith(raw, LENGTH_TO_NM, 'nm')
}

export function normalizeDose(raw: string): QuantityResult {
  return normalizeWith(raw, DOSE_TO_E_PER_A2, 'e-/A^2')
}

export function normalizePixelScale(raw: string): QuantityResult {
  const m = raw.trim().match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([A-Za-zÅå°^²\-/]+)\s*$/u)
  if (!m) return unconvertible(raw, `像素尺度无法解析: "${raw}"`)
  const value = Number(m[1])
  const unit = m[2]
  const parts = unit.split('/')
  if (parts.length !== 2 || parts[1] !== 'px') {
    return unconvertible(raw, `像素尺度单位不是 <长度>/px: "${unit}"`)
  }
  const factor = LENGTH_TO_NM[parts[0]]
  if (factor === undefined) {
    return unconvertible(raw, `未知长度单位: "${parts[0]}"`)
  }
  return { ok: true, value: value * factor, unit: 'nm/px', raw }
}

function normalizeWith(raw: string, table: Record<string, number>, targetUnit: string): QuantityResult {
  const trimmed = raw.trim()
  const bare = Number(trimmed)
  if (Number.isFinite(bare)) {
    // 裸数字：保留原始表示，按目标单位假定并附诊断。
    return {
      ok: false,
      raw,
      diagnostic: { code: 'UNIT_ASSUMED', message: `裸数字按 ${targetUnit} 假定: "${trimmed}"` },
      assumedValue: bare,
      assumedUnit: targetUnit
    }
  }
  const m = trimmed.match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(.+)$/u)
  if (!m) return unconvertible(raw, `数值无法解析: "${raw}"`)
  const value = Number(m[1])
  const unit = m[2].trim()
  const factor = table[unit]
  if (factor === undefined) return unconvertible(raw, `未知单位: "${unit}"`)
  return { ok: true, value: value * factor, unit: targetUnit, raw }
}

function unconvertible(raw: string, message: string): UnconvertibleQuantity {
  return { ok: false, raw, diagnostic: { code: 'UNIT_UNCONVERTIBLE', message } }
}
