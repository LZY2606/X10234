import type { Quantity, Unit } from "../shared/types";

/** 派生层规范化：转度 / 像素 / e/nm²。无法转换返回 null（保留原位 + 诊断）。 */
export function toDegrees(q: Quantity): number | null {
  if (typeof q.value !== "number" || !Number.isFinite(q.value)) return null;
  if (q.unit === "degree") return q.value;
  if (q.unit === "radian") return (q.value * 180) / Math.PI;
  return null;
}

export function toPixels(v: number, unit: Unit): number | null {
  if (!Number.isFinite(v)) return null;
  if (unit === "pixel") return v;
  return null;
}

export function toENm2(q: Quantity): number | null {
  if (!Number.isFinite(q.value)) return null;
  if (q.unit === "e_per_nm2") return q.value;
  if (q.unit === "e_per_px2") {
    // 需要像素尺度才能转换；无尺度时不臆造。
    return null;
  }
  return null;
}

export function toNmPerPixel(q: Quantity): number | null {
  if (!Number.isFinite(q.value)) return null;
  if (q.unit === "nm_per_pixel") return q.value;
  if (q.unit === "angstrom_per_pixel") return q.value / 10;
  return null;
}
