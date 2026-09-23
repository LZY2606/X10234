// 机器可读的判断依据：事件的 ruleIds 与候选的 ruleChecks 都引用这里的 id。
export interface DomainRule {
  ruleId: string;
  statement: string;
}

export const RULES: Record<string, DomainRule> = {
  "axis.not-centered-by-default": {
    ruleId: "axis.not-centered-by-default",
    statement: "倾转轴不能被默认固定在图像中心；未估计出的偏移必须保持为自由量。"
  },
  "track.breakable-swappable": {
    ruleId: "track.breakable-swappable",
    statement: "fiducial 轨迹可断裂且可能身份交换；段链接是显式裁定而非隐式拼接。"
  },
  "candidate.same-effective-points": {
    ruleId: "candidate.same-effective-points",
    statement: "不同候选用相同有效点集比较；pointsHash 不同不得直接比残差。"
  },
  "candidate.no-fewer-frames-for-lower-residual": {
    ruleId: "candidate.no-fewer-frames-for-lower-residual",
    statement: "不允许用少帧换低残差；降覆盖必须单独记录并接受高倾角覆盖检查。"
  },
  "solution.keep-all-legal-candidates": {
    ruleId: "solution.keep-all-legal-candidates",
    statement: "无法唯一决定时保留全部合法候选，由人工裁定，不得静默择优。"
  },
  "branch.concurrent-conflict": {
    ruleId: "branch.concurrent-conflict",
    statement: "两个窗口并发保存时，后提交者必须看到版本冲突及双方差异，分支冻结待裁定。"
  }
};

export const RULE_IDS = Object.keys(RULES);

export function checkRule(ruleId: string, passed: boolean, evidence: string) {
  return { ruleId, passed, evidence };
}
