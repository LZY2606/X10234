/**
 * 领域量必须携带单位或坐标基准。
 * 导入时保留原始表示，派生层才做规范化；无法转换留在原位并附诊断。
 */
export type AngleUnit = 'degree' | 'radian';
export type LengthUnit = 'nm' | 'angstrom' | 'pixel' | 'um';
export type DoseUnit = 'e-/A^2' | 'e/nm^2';
export type CoordinateFrame = 'image-pixel' | 'stage' | 'frame-local';

export interface DomainQuantity<V = number> {
  value: V;
  unit: string;
  coordinateFrame?: CoordinateFrame;
  /** 导入时的原始文本表示，永不丢弃。 */
  rawRepresentation: string;
}

export function makeQuantity(
  value: number,
  unit: string,
  rawRepresentation: string,
  coordinateFrame?: CoordinateFrame
): DomainQuantity {
  return { value, unit, rawRepresentation, coordinateFrame };
}

const ANGLE_TO_RADIAN: Record<AngleUnit, number> = {
  degree: Math.PI / 180,
  radian: 1
};

const LENGTH_TO_NM: Record<LengthUnit, number> = {
  nm: 1,
  angstrom: 0.1,
  um: 1000,
  pixel: NaN // 需要像素尺度才能转换，保持在原位置
};

const DOSE_TO_E_PER_A2: Record<DoseUnit, number> = {
  'e-/A^2': 1,
  'e/nm^2': 0.01
};

export interface ConversionDiagnostic {
  code:
    | 'OK'
    | 'UNKNOWN_UNIT'
    | 'PIXEL_LENGTH_NEEDS_PIXEL_SCALE'
    | 'UNPARSEABLE_NUMBER';
  message: string;
}

export interface ConvertedAngle {
  radians: number;
  diagnostic: ConversionDiagnostic;
}

export function normalizeAngle(q: DomainQuantity): ConvertedAngle {
  const factor = ANGLE_TO_RADIAN[q.unit as AngleUnit];
  if (factor === undefined) {
    return {
      radians: NaN,
      diagnostic: {
        code: 'UNKNOWN_UNIT',
        message: `未知角度单位 '${q.unit}'，保留原始表示 '${q.rawRepresentation}'`
      }
    };
  }
  if (!Number.isFinite(q.value)) {
    return {
      radians: NaN,
      diagnostic: {
        code: 'UNPARSEABLE_NUMBER',
        message: `无法解析角度 '${q.rawRepresentation}'`
      }
    };
  }
  return { radians: q.value * factor, diagnostic: { code: 'OK', message: '' } };
}

export function normalizeDose(q: DomainQuantity): {
  ePerA2: number;
  diagnostic: ConversionDiagnostic;
} {
  const factor = DOSE_TO_E_PER_A2[q.unit as DoseUnit];
  if (factor === undefined) {
    return {
      ePerA2: NaN,
      diagnostic: {
        code: 'UNKNOWN_UNIT',
        message: `未知剂量单位 '${q.unit}'，保留原始表示 '${q.rawRepresentation}'`
      }
    };
  }
  if (!Number.isFinite(q.value)) {
    return {
      ePerA2: NaN,
      diagnostic: {
        code: 'UNPARSEABLE_NUMBER',
        message: `无法解析剂量 '${q.rawRepresentation}'`
      }
    };
  }
  return { ePerA2: q.value * factor, diagnostic: { code: 'OK', message: '' } };
}

/**
 * 像素尺度：nm/pixel（原始单位保留）。
 * pixel 作为长度单位时无法在缺少像素尺度的情况下转换 -> 诊断并留在原位。
 */
export function pixelScaleToNmPerPixel(q: DomainQuantity): {
  nmPerPixel: number;
  diagnostic: ConversionDiagnostic;
} {
  if (q.unit === 'nm/pixel') {
    return Number.isFinite(q.value)
      ? { nmPerPixel: q.value, diagnostic: { code: 'OK', message: '' } }
      : {
          nmPerPixel: NaN,
          diagnostic: {
            code: 'UNPARSEABLE_NUMBER',
            message: `无法解析像素尺度 '${q.rawRepresentation}'`
          }
        };
  }
  if (q.unit === 'angstrom/pixel') {
    return Number.isFinite(q.value)
      ? { nmPerPixel: q.value * 0.1, diagnostic: { code: 'OK', message: '' } }
      : {
          nmPerPixel: NaN,
          diagnostic: {
            code: 'UNPARSEABLE_NUMBER',
            message: `无法解析像素尺度 '${q.rawRepresentation}'`
          }
        };
  }
  return {
    nmPerPixel: NaN,
    diagnostic: {
      code: 'UNKNOWN_UNIT',
      message: `未知像素尺度单位 '${q.unit}'，保留原始表示 '${q.rawRepresentation}'`
    }
  };
}

export function warnPixelLength(q: DomainQuantity): ConversionDiagnostic | null {
  if (q.unit === 'pixel') {
    return {
      code: 'PIXEL_LENGTH_NEEDS_PIXEL_SCALE',
      message: `长度以 pixel 给出 (${q.rawRepresentation})，转换到物理长度需要像素尺度；保留原位`
    };
  }
  if (LENGTH_TO_NM[q.unit as LengthUnit] === undefined) {
    return {
      code: 'UNKNOWN_UNIT',
      message: `未知长度单位 '${q.unit}'，保留原始表示 '${q.rawRepresentation}'`
    };
  }
  return null;
}
