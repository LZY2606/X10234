import { createHash, randomUUID } from 'node:crypto';

export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

function stableClone(value: unknown): Json {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return null;
    if (typeof value === 'bigint') return value.toString();
    return value as Json;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stableClone(entry));
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, Json> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    out[key] = stableClone(record[key]);
  }
  return out;
}

/**
 * 内容身份：同一规范化内容 -> 同一稳定身份。
 * 重新解释会产生不同内容，因此得到不同身份，绝不覆盖旧内容。
 */
export function contentId(kind: string, content: unknown): string {
  const digest = sha256Hex(`${kind}\n${canonicalJson(content)}`);
  return `${kind}_${digest.slice(0, 16)}`;
}

/** 行为身份：人工裁定、候选生成等动作即使内容相同也是独立事件。 */
export function actionId(kind: string): string {
  return `${kind}_${randomUUID()}`;
}
