export type ScenarioCode =
  | 'axis-eccentric'
  | 'track-identity-swap'
  | 'missing-high-tilt'
  | 'bad-frame-exclusion'
  | 'local-warp-overfit'
  | 'multi-solution'
  | 'concurrent-freeze';

export const SCENARIOS: { code: ScenarioCode; title: string; expectation: string }[] = [
  {
    code: 'axis-eccentric',
    title: '轴线偏心',
    expectation: 'RULE_AXIS_NOT_CENTER：自由轴候选恢复偏心；强制中心候选在高倾角系统性残差。'
  },
  {
    code: 'track-identity-swap',
    title: '轨迹身份交换',
    expectation: 'RULE_TRACK_BREAKABLE_SWAPPABLE：存在断裂段与交换映射；用交换映射重解残差显著下降。'
  },
  {
    code: 'missing-high-tilt',
    title: '缺失高倾角帧',
    expectation: '缺口是 not-acquired，禁止被当成坏帧删除；轴线不确定度上升。'
  },
  {
    code: 'bad-frame-exclusion',
    title: '坏帧排除',
    expectation: 'RULE_NO_FRAME_DROPPING_FOR_RESIDUAL：少帧不能换低残差；只允许带原因的手工排除。'
  },
  {
    code: 'local-warp-overfit',
    title: '局部形变过拟合',
    expectation: '局部候选 train 低但 held-out 高；标记 overfit，不采纳。'
  },
  {
    code: 'multi-solution',
    title: '多解',
    expectation: 'RULE_KEEP_ALL_LEGAL_CANDIDATES：保留全部等残差合法轴线候选等待裁定。'
  },
  {
    code: 'concurrent-freeze',
    title: '并发冻结',
    expectation: 'RULE_CONCURRENT_VERSION_CONFLICT：后提交看到版本冲突与双方差异，需在新事件上解决。'
  }
];
