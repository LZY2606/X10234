/**
 * 导入契约（离线案例包 + 通用导入共用）。
 * 直接采用领域词汇；数值以 {raw,unit,basis} 或 {value,unit} 表达。
 */
export interface PackAngle { frameSeq: number; raw: string }
export interface PackFrame {
  frameSeq: number;
  /** 原始帧字节；最小/组合输入共享同一内容时使用同一 bytes（内容寻址只存一份） */
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** 每帧剂量，原始表示如 "2.1 e-/Å^2" 或故意无法转换的 "2.1 flux" */
  doseRaw: string;
}
export interface PackMarkerObs {
  markerId: string;
  frameSeq: number;
  xPx?: number;
  yPx?: number;
  observed: boolean;
}
export interface PackGap {
  markerId: string;
  fromFrameSeq: number;
  toFrameSeq: number;
  reason: string;
}
export interface PackExclusion {
  frameSeq: number;
  reason: string;
  author: string;
  atIso: string;
}

/** 单个最小输入或组合输入。原始片段内容寻址共享；解释/诊断/决定独立。 */
export interface PackVariant {
  key: string;
  title: string;
  description: string;
  /** 覆盖主 pack 的帧/角度/观测等，形成该变体自己的源版本 */
  frameOverrides?: PackFrame[];
  angleOverrides?: PackAngle[];
  /** 缺帧（缺失高倾角帧 / 坏帧排除情形下从采集序列里拿掉的帧） */
  missingFrameSeqs?: number[];
  markerOverrides?: PackMarkerObs[];
  gaps?: PackGap[];
  exclusions?: PackExclusion[];
  /** 无法转换的值保留（如像素尺度写成未知单位） */
  pixelScaleRaw?: string;
}

export interface TiltPack {
  tiltSeriesId: string;
  name: string;
  signConvention: string;
  pixelScaleRaw: string;
  widthPx: number;
  heightPx: number;
  /** 完整倾角表（原始表示），变体可覆盖或缺帧 */
  angles: PackAngle[];
  frames: PackFrame[];
  markerObservations: PackMarkerObs[];
  gaps: PackGap[];
  exclusions: PackExclusion[];
  /** 后续场景时间线：参数修订 / 局部源改动 / 冲突人工决定 */
  timeline: PackTimelineStep[];
  variants: PackVariant[];
}

export type PackTimelineStep =
  | { kind: 'param-revision'; atIso: string; title: string; pixelScaleRaw?: string; signConvention?: string }
  | { kind: 'local-source-change'; atIso: string; title: string; frameSeq: number; dxPx?: number; dyPx?: number; reason: string }
  | { kind: 'conflicting-decisions'; atIso: string; title: string; frameSeq: number; authorA: string; authorB: string; reasonA: string; reasonB: string };
