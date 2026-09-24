// 领域量单位与坐标基准。导入时保留原始表示(raw)，派生层才做规范化；
// 无法转换的值留在原位置并附诊断，不能为了画图而丢掉。

export type QuantityKind = 'angle' | 'pixel_size' | 'dose' | 'length';

export interface Quantity {
  raw: string; // 原始表示，永不改写
  kind: QuantityKind;
  value?: number; // 规范化后的数值
  unit?: string; // 规范化后的单位
  diagnostic?: string; // 无法转换时的诊断
}

const ANGLE_UNITS: Record<string, number> = { deg: 1, '°': 1, rad: 180 / Math.PI };
const LENGTH_TO_NM: Record<string, number> = { nm: 1, A: 0.1, Å: 0.1, angstrom: 0.1, px: NaN };

function parseNumberAndUnit(raw: string): { num: number; unit: string } | null {
  const m = /^\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([^\s]+)\s*$/.exec(raw);
  if (!m) return null;
  return { num: Number(m[1]), unit: m[2] };
}

export function normalizeQuantity(raw: string, kind: QuantityKind): Quantity {
  const parsed = parseNumberAndUnit(raw);
  if (!parsed) {
    return { raw, kind, diagnostic: `unparseable_quantity: 无法解析 "${raw}"，原值保留在原位置` };
  }
  const { num, unit } = parsed;
  switch (kind) {
    case 'angle': {
      const f = ANGLE_UNITS[unit];
      if (f === undefined) return { raw, kind, diagnostic: `unknown_angle_unit: ${unit}` };
      return { raw, kind, value: num * f, unit: 'deg' };
    }
    case 'pixel_size': {
      // 形如 0.214 nm/px 或 2.14 A/px
      const m = /^([^/]+)\/px$/.exec(unit);
      if (!m || LENGTH_TO_NM[m[1]] === undefined || Number.isNaN(LENGTH_TO_NM[m[1]])) {
        return { raw, kind, diagnostic: `unknown_pixel_size_unit: ${unit}` };
      }
      return { raw, kind, value: num * LENGTH_TO_NM[m[1]], unit: 'nm/px' };
    }
    case 'dose': {
      // 规范化到 e-/A2
      if (unit === 'e-/A2' || unit === 'e-/Å2' || unit === 'e-/Å^2') return { raw, kind, value: num, unit: 'e-/A2' };
      if (unit === 'e-/nm2') return { raw, kind, value: num / 100, unit: 'e-/A2' };
      return { raw, kind, diagnostic: `unknown_dose_unit: ${unit}` };
    }
    case 'length': {
      const f = LENGTH_TO_NM[unit];
      if (f === undefined || Number.isNaN(f)) return { raw, kind, diagnostic: `unknown_length_unit: ${unit}` };
      return { raw, kind, value: num * f, unit: 'nm' };
    }
  }
}

// 坐标基准声明：图像坐标以像素为单位、原点在探测器左上角；
// 样品坐标以 nm 为单位，倾转轴不必穿过图像中心。
export interface FrameGeometry {
  width_px: number;
  height_px: number;
  pixel_size: Quantity; // nm/px
  tilt_axis: {
    in_plane_angle: Quantity; // deg，倾转轴在图像平面内的朝向
    offset_from_center: Quantity; // nm，轴线相对图像中心的偏心距（可非零）
  };
}
