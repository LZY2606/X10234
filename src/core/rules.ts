import type { RulePack } from "./domain.js";

export const RULE_CODES = {
  AXIS_NOT_FIXED_AT_CENTER: "AXIS_NOT_FIXED_AT_CENTER",
  TRACKS_MAY_BREAK_AND_SWAP: "TRACKS_MAY_BREAK_AND_SWAP",
  SAME_EFFECTIVE_SET_COMPARISON: "SAME_EFFECTIVE_SET_COMPARISON",
} as const;

/** 推导规则以版本化规则包保存；参数修订产生新版本，不覆盖旧版本。 */
export function rulePackV1(): RulePack {
  return {
    id: "rules.registration",
    version: 1,
    statements: [
      { code: RULE_CODES.AXIS_NOT_FIXED_AT_CENTER, text: "倾转轴不能被默认固定在图像中心" },
      { code: RULE_CODES.TRACKS_MAY_BREAK_AND_SWAP, text: "fiducial 轨迹可断裂且可能身份交换" },
      {
        code: RULE_CODES.SAME_EFFECTIVE_SET_COMPARISON,
        text: "不同候选用相同有效点集比较，不用少帧换低残差",
      },
    ],
    params: {
      expectedMaxTiltDeg: 56,
      axisCenterSearchHalfPx: 16,
      axisAngleSearchHalfDeg: 12,
      overfitGainThreshold: 0.2,
      swapResidualGain: 0.5,
      multiSolutionResidualTolerance: 0.03,
      badFrameResidualFactor: 3,
    },
  };
}

/** 参数修订版：放宽轴线搜索范围、收紧过拟合阈值。旧版本仍可读取。 */
export function rulePackV2(): RulePack {
  const v1 = rulePackV1();
  return {
    ...v1,
    version: 2,
    params: {
      ...v1.params,
      axisCenterSearchHalfPx: 24,
      overfitGainThreshold: 0.15,
    },
  };
}

export function getRulePack(version: number): RulePack {
  if (version === 1) return rulePackV1();
  if (version === 2) return rulePackV2();
  throw new Error(`未知规则包版本 rules.registration@${version}`);
}

export const LATEST_RULEPACK_VERSION = 2;
