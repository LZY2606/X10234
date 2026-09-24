/**
 * 所有领域量都显式携带单位或坐标基准。
 * 导入时保留原始表示（rawText/rawUnit），派生层才规范化；
 * 无法转换的值留在原位置并附诊断（convertible=false），绝不为画图丢弃。
 */

export type UnitKind =
  | "angle"
  | "length"
  | "dose"
  | "pixel"
  | "dimensionless";

export interface Quantified {
  /** 数值（按 unit 解释）；无法解析时为 null，原始文本保留在 rawText。 */
  value: number | null;
  /** 原始单位字符串，原样保留。 */
  unit: string;
  kind: UnitKind;
  /** 导入时的原始表示，永不改写。 */
  rawText: string;
  /** 是否可规范化到内部基准单位。 */
  convertible: boolean;
  /** 规范化诊断（不可转换时给出原因）。 */
  diagnostic?: string;
}

/** 坐标基准：fiducial 坐标与轴线均相对某帧的像素坐标系。 */
export interface CoordinateFrame {
  /** 坐标基准身份，例如 frame 的稳定 id。 */
  reference: string;
  /** 原点约定：图像左上角为 (0,0)。 */
  origin: "top-left";
  unit: "px";
}

const ANGLE_TO_RAD: Record<string, number> = {
  deg: Math.PI / 180,
  degree: Math.PI / 180,
  degrees: Math.PI / 180,
  rad: 1,
  radian: 1,
  radians: 1
};

const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  um: 1000,
  "µm": 1000,
  A: 0.1,
  angstrom: 0.1
};

const DOSE_TO_E_PER_A2: Record<string, number> = {
  "e/A^2": 1,
  "e/Å^2": 1,
  "electrons/A^2": 1
};

/** 解析带单位的标量；无法转换时保留原值并标记 convertible=false。 */
export function quantify(
  rawText: string,
  unit: string,
  kind: UnitKind
): Quantified {
  const trimmed = String(rawText).trim();
  const num = Number(trimmed);
  const base: Quantified = {
    value: Number.isFinite(num) ? num : null,
    unit,
    kind,
    rawText: trimmed,
    convertible: false
  };
  const table =
    kind === "angle"
      ? ANGLE_TO_RAD
      : kind === "length"
        ? LENGTH_TO_NM
        : kind === "dose"
          ? DOSE_TO_E_PER_A2
          : kind === "pixel"
            ? { px: 1 }
            : { "": 1, count: 1 };
  const key = unit.trim();
  if (Number.isFinite(num) && Object.prototype.hasOwnProperty.call(table, key)) {
    base.convertible = true;
  } else if (!Number.isFinite(num)) {
    base.diagnostic = `无法解析为数值: "${trimmed}"`;
  } else {
    base.diagnostic = `未知/不支持的 ${kind} 单位: "${unit}"`;
  }
  return base;
}

export function toBase(q: Quantified): number | null {
  if (q.value === null || !q.convertible) return null;
  switch (q.kind) {
    case "angle":
      return q.value * (ANGLE_TO_RAD[q.unit.trim()] ?? NaN);
    case "length":
      return q.value * (LENGTH_TO_NM[q.unit.trim()] ?? NaN);
    case "dose":
      return q.value * (DOSE_TO_E_PER_A2[q.unit.trim()] ?? NaN);
    case "pixel":
      return q.value;
    default:
      return q.value;
  }
}
