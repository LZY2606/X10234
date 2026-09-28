import { createHash, randomBytes } from 'node:crypto';
import type { Quantity } from './types.js';

/**
 * 稳定身份。id 在导入 / 导出往返中保持不变，绝不使用 rowid 或自增序号充当身份。
 * 时间部分按毫秒排序，配合 seq 保证顺序稳定。
 */
export function stableId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(8).toString('hex');
  return `${prefix}_${ts}${rand}`;
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** 规范化 JSON（键排序），保证内容摘要稳定。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortHash(h: string): string {
  return h.slice(0, 12);
}

/**
 * 单位规范化。保留 raw 原值；派生层转换为标准单位。
 * 无法转换时 convertible=false，normalized 不产生，诊断由调用方记录——
 * 不能为了画图把不可转换的值丢掉。
 */
const ANGLE_TO_DEG: Record<string, number> = {
  deg: 1,
  degree: 1,
  degrees: 1,
  '°': 1,
  rad: 180 / Math.PI,
  radian: 180 / Math.PI,
  radians: 180 / Math.PI,
};

const SCALE_TO_NM_PER_PX: Record<string, number> = {
  'nm/px': 1,
  'nm per px': 1,
  'nm/pixel': 1,
  'a/px': 0.1,
  'angstrom/px': 0.1,
  'å/px': 0.1,
  'µm/px': 1000,
  'um/px': 1000,
};

const DOSE_TO_E_PER_A2: Record<string, number> = {
  'e-/a^2': 1,
  'e/a2': 1,
  'e/a^2': 1,
  'electrons/a^2': 1,
  'e-/nm^2': 0.01,
  'e/nm2': 0.01,
};

function lookup(table: Record<string, number>, unit: string): number | null {
  const key = unit.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

export function normalizeQuantity(input: { raw: string; unit: string; basis?: string }, kind: 'angle' | 'scale' | 'dose'): Quantity {
  const parsed = Number(input.raw);
  const table =
    kind === 'angle' ? ANGLE_TO_DEG : kind === 'scale' ? SCALE_TO_NM_PER_PX : DOSE_TO_E_PER_A2;
  const factor = lookup(table, input.unit);
  if (!Number.isFinite(parsed) || factor === null) {
    return { raw: input.raw, unit: input.unit, basis: input.basis, convertible: false };
  }
  return {
    raw: input.raw,
    unit: input.unit,
    basis: input.basis,
    normalized: Number((parsed * factor).toPrecision(10)),
    convertible: true,
  };
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
