import { createHash } from 'node:crypto';

/** 内容寻址摘要：同一原始片段只存一份不可变内容。 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 稳定身份：由命名空间与内容摘要派生，导出/删除/再导入后保持不变。 */
export function stableId(namespace: string, ...parts: string[]): string {
  const digest = contentHash([namespace, ...parts].join('|')).slice(0, 24);
  return `${namespace}_${digest}`;
}

export function shortDigest(content: string): string {
  return contentHash(content).slice(0, 16);
}
