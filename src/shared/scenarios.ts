/**
 * 七个固定边界情形 + 组合情形。固定案例与断言都使用这些稳定代码，
 * 不允许改名（事件、诊断、UI 都引用它们）。
 */
export const SCENARIO_CODES = [
  'AXIS_OFF_CENTER',
  'TRACK_IDENTITY_SWAP',
  'MISSING_HIGH_TILT_FRAMES',
  'BAD_FRAME_EXCLUSION',
  'LOCAL_WARP_OVERFIT',
  'AMBIGUOUS_MULTI_SOLUTION',
  'CONCURRENT_FREEZE',
] as const;

export type ScenarioCode = (typeof SCENARIO_CODES)[number];

export const SCENARIO_LABEL: Record<ScenarioCode, string> = {
  AXIS_OFF_CENTER: '轴线偏心',
  TRACK_IDENTITY_SWAP: '轨迹身份交换',
  MISSING_HIGH_TILT_FRAMES: '缺失高倾角帧',
  BAD_FRAME_EXCLUSION: '坏帧排除',
  LOCAL_WARP_OVERFIT: '局部形变过拟合',
  AMBIGUOUS_MULTI_SOLUTION: '多解',
  CONCURRENT_FREEZE: '并发冻结',
};

/** 组合情形（叙事主案例同时携带全部七种情形） */
export const COMBINED_SCENARIO = 'COMBINED_TILT_FUSION_ROOM';
