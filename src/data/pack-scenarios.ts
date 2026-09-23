import type { SeriesMaterial } from "../domain/synthetic.js";
import {
  AXIS_FREE,
  baseSidecarSubset,
  baselineSidecar,
  fullAs,
  REVIEWED_LINKSET
} from "./pack-sidecar.js";
import type { InputSidecar, ScenarioCode, VariantPack } from "./pack-types.js";

function pack(
  code: ScenarioCode,
  title: string,
  variant: "minimal" | "combined",
  directSourceChange: string,
  sidecar: InputSidecar,
  replay: VariantPack["replay"],
  expectations: VariantPack["expectations"]
): VariantPack {
  return { scenarioCode: code, scenarioTitle: title, variant, directSourceChange, sidecar, replay, expectations };
}

const CID = (interp: string, kind: string) => `c-${interp}-${kind}`;

function axisOffset(mat: SeriesMaterial): VariantPack[] {
  const minimal = baseSidecarSubset(
    mat,
    "axis-offset",
    new Set(["f00", "f02", "f04", "f06", "f08", "f10", "f12"])
  );
  minimal.interpretations[0].note = "最小：跨倾角 7 帧，轴仍被居中假设";

  const combined = fullAs(mat, "axis-offset");
  combined.axes.push(AXIS_FREE);
  combined.interpretations.push({
    interpretationId: "interp-axis-free",
    label: "自由轴心解释",
    axisId: "axis-1",
    axisVersion: 2,
    linkSetId: "ls-naive",
    excludedFrameIds: ["f09"],
    note: "轴修订后的新解释，旧解释仍可读"
  });

  return [
    pack("axis-offset", "轴线偏心", "minimal", "（无）最小输入本身仅含居中轴假设的 7 帧子集", minimal, [
      { id: "ao-m-import", kind: "import-variant", variant: "minimal", summary: "导入最小子集（7 帧）" },
      { id: "ao-m-compute", kind: "compute-candidates", variant: "minimal", interpretationId: "interp-axis-offset-minimal", summary: "居中轴假设下计算候选，出现 axis.center-default 警告" }
    ], {
      must: [{ code: "axis.center-default", evidence: "axis-1@v1 是 centeredAssumption" }],
      rejectedCandidateKinds: []
    }),
    pack("axis-offset", "轴线偏心", "combined", "新增 axis-1@v2：轴心从居中假设改为自由估计；只改轴线这一条直接来源", combined, [
      { id: "ao-c-import", kind: "import-variant", variant: "combined", summary: "导入组合输入" },
      { id: "ao-c-compute-old", kind: "compute-candidates", variant: "combined", interpretationId: "interp-baseline", summary: "旧解释候选仍保留（居中假设）" },
      { id: "ao-c-revise", kind: "revise-axis", variant: "combined", axis: AXIS_FREE, reason: "基线候选残差呈系统性偏移，释放轴心", summary: "修订轴线；依赖它的旧候选标记失效范围" },
      { id: "ao-c-compute-new", kind: "compute-candidates", variant: "combined", interpretationId: "interp-axis-free", summary: "用自由轴心重算，得到偏心估计" },
      { id: "ao-c-accept", kind: "adjudicate", variant: "combined", interpretationId: "interp-axis-free", candidateKind: "rigid-excluded", candidateId: CID("interp-axis-free", "rigid-excluded"), verdict: "accepted", reason: "自由轴心残差更低且无系统性偏移", summary: "接受自由轴刚体候选" },
      { id: "ao-c-lock", kind: "lock", variant: "combined", interpretationId: "interp-axis-free", candidateKind: "rigid-excluded", candidateId: CID("interp-axis-free", "rigid-excluded"), reason: "轴线修订复核完成", summary: "锁定自由轴版本" }
    ], {
      must: [
        { code: "axis.estimated-offset", evidence: "自由轴心估计偏心约 (14,-9) px" },
        { code: "candidate.invalidated", evidence: "依赖 axis-1@v1 的候选因轴线修订失效，范围只限该解释" }
      ],
      adoptedCandidateKind: "rigid-excluded",
      rejectedCandidateKinds: [],
      invalidatedCandidates: [CID("interp-baseline", "rigid"), CID("interp-baseline", "local-deformation"), CID("interp-baseline", "rigid-excluded")]
    })
  ];
}

function identitySwap(mat: SeriesMaterial): VariantPack[] {
  const minimal = baseSidecarSubset(mat, "identity-swap", new Set(["f04", "f05", "f06", "f07", "f08"]));
  minimal.interpretations[0].note = "最小：交叉区 5 帧，朴素链接把 T4/T5 缝合错身份";

  const combined = fullAs(mat, "identity-swap");
  combined.linkSets.push(REVIEWED_LINKSET);
  combined.interpretations.push({
    interpretationId: "interp-identity-reviewed",
    label: "身份复核解释（交叉链接）",
    axisId: "axis-1",
    axisVersion: 1,
    linkSetId: "ls-reviewed",
    excludedFrameIds: ["f09"],
    note: "只改链接集这一条直接来源；原始观测坐标不变"
  });

  return [
    pack("identity-swap", "轨迹身份交换", "minimal", "（无）最小输入只含交叉区帧与朴素链接", minimal, [
      { id: "is-m-import", kind: "import-variant", variant: "minimal", summary: "导入交叉区 5 帧" },
      { id: "is-m-compute", kind: "compute-candidates", variant: "minimal", interpretationId: "interp-identity-swap-minimal", summary: "朴素链接候选出现 track.identity-swap 警告" }
    ], {
      must: [{ code: "track.identity-swap", evidence: "朴素链接下交叉区逐轨残差异常" }],
      rejectedCandidateKinds: ["rigid"]
    }),
    pack("identity-swap", "轨迹身份交换", "combined", "新增 ls-reviewed 链接集（交叉续接）；只改轨迹身份解释，观测字节不变", combined, [
      { id: "is-c-import", kind: "import-variant", variant: "combined", summary: "导入组合输入（两个链接集）" },
      { id: "is-c-links", kind: "import-variant", variant: "combined", summary: "记录身份链接提议与复核事件（accepted/rejected 都保留）" },
      { id: "is-c-compute", kind: "compute-candidates", variant: "combined", interpretationId: "interp-identity-reviewed", summary: "复核链接集候选残差正常；朴素链接候选保留并标记未采纳" },
      { id: "is-c-accept", kind: "adjudicate", variant: "combined", interpretationId: "interp-identity-reviewed", candidateKind: "rigid-excluded", candidateId: CID("interp-identity-reviewed", "rigid-excluded"), verdict: "accepted", reason: "交叉链接恢复投影一致性", summary: "接受复核链接候选" },
      { id: "is-c-lock", kind: "lock", variant: "combined", interpretationId: "interp-identity-reviewed", candidateKind: "rigid-excluded", candidateId: CID("interp-identity-reviewed", "rigid-excluded"), reason: "身份交换裁定完成", summary: "锁定复核链接版本" }
    ], {
      must: [
        { code: "track.identity-swap", evidence: "ls-naive 候选被标记身份交换；ls-reviewed 候选残差显著更低" },
        { code: "candidate.same-effective-points", evidence: "两链接集候选使用各自 pointsHash，仅同 pointsHash 内比较" }
      ],
      adoptedCandidateKind: "rigid-excluded",
      rejectedCandidateKinds: ["rigid"]
    })
  ];
}

function missingHighTilt(mat: SeriesMaterial): VariantPack[] {
  const minimal = baseSidecarSubset(
    mat,
    "missing-high-tilt",
    new Set(["f04", "f05", "f06", "f07", "f08"])
  );
  minimal.interpretations[0].note = "最小：仅 -36..+24°，两端高倾角帧全部缺失";

  const combined = fullAs(mat, "missing-high-tilt");
  combined.frames = combined.frames.map((fr) =>
    fr.frameId === "f12" ? { ...fr, include: false } : fr
  );
  combined.gaps.push({
    gapId: "gap-manual-f12",
    segmentId: "seg-1",
    missingFrameId: "f12",
    reason: "manual",
    rawText: "f12 因采集中断未导入（最高倾角 +72° 帧缺失）"
  });
  combined.interpretations[0].note = "组合：原始序列完整，但 f12 采集缺失；不得用少帧换低残差";

  return [
    pack("missing-high-tilt", "缺失高倾角帧", "minimal", "（无）最小输入天然没有高倾角帧", minimal, [
      { id: "mh-m-import", kind: "import-variant", variant: "minimal", summary: "导入无高倾角的 5 帧子集" },
      { id: "mh-m-compute", kind: "compute-candidates", variant: "minimal", interpretationId: "interp-missing-high-tilt-minimal", summary: "候选被 coverage.high-tilt-missing 阻断" }
    ], {
      must: [{ code: "coverage.high-tilt-missing", evidence: "没有 |θ|>=50° 的有效帧" }],
      rejectedCandidateKinds: ["rigid", "local-deformation", "rigid-excluded"]
    }),
    pack("missing-high-tilt", "缺失高倾角帧", "combined", "f12 采集缺失并登记为 manual 缺口；其余字节不动", combined, [
      { id: "mh-c-import", kind: "import-variant", variant: "combined", summary: "导入组合输入（f12 标记缺失）" },
      { id: "mh-c-compute", kind: "compute-candidates", variant: "combined", interpretationId: "interp-baseline", summary: "候选即使残差低也被高倾角覆盖检查阻断" },
      { id: "mh-c-reject", kind: "adjudicate", variant: "combined", interpretationId: "interp-baseline", candidateKind: "rigid", candidateId: CID("interp-baseline", "rigid"), verdict: "rejected", reason: "少帧低残差不可采纳：缺 +72° 高倾角约束", summary: "拒绝缺帧候选并保留诊断" }
    ], {
      must: [
        { code: "coverage.high-tilt-missing", evidence: "f12 缺失导致最高倾角覆盖不足" },
        { code: "candidate.no-fewer-frames-for-lower-residual", evidence: "规则检查失败：不能用少帧换低残差" }
      ],
      rejectedCandidateKinds: ["rigid", "local-deformation", "rigid-excluded"]
    })
  ];
}

function badFrame(mat: SeriesMaterial): VariantPack[] {
  const minimal = baseSidecarSubset(
    mat,
    "bad-frame",
    new Set(["f07", "f08", "f09", "f10", "f11"])
  );
  minimal.exclusions.push({
    frameId: "f09",
    reason: "运动模糊：fiducial 拖影",
    rawText: "f09 motion-blur, fiducial streaks, reviewed by hongmei",
    decidedBy: "hongmei"
  });
  const f09 = minimal.frames.find((f) => f.frameId === "f09")!;
  f09.doseRaw = "two e-/A^2";
  f09.dose = null;
  minimal.diagnostics.push({
    code: "dose.unparseable",
    at: "f09.dose",
    rawText: "two e-/A^2",
    message: "曝光剂量无法转换，原始表示保留在原位置，不删值不画图替代"
  });
  minimal.interpretations[0].excludedFrameIds = ["f09"];
  minimal.interpretations[0].note = "最小：坏帧 5 片窗口；f09 剂量无法转换但保留原始文本";

  const combined = fullAs(mat, "bad-frame");
  combined.interpretations.push({
    interpretationId: "interp-badframe-keep",
    label: "保留坏帧的刚体解释（对照）",
    axisId: "axis-1",
    axisVersion: 1,
    linkSetId: "ls-naive",
    excludedFrameIds: [],
    note: "同一有效点集比较：保留 f09 的候选 vs 排除 f09 的候选"
  });

  return [
    pack("bad-frame", "坏帧排除", "minimal", "f09 的剂量文本损坏（无法转换）；帧字节与排除原因保留", minimal, [
      { id: "bf-m-import", kind: "import-variant", variant: "minimal", summary: "导入坏帧窗口；剂量诊断登记但不回滚整次导入" },
      { id: "bf-m-compute", kind: "compute-candidates", variant: "minimal", interpretationId: "interp-bad-frame-minimal", summary: "计算排除坏帧候选" }
    ], {
      must: [
        { code: "dose.unparseable", evidence: "f09.dose 原始文本保留，诊断附在原位置" },
        { code: "frame.bad-excluded", evidence: "f09 手工排除原因随解释保留" }
      ],
      rejectedCandidateKinds: []
    }),
    pack("bad-frame", "坏帧排除", "combined", "新增 interp-badframe-keep 对照解释（不排除 f09）；f09 字节不变", combined, [
      { id: "bf-c-import", kind: "import-variant", variant: "combined", summary: "导入组合输入" },
      { id: "bf-c-compute-keep", kind: "compute-candidates", variant: "combined", interpretationId: "interp-badframe-keep", summary: "保留坏帧候选：f09 单帧残差显著偏大" },
      { id: "bf-c-compute-excl", kind: "compute-candidates", variant: "combined", interpretationId: "interp-baseline", summary: "排除坏帧候选：相同有效点集口径下比较" },
      { id: "bf-c-reject-keep", kind: "adjudicate", variant: "combined", interpretationId: "interp-badframe-keep", candidateKind: "rigid", candidateId: CID("interp-badframe-keep", "rigid"), verdict: "rejected", reason: "f09 是确认的运动模糊，保留它污染全局刚体解", summary: "拒绝保留坏帧候选" },
      { id: "bf-c-accept", kind: "adjudicate", variant: "combined", interpretationId: "interp-baseline", candidateKind: "rigid-excluded", candidateId: CID("interp-baseline", "rigid-excluded"), verdict: "accepted", reason: "排除理由可溯源，且高倾角覆盖完整", summary: "接受排除坏帧候选" }
    ], {
      must: [
        { code: "frame.bad-excluded", evidence: "两个解释各自保留采纳/未采纳结果" },
        { code: "candidate.same-effective-points", evidence: "比较时用相同有效点集口径，不用少帧换低残差" }
      ],
      adoptedCandidateKind: "rigid-excluded",
      rejectedCandidateKinds: ["rigid"]
    })
  ];
}

function localOverfit(mat: SeriesMaterial): VariantPack[] {
  const minimal = baseSidecarSubset(
    mat,
    "local-overfit",
    new Set(["f04", "f05", "f06", "f07", "f08"])
  );
  // 直接来源改动：单条轨迹在一帧上有一个尖刺观测（局部局部形变会去“解释”它）
  minimal.observations.push({
    segmentId: "seg-1",
    frameId: "f06",
    x: 40.5,
    y: 91.5,
    uncertaintyPx: 1.4,
    rawText: "(40.5, 91.5) px @basis-96x96 [outlier]"
  });
  minimal.interpretations[0].note = "最小：5 帧 + 一个尖刺观测，专门诱发局部形变过拟合";

  const combined = fullAs(mat, "local-overfit");
  combined.interpretations.push({
    interpretationId: "interp-warp-heavy",
    label: "高自由度局部形变解释（对照）",
    axisId: "axis-1",
    axisVersion: 1,
    linkSetId: "ls-naive",
    excludedFrameIds: ["f09"],
    overrides: [
      { segmentId: "seg-1", frameId: "f06", x: 40.5, y: 91.5, rawText: "(40.5, 91.5) px @basis-96x96 [outlier]" }
    ],
    note: "唯一直接来源改动：增加一条尖刺观测解释版本；原始字节不变"
  });

  return [
    pack("local-overfit", "局部形变过拟合", "minimal", "增加一条尖刺观测（同片段同帧的第二观测）", minimal, [
      { id: "lo-m-import", kind: "import-variant", variant: "minimal", summary: "导入 5 帧与尖刺观测" },
      { id: "lo-m-compute", kind: "compute-candidates", variant: "minimal", interpretationId: "interp-local-overfit-minimal", summary: "局部候选训练残差骤降、留出不改善，local.overfit 阻断" }
    ], {
      must: [{ code: "local.overfit", evidence: "训练增益 >20% 而留出增益 <=2%" }],
      rejectedCandidateKinds: ["local-deformation"]
    }),
    pack("local-overfit", "局部形变过拟合", "combined", "新增 interp-warp-heavy 解释（含尖刺观测）；只改一条观测来源", combined, [
      { id: "lo-c-import", kind: "import-variant", variant: "combined", summary: "导入组合输入" },
      { id: "lo-c-compute-rigid", kind: "compute-candidates", variant: "combined", interpretationId: "interp-baseline", summary: "刚体候选：尖刺留在残差里，整体稳健" },
      { id: "lo-c-compute-warp", kind: "compute-candidates", variant: "combined", interpretationId: "interp-warp-heavy", summary: "局部形变候选：训练 RMS 低但过拟合阻断" },
      { id: "lo-c-reject-warp", kind: "adjudicate", variant: "combined", interpretationId: "interp-warp-heavy", candidateKind: "local-deformation", candidateId: CID("interp-warp-heavy", "local-deformation"), verdict: "rejected", reason: "留出集不支持局部形变，自由度被尖刺利用", summary: "拒绝局部形变候选" },
      { id: "lo-c-accept-rigid", kind: "adjudicate", variant: "combined", interpretationId: "interp-baseline", candidateKind: "rigid-excluded", candidateId: CID("interp-baseline", "rigid-excluded"), verdict: "accepted", reason: "刚体方案残差可解释、自由度克制", summary: "接受刚体候选" }
    ], {
      must: [{ code: "local.overfit", evidence: "局部候选 holdoutRms 不改善；采纳与未采纳候选都保留" }],
      adoptedCandidateKind: "rigid-excluded",
      rejectedCandidateKinds: ["local-deformation"]
    })
  ];
}

function multiSolution(mat: SeriesMaterial): VariantPack[] {
  // 几何退化：只用 ±12° 与 0° 三个低倾角帧，z 方向无约束 → 多个轴解等价
  const minimal = baseSidecarSubset(mat, "multi-solution", new Set(["f05", "f06", "f07"]));
  minimal.interpretations[0].note = "最小：仅 -12/0/+12° 三帧，几何退化导致多解";

  const combined = fullAs(mat, "multi-solution");
  combined.interpretations.push({
    interpretationId: "interp-low-tilt-only",
    label: "低倾角退化解释（对照）",
    axisId: "axis-1",
    axisVersion: 1,
    linkSetId: "ls-naive",
    excludedFrameIds: ["f00", "f01", "f11", "f12"],
    note: "排除四个高/中倾角帧后几何退化；候选保留全部合法解"
  });

  return [
    pack("multi-solution", "多解与并发冻结", "minimal", "（无）最小输入只有三个低倾角帧，几何退化", minimal, [
      { id: "ms-m-import", kind: "import-variant", variant: "minimal", summary: "导入退化 3 帧" },
      { id: "ms-m-compute", kind: "compute-candidates", variant: "minimal", interpretationId: "interp-multi-solution-minimal", summary: "solution.non-unique：保留全部近优解" }
    ], {
      must: [{ code: "solution.non-unique", evidence: "存在多个分离的近优轴解" }],
      rejectedCandidateKinds: []
    }),
    pack("multi-solution", "多解与并发冻结", "combined", "新增退化解释；随后安排两个窗口并发接受不同解，触发版本冲突与冻结", combined, [
      { id: "ms-c-import", kind: "import-variant", variant: "combined", summary: "导入组合输入" },
      { id: "ms-c-compute", kind: "compute-candidates", variant: "combined", interpretationId: "interp-low-tilt-only", summary: "退化解释下保留全部合法候选" },
      { id: "ms-c-lock-a", kind: "concurrent-conflict", variant: "combined", clientId: "window-A", interpretationId: "interp-low-tilt-only", candidateKind: "rigid", candidateId: CID("interp-low-tilt-only", "rigid"), reason: "窗口 A 接受解 #1 并锁定", summary: "窗口 A 先提交（解 #1）" },
      { id: "ms-c-lock-b", kind: "concurrent-conflict", variant: "combined", clientId: "window-B", parentActionId: "ms-c-lock-a", interpretationId: "interp-low-tilt-only", candidateKind: "local-deformation", candidateId: CID("interp-low-tilt-only", "local-deformation"), reason: "窗口 B 基于同一父版本接受解 #2 并锁定", summary: "窗口 B 后提交：收到 409 冲突与双方差异，分支冻结" },
      { id: "ms-c-resolve", kind: "resolve-freeze", variant: "combined", reason: "审阅者保留窗口 A 解，分支解冻并记冲突裁定", summary: "解决冻结：接受解 #1，冲突双方差异与决定都留档" }
    ], {
      must: [
        { code: "solution.non-unique", evidence: "合法候选全部保留，不静默择优" },
        { code: "branch.conflict-detected", evidence: "后提交者看到版本冲突、双方差异，分支进入冻结" }
      ],
      adoptedCandidateKind: "rigid",
      rejectedCandidateKinds: ["local-deformation"],
      frozenAtEnd: false
    })
  ];
}

export function allVariants(mat: SeriesMaterial): VariantPack[] {
  return [
    ...axisOffset(mat),
    ...identitySwap(mat),
    ...missingHighTilt(mat),
    ...badFrame(mat),
    ...localOverfit(mat),
    ...multiSolution(mat)
  ];
}

export { baselineSidecar };
