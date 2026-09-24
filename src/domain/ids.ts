/**
 * 稳定身份：确定性前缀 + 内容/语义哈希，保证导出->删库->导入后身份保持，
 * 也保证同一份不可变材料在最小输入与组合输入之间共享同一身份。
 */
import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function stableId(kind: string, ...parts: Array<string | number>): string {
  return `${kind}_${sha256Hex(parts.join(' ')).slice(0, 16)}`;
}

export function eventId(seq: number): string {
  return `evt_${String(seq).padStart(6, '0')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
