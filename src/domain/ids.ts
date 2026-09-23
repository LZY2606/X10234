import { createHash } from 'node:crypto';

/** 稳定、可跨导出/删除/再导入保持的身份与摘要工具。 */

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes as any).digest('hex');
}

const ENC = new TextEncoder();

/** 规范化 JSON：对象键排序、无多余空白，保证跨进程字节一致。 */
export function canonicalJSON(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (v === undefined) return 'null';
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    if (typeof v === 'object') {
      if (seen.has(v as object)) throw new Error('canonicalJSON: cycle');
      seen.add(v as object);
      const keys = Object.keys(v as Record<string, unknown>).sort();
      return `{${keys
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k])}`)
        .join(',')}}`;
    }
    return 'null';
  };
  return encode(value);
}

export function digestOf(value: unknown): string {
  return sha256(ENC.encode(canonicalJSON(value)));
}

export function contentIdOf(bytes: Uint8Array, mediaType: string): string {
  return `blob-${sha256(bytes).slice(0, 32)}`;
}

/** 由事件内容决定的稳定事件身份，重放顺序不变则身份不变。 */
export function eventIdOf(rec: {
  type: string;
  branch: string;
  parentIds: string[];
  ordinal: number;
  payload: unknown;
}): string {
  return `evt-${digestOf({
    t: rec.type,
    b: rec.branch,
    p: rec.parentIds,
    o: rec.ordinal,
    d: rec.payload,
  }).slice(0, 20)}`;
}

export const ID = {
  series: (n: number) => `ser-${String(n).padStart(4, '0')}`,
  frame: (s: string, n: number) => `${s}/frm-${String(n).padStart(3, '0')}`,
  angle: (f: string) => `${f}/tilt`,
  dose: (f: string) => `${f}/dose`,
  scale: (s: string) => `${s}/pixel-scale`,
  marker: (s: string, n: number) => `${s}/mk-${String(n).padStart(2, '0')}`,
  point: (m: string, n: number) => `${m}/p-${String(n).padStart(3, '0')}`,
  gap: (m: string, n: number) => `${m}/gap-${String(n).padStart(2, '0')}`,
  exclusion: (f: string, n: number) => `${f}/excl-${String(n).padStart(2, '0')}`,
  eps: (s: string, n: number) => `${s}/eps-${String(n).padStart(3, '0')}`,
  cand: (s: string, n: number) => `${s}/cand-${String(n).padStart(3, '0')}`,
  track: (s: string, v: number) => `${s}/tracks@v${v}`,
  axis: (s: string, v: number) => `${s}/axis@v${v}`,
};
