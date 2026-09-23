import { createHash } from "node:crypto";
import type {
  ConversionDiagnostic,
  ElectronDose,
  PhysicalAngle,
  PixelScale
} from "./types.js";

/** 稳定内容哈希：用于片段去重、实体版本内容摘要、有效点集身份 */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** 规范化序列化：键排序，保证跨导入/导出的哈希稳定 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * 导入层解析：保留 rawText，无法转换时值留在原位(null)并附诊断，
 * 不抛异常、不为画图而丢值。
 */
export function parseAngle(rawText: string, framePath: string, diags: ConversionDiagnostic[]): PhysicalAngle {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(deg|°)?\s*$/i.exec(rawText);
  if (!match) {
    diags.push({
      code: "angle.out-of-range",
      at: framePath,
      rawText,
      message: "倾角无法解析，原始表示保留"
    });
    return { value: NaN, unit: "deg" };
  }
  const value = Number(match[1]);
  if (value < -90 || value > 90) {
    diags.push({
      code: "angle.out-of-range",
      at: framePath,
      rawText,
      message: `倾角 ${value} 超出 [-90,90] deg`
    });
  }
  return { value, unit: "deg" };
}

export function parsePixelScale(rawText: string, path: string, diags: ConversionDiagnostic[]): PixelScale {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(nm\/px|nm\/pixel)\s*$/i.exec(rawText);
  if (!match) {
    diags.push({
      code: "pixel-scale.missing",
      at: path,
      rawText,
      message: "像素尺度无法解析，原始表示保留"
    });
    return { value: NaN, unit: "nm/px" };
  }
  return { value: Number(match[1]), unit: "nm/px" };
}

export function parseDose(rawText: string, framePath: string, diags: ConversionDiagnostic[]): ElectronDose {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:e-\/A\^2|e\/A2|e\/angstrom2)\s*$/i.exec(rawText);
  if (!match) {
    diags.push({
      code: "dose.unparseable",
      at: framePath,
      rawText,
      message: "曝光剂量无法转换，值保留在原始位置"
    });
    return { value: null, unit: "e-/A^2" };
  }
  return { value: Number(match[1]), unit: "e-/A^2" };
}
