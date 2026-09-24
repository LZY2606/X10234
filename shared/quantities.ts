/**
 * 领域量：所有物理量携带单位或坐标基准。
 * 导入时保留原始表示（raw），派生层才做规范化（normalize）。
 * 无法转换的值留在原位置并附诊断，绝不为了画图丢弃。
 */

export type Unit =
  | "deg"        // 倾角
  | "rad"
  | "nm/px"      // 像素尺度
  | "A/px"       // 埃/像素（导入时保留，派生层换算）
  | "e-/A2"      // 剂量 电子/平方埃
  | "e-/nm2"
  | "px"         // 像素坐标（需坐标基准）
  | "nm"
  | "count";

export type CoordBasis =
  | "image-top-left"   // 图像坐标系：原点在左上，x 向右，y 向下
  | "specimen"         // 样品坐标系
  | "tilt-axis-local"; // 以倾转轴为基准的局部坐标

export interface Quantity {
  kind: "quantity";
  value: number;
  unit: Unit;
  basis?: CoordBasis;
  /** 导入时的原始字符串表示，原样保留 */
  raw: string;
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  /** 出问题的原始值留在原位置 */
  raw?: string;
}

export function quantity(value: number, unit: Unit, raw?: string, basis?: CoordBasis): Quantity {
  return { kind: "quantity", value, unit, basis, raw: raw ?? String(value) };
}

/** 规范化结果：要么得到目标单位的值，要么得到 null + 诊断 */
export interface Normalized {
  value: number | null;
  unit: Unit;
  diagnostics: Diagnostic[];
}

const UNIT_TABLE: Record<string, { to: Unit; factor: number }[]> = {
  deg: [{ to: "rad", factor: Math.PI / 180 }],
  rad: [{ to: "deg", factor: 180 / Math.PI }],
  "A/px": [{ to: "nm/px", factor: 0.1 }],
  "nm/px": [{ to: "A/px", factor: 10 }],
  "e-/A2": [{ to: "e-/nm2", factor: 100 }],
  "e-/nm2": [{ to: "e-/A2", factor: 0.01 }],
};

export function normalize(q: Quantity, target: Unit): Normalized {
  if (q.unit === target) return { value: q.value, unit: target, diagnostics: [] };
  const paths = UNIT_TABLE[q.unit] ?? [];
  const hit = paths.find((p) => p.to === target);
  if (!hit) {
    return {
      value: null,
      unit: target,
      diagnostics: [
        {
          severity: "error",
          code: "UNIT_UNCONVERTIBLE",
          message: `无法把 ${q.unit} 转换为 ${target}；原始值保留在原位置`,
          raw: q.raw,
        },
      ],
    };
  }
  return { value: q.value * hit.factor, unit: target, diagnostics: [] };
}

/** 坐标基准转换：图像坐标 -> 以图像中心为原点的物理坐标（nm） */
export function imageToCenterNm(
  q: Quantity,
  pixelSizeNmPerPx: number,
  imageWidthPx: number,
  imageHeightPx: number,
  axis: "x" | "y",
): Normalized {
  if (q.unit !== "px" || q.basis !== "image-top-left") {
    return {
      value: null,
      unit: "nm",
      diagnostics: [
        {
          severity: "error",
          code: "BASIS_UNCONVERTIBLE",
          message: `坐标基准 ${q.basis ?? "未标注"}/${q.unit} 无法转换为图像中心 nm 坐标；原始值保留`,
          raw: q.raw,
        },
      ],
    };
  }
  const center = axis === "x" ? imageWidthPx / 2 : imageHeightPx / 2;
  return { value: (q.value - center) * pixelSizeNmPerPx, unit: "nm", diagnostics: [] };
}
