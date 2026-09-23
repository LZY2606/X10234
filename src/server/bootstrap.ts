import { Store } from "./store";
import { AppService } from "./app-service";
import { COMPOSITE_SPEC, DEMO_SPEC, MINIMAL_FRAGMENTS } from "../core/scenarios";
import { SERIES_ID } from "../shared/ids";

export interface BootstrapResult {
  primaryEventSeq: number;
  fragmentCount: number;
}

/**
 * 初始化离线案例包：
 *  - 主叙事序列（含轴线偏心/缺口/交换/坏帧/缺失高倾角/过拟合离群/坏剂量）
 *  - 七个最小反例片段（各自独立分支、独立解释版本与决定；原始帧 blob 内容寻址共享）
 *  - 一个组合片段
 */
export function bootstrapIfEmpty(store: Store, force = false): BootstrapResult {
  if (force) store.reset();
  if (store.headSeq() > 0 && !force) {
    return { primaryEventSeq: store.headSeq(), fragmentCount: store.allFragments().length };
  }
  const svc = new AppService(store);

  // 主叙事：unconstrained 轴（暴露偏心），排除帧候选额外丢弃两个高倾角帧
  svc.importAcquisition(DEMO_SPEC, {
    branch: "main",
    actor: "em-team@lab",
    reason: "初始导入：倾转序列 + 曝光剂量 + fiducial 轨迹（全量版本化）",
    label: "主线：原始导入",
    fragmentId: "fragment:primary",
    scope: "primary",
    standalone: true,
    excludeCandidateDrops: ["frame:10", "frame:11"],
    axisPolicy: "unconstrained",
    ambiguityThresholdPx: 0.6,
    maxLocalWarpNorm: 0.02
  });

  // 七个最小片段（独立分支）
  for (const f of MINIMAL_FRAGMENTS) {
    svc.importAcquisition(f.spec, {
      branch: `frag-${f.scenario}`,
      actor: "case-pack",
      reason: `最小反例片段：${f.scenario}。${f.expected}`,
      label: `片段·${f.scenario}`,
      fragmentId: `fragment:min:${f.scenario}`,
      scope: "minimal",
      standalone: true,
      excludeCandidateDrops: f.scenario === "missing-high-tilt" ? [] : undefined,
      axisPolicy: "unconstrained",
      ambiguityThresholdPx: f.scenario === "multi-solution" ? 1.4 : 0.6,
      maxLocalWarpNorm: 0.02,
      expectedTiltRangeDeg: f.scenario === "missing-high-tilt" ? 45 : 55
    });
  }

  // 组合片段
  svc.importAcquisition(COMPOSITE_SPEC, {
    branch: "frag-composite",
    actor: "case-pack",
    reason: "组合反例片段：叠加轴线偏心、身份交换、缺失高倾角、坏帧、过拟合等边界组合",
    label: "片段·组合",
    fragmentId: "fragment:composite:all",
    scope: "composite",
    standalone: true,
    excludeCandidateDrops: ["frame:10", "frame:11"],
    axisPolicy: "unconstrained",
    ambiguityThresholdPx: 0.9,
    maxLocalWarpNorm: 0.02
  });

  // 主叙事第二阶段：参数修订（instrument-center => 显式记录偏心冲突），触发候选失效
  svc.reviseParameters(
    "main",
    { axisPolicy: "instrument-anchored", ambiguityResidualThresholdPx: 0.6 },
    "reviewer@lab",
    store.branchHeadSeq("branch:main"),
    "参数修订 v2：套用仪器日志中心轴先验，验证轴线偏心冲突与全局候选失效"
  );
  // 第三阶段：再改回 unconstrained（演示版本链），并对单帧倾角做局部源修订
  svc.reviseParameters(
    "main",
    { axisPolicy: "unconstrained" },
    "reviewer@lab",
    store.branchHeadSeq("branch:main"),
    "参数修订 v3：恢复无约束轴拟合（保留 v2 历史可读）"
  );
  svc.reviseFrameAngle(
    "main",
    "frame:03",
    -28,
    "reviewer@lab",
    store.branchHeadSeq("branch:main"),
    "源数据修订：采集记录 -30° 经几何复核更正为 -28°（仅局部失效）"
  );

  // 身份修复分支：从 main 分叉，修复 fid:01/fid:03 交换
  svc.forkBranch(
    "main",
    "swap-fix",
    "身份交换修复",
    "分支：把缺口后的 fid:01/fid:03 标签交换回正确物理点",
    "reviewer@lab",
    store.branchHeadSeq("branch:main")
  );
  svc.repairTrackSwap(
    "swap-fix",
    "reviewer@lab",
    store.branchHeadSeq("branch:swap-fix"),
    "接受 track-swap 诊断并修复解释版本"
  );

  // 多解片段：保留全部合法候选（无裁定）；主线上对刚体做接受、对排除帧做否定
  svc.adjudicate(
    "main",
    "rigid",
    "accepted",
    "相同有效点集上刚体残差与覆盖度综合最优；拒绝少帧换低残差。",
    "reviewer@lab",
    store.branchHeadSeq("branch:main")
  );
  svc.adjudicate(
    "main",
    "exclude-frames",
    "rejected",
    "仅在子集上残差低；标准点集不优且覆盖度下降，违反规则。",
    "reviewer@lab",
    store.branchHeadSeq("branch:main")
  );
  svc.lockRegistration(
    "main",
    "rigid",
    "锁定刚体 v 供断层重建引用",
    "reviewer@lab",
    store.branchHeadSeq("branch:main")
  );

  return { primaryEventSeq: store.headSeq(), fragmentCount: store.allFragments().length };
}

export { SERIES_ID };
