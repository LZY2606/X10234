import { createHash } from 'node:crypto';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Short(input: string | Buffer): string {
  return sha256(input).slice(0, 16);
}

// 稳定内容身份：同一内容永远得到同一 id；重新导入不产生第二份。
export function contentId(kind: string, content: unknown): string {
  return `${kind}_${sha256Short(JSON.stringify(content))}`;
}

export function entityVersionId(entityId: string, version: number): string {
  return `${entityId}#v${version}`;
}

export function stableId(prefix: string, body: unknown): string {
  return `${prefix}_${sha256Short(JSON.stringify(body))}`;
}

// 有效点集指纹：候选比较必须共享相同有效点集。
export function pointSetFingerprint(keys: string[]): string {
  return `pts_${sha256Short([...keys].sort().join('|'))}`;
}
