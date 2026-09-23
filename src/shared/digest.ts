import { createHash, randomUUID } from 'node:crypto';

/** 内容摘要：稳定身份的基础。相同字节永远得到相同 digest。 */
export function digestOf(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

/** 稳定身份：一次生成，终身不变，导出/删除/再导入后仍保持。 */
export function stableId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
