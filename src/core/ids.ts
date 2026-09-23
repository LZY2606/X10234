import { createHash } from "node:crypto";

/** 稳定身份：导出/删除/重导入后保持不变（确定性，不依赖数据库自增）。 */
export const materialId = (kind: string) => `material:${kind}`;
export const paramSetId = (name: string) => `params:${name}`;
export const branchId = (name: string) => `branch:${name}`;
export const candidateId = (branch: string, n: number) => `candidate:${branch}:${String(n).padStart(3, "0")}`;
export const adjudicationId = (n: number) => `adjudication:${String(n).padStart(4, "0")}`;
export const lockId = (n: number) => `lock:${String(n).padStart(4, "0")}`;
export const eventId = (seq: number) => `event:${String(seq).padStart(6, "0")}`;
export const dossierId = (scenario: string) => `dossier:${scenario}`;
export const caseId = (name: string) => `case:${name}`;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 规范化 JSON（键排序），保证同一内容得到同一摘要。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
