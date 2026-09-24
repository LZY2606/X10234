import { createHash, randomUUID } from "node:crypto";

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function digestOf(payload: unknown): string {
  return sha256(canonical(payload));
}

export class CorruptionError extends Error {
  constructor(public missing: Array<{ entityId: string; version: number }>) {
    super(`corruption: missing referenced version(s) ${missing.map((m) => `${m.entityId}@v${m.version}`).join(", ")}`);
    this.name = "CorruptionError";
  }
}

export class ConflictError extends Error {
  constructor(public detail: { baseSeq: number; currentSeq: number; theirEvents: unknown[]; yourPayload: unknown }) {
    super(`version conflict: base=${detail.baseSeq} current=${detail.currentSeq}`);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
