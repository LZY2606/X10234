import { createHash, randomUUID } from "node:crypto";

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 结构 diff：返回双方差异的字段路径 -> {a, b}，供冲突窗口展示。 */
export function structuralDiff(a: unknown, b: unknown, path = ""): Record<string, { a: unknown; b: unknown }> {
  const out: Record<string, { a: unknown; b: unknown }> = {};
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (
    a !== null && b !== null &&
    typeof a === "object" && typeof b === "object" &&
    !Array.isArray(a) && !Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of keys) {
      const sub = structuralDiff(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key
      );
      Object.assign(out, sub);
    }
    return out;
  }
  out[path || "(root)"] = { a, b };
  return out;
}
