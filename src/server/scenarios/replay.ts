import { ArchiveStore, StoreError } from "../db/store";
import {
  buildCandidatesFor,
  makeRule,
  rigidParams,
  seedInitialSeries,
  CASE_CODES,
  writeCasePack,
  type BuildResult,
} from "./case-pack";
import { buildCandidate, compareCandidates, estimateTiltAxis, resolveTrackIdentities } from "../../shared/registration";
import { contentId } from "../../shared/ids";
import type { DossierEntry, IdentitySwap, ManualFrameExclusion, RegistrationParameters } from "../../shared/types";
import { qty } from "../../shared/units";

/**
 * 固定案例重放。每个情形有：
 *  - minimal: 只触发该情形的最小输入（自己的 commit + branch + 事件链）
 *  - combined: 在主叙事（main 分支）上作为组合输入的一部分
 * 两者共享的原始帧字节通过内容寻址只存一份不可变内容；
 * 解释版本、失败诊断和人工决定各自独立。
 */
export function buildFixedCasePack(store: ArchiveStore, caseDir: string): BuildResult {
  const generatedAt = "2026-09-23T00:00:00.000Z";
  const summary: Record<string, unknown> = { generatedAt, cases: {} };

  // ===== 主叙事：初始导入 =====
  const main = seedInitialSeries(store, {
    importedAt: generatedAt,
    materialVersion: "material/2026-09-23-v1",
    rationale: "初始导入：25 帧倾转序列（-60°..+60°）、cosine 剂量与 5 条 fiducial 轨迹",
    seqHint: 1,
    idHint: "commit_initial_v1",
    labelPrefix: "main",
  });

  const initialCandidates = buildCandidatesFor(store, main, generatedAt, ["rigid", "local-deform", "rigid-drop-frames"]);
  const fair = compareCandidates(initialCandidates);
  if (fair.violations.length) throw new Error(`FIXED_CASE_INVALID: 初始公平比较就违例: ${fair.violations.join(";")}`);

  // 初始事件链：计算候选（机器可读判断依据）
  let head = append(store, {
    branchId: main.branch.id,
    kind: "parameter-revised",
    actor: "em-team",
    at: generatedAt,
    summary: "在同一有效点集上生成刚体/局部形变/排除坏帧三个候选",
    refs: {
      ruleVersionId: [main.rule.id, ...initialCandidates.map((c) => c.ruleVersionId)],
      candidateIds: initialCandidates.map((c) => c.id),
      commitId: main.commitId,
    },
    payload: {
      comparisonTable: fair.table,
      ruleStatement:
        "不同候选用相同有效点集比较，不用少帧换低残差；倾转轴由轨迹估计，不默认固定在图像中心",
    },
    dependencies: [
      { dependsOn: main.commitId, scope: "global" },
      { dependsOn: main.rule.id, scope: "global" },
    ],
  });

  // ===== 1. 轴线偏心：组合输入（主分支修订参数）+ 最小输入（独立分支）=====
  const axisFrames = objectsFor(store, main);
  const badCenterRule = makeRule(
    store,
    "rules/rigid-center-assumed",
    { ...rigidParams(true, []), tiltAxis: { ...rigidParams(true, []).tiltAxis, directionDeg: 88 } },
    generatedAt,
    "反例规则：把倾转轴默认钉在图像中心",
  );
  const centerCandidate = buildCandidate({
    frames: axisFrames.frames,
    angles: axisFrames.angles,
    observations: axisFrames.observations,
    params: badCenterRule.parameters,
    identityMap: resolveTrackIdentities({
      frames: axisFrames.frames,
      angles: axisFrames.angles,
      observations: axisFrames.observations,
      knownSwaps: [],
    }),
    branchId: main.branch.id,
    ruleVersionId: badCenterRule.id,
    label: "candidate-rigid-center-assumed",
    comparisonGroup: "fair-table",
  });
  store.putCandidate(centerCandidate, head.event.id);
  head = append(store, {
    branchId: main.branch.id,
    kind: "candidate-rejected",
    actor: "reviewer-a",
    at: iso(2),
    summary: "否定图像中心轴候选：轴线实际偏心于 (40,30)，中心假设导致残差升高",
    refs: { candidateId: centerCandidate.id, ruleVersionId: badCenterRule.id },
    payload: {
      rejectedDiagnostics: centerCandidate.diagnostics,
      rmsPx: centerCandidate.rmsPx,
      ruleStatement: "倾转轴不能被默认固定在图像中心",
    },
    dependencies: [
      { dependsOn: badCenterRule.id, scope: "global" },
      { dependsOn: centerCandidate.id, scope: "local", localityKey: "tilt-axis" },
    ],
    expectedHeadEventId: head.event.id,
  });

  const axisEstimate = estimateTiltAxis({
    frames: axisFrames.frames,
    angles: axisFrames.angles,
    observations: axisFrames.observations,
    identityMap: resolveTrackIdentities({
      frames: axisFrames.frames,
      angles: axisFrames.angles,
      observations: axisFrames.observations,
      knownSwaps: [],
    }),
    imageCenterAssumption: false,
  });
  const eccentricRule = makeRule(
    store,
    "rules/rigid-axis-estimated",
    { ...rigidParams(false, []), tiltAxis: axisEstimate.axis },
    iso(2),
    "轴线由轨迹 PCA + 法向搜索估计，锚点约 (40,30)",
  );
  const eccentricCandidate = buildCandidate({
    frames: axisFrames.frames,
    angles: axisFrames.angles,
    observations: axisFrames.observations,
    params: eccentricRule.parameters,
    identityMap: resolveTrackIdentities({
      frames: axisFrames.frames,
      angles: axisFrames.angles,
      observations: axisFrames.observations,
      knownSwaps: [],
    }),
    branchId: main.branch.id,
    ruleVersionId: eccentricRule.id,
    label: "candidate-rigid-axis-estimated",
    comparisonGroup: "fair-table",
  });
  store.putCandidate(eccentricCandidate, head.event.id);
  head = append(store, {
    branchId: main.branch.id,
    kind: "candidate-accepted",
    actor: "reviewer-a",
    at: iso(3),
    summary: "采纳偏心轴刚体候选，残差低于中心假设候选",
    refs: { candidateId: eccentricCandidate.id, ruleVersionId: eccentricRule.id },
    payload: {
      acceptedRmsPx: eccentricCandidate.rmsPx,
      rejectedRmsPx: centerCandidate.rmsPx,
      anchor: { x: axisEstimate.axis.anchorX, y: axisEstimate.axis.anchorY },
    },
    dependencies: [{ dependsOn: eccentricRule.id, scope: "local", localityKey: "tilt-axis" }],
    expectedHeadEventId: head.event.id,
  });

  // 最小输入分支：只包含轴线相关的片段
  const axisMinimal = seedInitialSeries(store, {
    importedAt: iso(1),
    materialVersion: "material/2026-09-23-v1",
    rationale: "最小输入：仅用于检验轴线偏心的短倾转序列（共享同一批原始帧字节）",
    parentCommitId: main.commitId,
    seqHint: 2,
    idHint: "commit_axis_eccentric_minimal",
    labelPrefix: "axis-minimal",
  });
  const axisMinBranch = store.createBranch({
    name: "axis-eccentric-minimal",
    commitId: axisMinimal.commitId,
    ruleVersionId: badCenterRule.id,
    createdAt: iso(1),
  });
  const axisMinEvent = append(store, {
    branchId: axisMinBranch.id,
    kind: "candidate-rejected",
    actor: "reviewer-a",
    at: iso(2),
    summary: "最小输入即复现：中心轴假设产生 AXIS_CENTER_ASSUMED 诊断",
    refs: { ruleVersionId: badCenterRule.id, commitId: axisMinimal.commitId },
    payload: { diagnostics: ["AXIS_CENTER_ASSUMED"] },
    dependencies: [{ dependsOn: badCenterRule.id, scope: "local", localityKey: "tilt-axis" }],
  });

  // ===== 2. 轨迹身份交换 =====
  const swap: IdentitySwap = {
    trackLabelA: "A",
    trackLabelB: "C",
    frameIds: [main.frameIds[20]],
    confidence: 0.96,
  };
  head = append(store, {
    branchId: main.branch.id,
    kind: "parameter-revised",
    actor: "tracker",
    at: iso(4),
    summary: "检测到第 20 帧 fiducial 标签 A↔C 交换，生成带身份纠正的候选",
    refs: { frameId: main.frameIds[20] },
    payload: { swap, ruleStatement: "fiducial 轨迹可断裂且可能身份交换" },
    dependencies: [{ dependsOn: main.frameIds[20], scope: "local", localityKey: "frame:20" }],
    expectedHeadEventId: head.event.id,
  });
  const swappedIdentity = resolveTrackIdentities({
    frames: axisFrames.frames,
    angles: axisFrames.angles,
    observations: axisFrames.observations,
    knownSwaps: [swap],
  });
  const swappedRule = makeRule(
    store,
    "rules/rigid-identity-fixed",
    { ...rigidParams(false, []), tiltAxis: axisEstimate.axis },
    iso(4),
    "刚体 + 身份交换纠正",
  );
  const swappedCandidate = buildCandidate({
    frames: axisFrames.frames,
    angles: axisFrames.angles,
    observations: axisFrames.observations,
    params: swappedRule.parameters,
    identityMap: swappedIdentity,
    branchId: main.branch.id,
    ruleVersionId: swappedRule.id,
    label: "candidate-rigid-identity-fixed",
    comparisonGroup: "identity-fair",
  });
  store.putCandidate(swappedCandidate, head.event.id);
  head = append(store, {
    branchId: main.branch.id,
    kind: "candidate-accepted",
    actor: "reviewer-b",
    at: iso(5),
    summary: "采纳身份纠正候选：交换纠正后轨迹断点处残差下降",
    refs: { candidateId: swappedCandidate.id, ruleVersionId: swappedRule.id },
    payload: { rmsPx: swappedCandidate.rmsPx, swaps: [swap] },
    dependencies: [{ dependsOn: swappedRule.id, scope: "local", localityKey: "frame:20" }],
    expectedHeadEventId: head.event.id,
  });

  const swapMinimal = seedInitialSeries(store, {
    importedAt: iso(4),
    rationale: "最小输入：只含交换帧两侧的片段（原始字节仍与主序列共享）",
    parentCommitId: main.commitId,
    seqHint: 3,
    idHint: "commit_identity_swap_minimal",
    labelPrefix: "swap-minimal",
  });
  const swapMinBranch = store.createBranch({
    name: "identity-swap-minimal",
    commitId: swapMinimal.commitId,
    ruleVersionId: swappedRule.id,
    createdAt: iso(4),
  });
  append(store, {
    branchId: swapMinBranch.id,
    kind: "ambiguity-resolved",
    actor: "reviewer-b",
    at: iso(5),
    summary: "最小输入确认 A↔C 交换可纠正，轨迹身份不连续不允许被静默清洗",
    refs: { ruleVersionId: swappedRule.id, commitId: swapMinimal.commitId },
    payload: { swap },
    dependencies: [{ dependsOn: swapMinimal.commitId, scope: "local", localityKey: "frame:20" }],
  });

  // ===== 3. 缺失高倾角帧：只影响局部依赖的源数据改动 =====
  const missingCommit = seedInitialSeries(store, {
    importedAt: iso(6),
    rationale: "局部源数据改动：±60° 两帧缺失（其余原始字节与 v1 逐字节相同，只存一份）",
    materialVersion: "material/2026-09-23-v2-missing-high-tilt",
    parentCommitId: main.commitId,
    seqHint: 4,
    idHint: "commit_missing_high_tilt",
    config: { missingHighTilt: true },
    labelPrefix: "missing-high",
  });
  const missingBranch = store.createBranch({
    name: "missing-high-tilt-combined",
    commitId: missingCommit.commitId,
    ruleVersionId: main.rule.id,
    createdAt: iso(6),
  });
  const missFrames = objectsFor(store, missingCommit);
  const missAxis = estimateTiltAxis({
    frames: missFrames.frames,
    angles: missFrames.angles,
    observations: missFrames.observations,
    identityMap: resolveTrackIdentities({
      frames: missFrames.frames,
      angles: missFrames.angles,
      observations: missFrames.observations,
      knownSwaps: [],
    }),
    imageCenterAssumption: false,
  });
  append(store, {
    branchId: missingBranch.id,
    kind: "source-revised-local",
    actor: "em-team",
    at: iso(7),
    summary: "缺失 ±60° 帧：失效范围限于轴线估计与高倾角帧残差，低倾角结论不全局替换",
    refs: { commitId: missingCommit.commitId, parentCommitId: main.commitId },
    payload: {
      axisDiagnostics: missAxis.diagnostics,
      invalidationScope: { scope: "local", localityKey: "high-tilt>=55", frameIds: [] },
    },
    dependencies: [
      { dependsOn: missingCommit.commitId, scope: "local", localityKey: "high-tilt>=55" },
    ],
  });

  const missingMinimal = seedInitialSeries(store, {
    importedAt: iso(6),
    rationale: "最小输入：仅含高倾角末端三帧中的缺口描述",
    parentCommitId: main.commitId,
    seqHint: 5,
    idHint: "commit_missing_high_tilt_minimal",
    config: { missingHighTilt: true },
    labelPrefix: "missing-min",
    gaps: [{ track: "D", missingAngle: 55, reason: "out-of-field" }],
  });
  const missingMinBranch = store.createBranch({
    name: "missing-high-tilt-minimal",
    commitId: missingMinimal.commitId,
    ruleVersionId: main.rule.id,
    createdAt: iso(6),
  });
  append(store, {
    branchId: missingMinBranch.id,
    kind: "source-revised-local",
    actor: "em-team",
    at: iso(7),
    summary: "最小输入即诊断 AXIS_UNCERTAIN_HIGH_TILT_MISSING",
    refs: { commitId: missingMinimal.commitId },
    payload: { diagnostics: missAxis.diagnostics },
    dependencies: [{ dependsOn: missingMinimal.commitId, scope: "local", localityKey: "high-tilt>=55" }],
  });

  // ===== 4. 坏帧排除 =====
  const blurFrameId = main.frameIds[21];
  const exclusionId = store.putObject("ManualFrameExclusion", {
    frameId: blurFrameId,
    reasonCode: "motion-blur",
    reason: "+50° 帧水平方向运动模糊，fiducial 拖影",
    decidedBy: "em-team",
  });
  head = append(store, {
    branchId: main.branch.id,
    kind: "bad-frames-excluded",
    actor: "reviewer-a",
    at: iso(8),
    summary: "手工排除 +50° 坏帧：排除必须可撤销，且不允许只报更少帧的低残差",
    refs: { frameId: blurFrameId, exclusionId },
    payload: { ruleStatement: "不同候选用相同有效点集比较，不用少帧换低残差" },
    dependencies: [{ dependsOn: blurFrameId, scope: "local", localityKey: "frame:21" }],
    expectedHeadEventId: head.event.id,
  });
  const dropParams: RegistrationParameters = {
    ...rigidParams(false, [blurFrameId]),
    model: "rigid-drop-frames",
    tiltAxis: axisEstimate.axis,
  };
  const dropRule = makeRule(store, "rules/rigid-drop-blur", dropParams, iso(8), "刚体 + 排除模糊帧");
  const dropCandidate = buildCandidate({
    frames: axisFrames.frames,
    angles: axisFrames.angles,
    observations: axisFrames.observations,
    params: dropParams,
    identityMap: swappedIdentity,
    branchId: main.branch.id,
    ruleVersionId: dropRule.id,
    label: "candidate-rigid-drop-blur",
    comparisonGroup: "identity-fair",
  });
  store.putCandidate(dropCandidate, head.event.id);
  const identityFair = compareCandidates([swappedCandidate, dropCandidate]);
  head = append(store, {
    branchId: main.branch.id,
    kind: "candidate-rejected",
    actor: "reviewer-b",
    at: iso(9),
    summary: "排除候选不自动获胜：分数包含少帧惩罚，且对比在相同有效点集约束下进行",
    refs: { candidateIds: [swappedCandidate.id, dropCandidate.id], ruleVersionId: dropRule.id },
    payload: {
      violations: identityFair.violations,
      table: identityFair.table,
      dropDiagnostics: dropCandidate.diagnostics,
    },
    dependencies: [{ dependsOn: dropRule.id, scope: "local", localityKey: "frame:21" }],
    expectedHeadEventId: head.event.id,
  });
  // 撤销排除 -> 恢复前一分支视图
  head = append(store, {
    branchId: main.branch.id,
    kind: "bad-frames-restored",
    actor: "reviewer-a",
    at: iso(10),
    summary: "撤销坏帧排除：恢复包含 +50° 帧的前一分支，原数据从未被改写",
    refs: { frameId: blurFrameId, restoredFromEventId: head.event.id },
    payload: {},
    dependencies: [{ dependsOn: blurFrameId, scope: "local", localityKey: "frame:21" }],
    expectedHeadEventId: head.event.id,
  });

  const badMinimal = seedInitialSeries(store, {
    importedAt: iso(8),
    rationale: "最小输入：仅含坏帧及其手工排除原因",
    parentCommitId: main.commitId,
    seqHint: 6,
    idHint: "commit_bad_frame_minimal",
    labelPrefix: "bad-min",
    excludeFrameReasons: [{ angle: 50, reasonCode: "motion-blur", reason: "+50° 水平运动模糊" }],
  });
  const badMinBranch = store.createBranch({
    name: "bad-frame-minimal",
    commitId: badMinimal.commitId,
    ruleVersionId: dropRule.id,
    createdAt: iso(8),
  });
  append(store, {
    branchId: badMinBranch.id,
    kind: "bad-frames-excluded",
    actor: "em-team",
    at: iso(8),
    summary: "最小输入：坏帧与手工排除原因独立版本化",
    refs: { commitId: badMinimal.commitId, frameId: blurFrameId },
    payload: { reason: "motion-blur" },
    dependencies: [{ dependsOn: badMinimal.commitId, scope: "local", localityKey: "frame:21" }],
  });

  // ===== 5. 局部形变过拟合 =====
  const warpParams: RegistrationParameters = {
    model: "local-deform",
    tiltAxis: axisEstimate.axis,
    maxShiftPx: 14,
    // 刻意过密的网格 + 很高自由度，触发交叉验证过拟合诊断
    warpGridSpacingPx: 8,
    warpDegreesOfFreedom: 40,
    droppedFrameIds: [],
  };
  const warpRule = makeRule(store, "rules/local-deform-overfit", warpParams, iso(11), "局部形变（过密网格，预期过拟合）");
  const warpCandidate = buildCandidate({
    frames: axisFrames.frames,
    angles: axisFrames.angles,
    observations: axisFrames.observations,
    params: warpParams,
    identityMap: swappedIdentity,
    branchId: main.branch.id,
    ruleVersionId: warpRule.id,
    label: "candidate-local-deform-overfit",
    comparisonGroup: "identity-fair",
  });
  store.putCandidate(warpCandidate, head.event.id);
  head = append(store, {
    branchId: main.branch.id,
    kind: "candidate-rejected",
    actor: "reviewer-a",
    at: iso(11),
    summary: "否定局部形变候选：交叉验证残差远高于训练残差，判定过拟合",
    refs: { candidateId: warpCandidate.id, ruleVersionId: warpRule.id },
    payload: {
      diagnostics: warpCandidate.diagnostics,
      trainRmsPx: warpCandidate.rmsPx,
      cvRmsPx: warpCandidate.cvRmsPx,
      complexityPenalty: warpCandidate.complexityPenalty,
    },
    dependencies: [{ dependsOn: warpRule.id, scope: "global" }],
    expectedHeadEventId: head.event.id,
  });

  const warpMinimal = seedInitialSeries(store, {
    importedAt: iso(11),
    rationale: "最小输入：少数几帧即可暴露过拟合的局部形变片段",
    parentCommitId: main.commitId,
    seqHint: 7,
    idHint: "commit_warp_overfit_minimal",
    labelPrefix: "warp-min",
  });
  const warpMinBranch = store.createBranch({
    name: "warp-overfit-minimal",
    commitId: warpMinimal.commitId,
    ruleVersionId: warpRule.id,
    createdAt: iso(11),
  });
  append(store, {
    branchId: warpMinBranch.id,
    kind: "candidate-rejected",
    actor: "reviewer-a",
    at: iso(11),
    summary: "最小输入：过拟合诊断在短片段上同样成立",
    refs: { ruleVersionId: warpRule.id, commitId: warpMinimal.commitId },
    payload: { cvRmsPx: warpCandidate.cvRmsPx },
    dependencies: [{ dependsOn: warpRule.id, scope: "global" }],
  });

  // ===== 6. 多解：保留全部合法候选，不擅自唯一化 =====
  // 对称珠子配置：两组分配等价
  const symmetricConfig = {
    beads: [
      { label: "A", x0: 64 - 22, y0: 48, z0: 0 },
      { label: "B", x0: 64 + 22, y0: 48, z0: 0 },
      { label: "C", x0: 64, y0: 48 - 22, z0: 0 },
      { label: "D", x0: 64, y0: 48 + 22, z0: 0 },
      { label: "E", x0: 40, y0: 30, z0: 0 },
    ],
    blurFrames: [] as number[],
  };
  const multiCommit = seedInitialSeries(store, {
    importedAt: iso(12),
    rationale: "组合输入：对称 fiducial 布局，轨迹身份无法唯一决定",
    materialVersion: "material/2026-09-23-v3-symmetric",
    parentCommitId: main.commitId,
    seqHint: 8,
    idHint: "commit_multi_solution",
    config: symmetricConfig,
    labelPrefix: "multi",
  });
  const multiFrames = objectsFor(store, multiCommit);
  const multiIdentity = resolveTrackIdentities({
    frames: multiFrames.frames,
    angles: multiFrames.angles,
    observations: multiFrames.observations,
    knownSwaps: [],
  });
  const multiBranch = store.createBranch({
    name: "multi-solution-combined",
    commitId: multiCommit.commitId,
    ruleVersionId: main.rule.id,
    createdAt: iso(12),
  });
  append(store, {
    branchId: multiBranch.id,
    kind: "ambiguity-reopened",
    actor: "tracker",
    at: iso(12),
    summary: "保留全部合法身份分配，禁止在导入时不可逆清洗为单解",
    refs: { commitId: multiCommit.commitId },
    payload: {
      ambiguity: multiIdentity.ambiguity,
      alternatives: multiIdentity.ambiguousAlternatives ?? [],
      ruleStatement: "无法唯一决定时保留全部合法候选",
    },
    dependencies: [{ dependsOn: multiCommit.commitId, scope: "global" }],
  });
  const multiMinimal = seedInitialSeries(store, {
    importedAt: iso(12),
    rationale: "最小输入：四标记点对称构型即产生多解",
    parentCommitId: main.commitId,
    seqHint: 9,
    idHint: "commit_multi_solution_minimal",
    config: symmetricConfig,
    labelPrefix: "multi-min",
  });
  const multiMinBranch = store.createBranch({
    name: "multi-solution-minimal",
    commitId: multiMinimal.commitId,
    ruleVersionId: main.rule.id,
    createdAt: iso(12),
  });
  append(store, {
    branchId: multiMinBranch.id,
    kind: "ambiguity-reopened",
    actor: "tracker",
    at: iso(12),
    summary: "最小输入：对称构型下至少两组身份分配等价",
    refs: { commitId: multiMinimal.commitId },
    payload: { ambiguity: true },
    dependencies: [{ dependsOn: multiMinimal.commitId, scope: "global" }],
  });

  // ===== 7. 多解与并发冻结：两个窗口同时保存，后提交者看到冲突及双方差异 =====
  const frozenRule = makeRule(
    store,
    "rules/rigid-for-freeze",
    { ...rigidParams(false, []), tiltAxis: axisEstimate.axis },
    iso(13),
    "并发冻结检验规则",
  );
  const freezeCandidate = buildCandidate({
    frames: axisFrames.frames,
    angles: axisFrames.angles,
    observations: axisFrames.observations,
    params: frozenRule.parameters,
    identityMap: swappedIdentity,
    branchId: main.branch.id,
    ruleVersionId: frozenRule.id,
    label: "candidate-for-lock",
    comparisonGroup: "identity-fair",
  });
  store.putCandidate(freezeCandidate, head.event.id);

  // 两个窗口都基于同一个 head 打开
  const baseHead = head.event.id;
  const aResult = append(store, {
    branchId: main.branch.id,
    kind: "parameter-revised",
    actor: "reviewer-a",
    at: iso(14),
    summary: "窗口 A：修订轴线搜索步长为 0.25px",
    refs: { ruleVersionId: frozenRule.id, candidateId: freezeCandidate.id },
    payload: { axisSearchStepPx: 0.25 },
    dependencies: [{ dependsOn: frozenRule.id, scope: "local", localityKey: "tilt-axis" }],
    expectedHeadEventId: baseHead,
  });
  if (aResult.status !== "appended") throw new Error("FIXED_CASE_INVALID: 窗口 A 本应成功");
  const bResult = append(store, {
    branchId: main.branch.id,
    kind: "parameter-revised",
    actor: "reviewer-b",
    at: iso(14),
    summary: "窗口 B：修订轴线搜索步长为 0.75px（基于旧 head）",
    refs: { ruleVersionId: frozenRule.id },
    payload: { axisSearchStepPx: 0.75 },
    dependencies: [{ dependsOn: frozenRule.id, scope: "local", localityKey: "tilt-axis" }],
    expectedHeadEventId: baseHead,
  });
  if (bResult.status !== "conflict") throw new Error("FIXED_CASE_INVALID: 窗口 B 必须被并发冻结");

  // 互相冲突的人工决定：A 接受刚体，B 想锁定局部形变；B 被冻结后在新 head 上重做
  head = append(store, {
    branchId: main.branch.id,
    kind: "conflict-frozen",
    actor: "system",
    at: iso(14),
    summary: `并发冻结：后提交的窗口 B 看到冲突 ${bResult.status === "conflict" ? bResult.conflictId : ""}，双方差异已保存`,
    refs: { conflictId: bResult.status === "conflict" ? bResult.conflictId : "" },
    payload: bResult.status === "conflict"
      ? { baseHead, actualHead: bResult.expectedHeadEventId, actors: ["reviewer-a", "reviewer-b"] }
      : {},
    dependencies: [{ dependsOn: frozenRule.id, scope: "local", localityKey: "tilt-axis" }],
    expectedHeadEventId: aResult.status === "appended" ? aResult.event.id : head.event.id,
  });
  // B 拉取差异后在新 head 上重新提交（仍可表达与 A 不同的意见）
  head = append(store, {
    branchId: main.branch.id,
    kind: "conflicting-decision",
    actor: "reviewer-b",
    at: iso(15),
    summary: "窗口 B 在最新 head 上重新提交：坚持 0.75px 但记录为与 A 冲突的人工决定，不覆盖 A",
    refs: { ruleVersionId: frozenRule.id, conflictId: bResult.status === "conflict" ? bResult.conflictId : "" },
    payload: { axisSearchStepPx: 0.75, resolvedAgainst: "reviewer-a" },
    dependencies: [{ dependsOn: frozenRule.id, scope: "local", localityKey: "tilt-axis" }],
    expectedHeadEventId: head.event.id,
  });
  if (bResult.status === "conflict") store.resolveConflict(bResult.conflictId, head.event.id);

  // 最小输入：直接构造两个并发提交
  const freezeMinimal = seedInitialSeries(store, {
    importedAt: iso(13),
    rationale: "最小输入：并发冻结只需要两个基于同一 head 的裁定",
    parentCommitId: main.commitId,
    seqHint: 10,
    idHint: "commit_concurrent_freeze_minimal",
    labelPrefix: "freeze-min",
  });
  const freezeMinBranch = store.createBranch({
    name: "concurrent-freeze-minimal",
    commitId: freezeMinimal.commitId,
    ruleVersionId: frozenRule.id,
    createdAt: iso(13),
  });
  const minBase = append(store, {
    branchId: freezeMinBranch.id,
    kind: "candidate-accepted",
    actor: "reviewer-a",
    at: iso(14),
    summary: "窗口 A 接受候选",
    refs: { commitId: freezeMinimal.commitId, ruleVersionId: frozenRule.id },
    payload: {},
    dependencies: [{ dependsOn: freezeMinimal.commitId, scope: "global" }],
  });
  const minB = append(store, {
    branchId: freezeMinBranch.id,
    kind: "candidate-rejected",
    actor: "reviewer-b",
    at: iso(14),
    summary: "窗口 B 同时否定候选（基于旧 head）",
    refs: { commitId: freezeMinimal.commitId, ruleVersionId: frozenRule.id },
    payload: {},
    dependencies: [{ dependsOn: freezeMinimal.commitId, scope: "global" }],
    expectedHeadEventId: null,
  });
  if (minB.status !== "conflict") throw new Error("FIXED_CASE_INVALID: 最小并发冻结必须触发冲突");

  // ===== 最终复核：锁定一版配准供重建引用 =====
  const lockedParams = frozenRule.parameters;
  head = append(store, {
    branchId: main.branch.id,
    kind: "registration-locked",
    actor: "reviewer-a",
    at: iso(16),
    summary: "从审阅页锁定偏心轴刚体配准，生成供重建引用的稳定句柄",
    refs: { candidateId: freezeCandidate.id, ruleVersionId: frozenRule.id, commitId: main.commitId },
    payload: {
      forReconstructionRef: `recon://room/main/${freezeCandidate.id}`,
      pointSetDigest: freezeCandidate.pointSetDigest,
      lockedParamsDigest: contentId("params", lockedParams),
    },
    dependencies: [
      { dependsOn: freezeCandidate.id, scope: "global" },
      { dependsOn: main.commitId, scope: "global" },
      { dependsOn: frozenRule.id, scope: "global" },
    ],
    expectedHeadEventId: head.event.id,
  });
  const lock = store.getLock(main.branch.id)!;

  // ===== 反例档案：每个情形保留采纳与未采纳结果、失效范围与判断依据（机器可读事件）=====
  const dossierDefs: Omit<DossierEntry, "id">[] = [
    {
      caseCode: "axis-eccentric",
      title: "轴线偏心",
      ruleStatement: "倾转轴不能被默认固定在图像中心",
      minimalInput: refFor(store, "commit_axis_eccentric_minimal", [axisMinEvent.event.id]),
      combinedInput: refFor(store, main.commitId, [head.event.id]),
      adopted: [{ eventId: head.event.id, summary: "锁定的配准使用轨迹估计的偏心轴" }],
      rejected: [{ eventId: eventsOf(store, main.branch.id).find((e) => e.kind === "candidate-rejected" && JSON.stringify(e.payload).includes("AXIS_CENTER"))!.id, summary: "图像中心轴候选被否定" }],
      affectedEntityIds: [main.frameIds[0]],
      invalidationScope: { scope: "local", localityKey: "tilt-axis", frameIds: main.frameIds },
    },
    {
      caseCode: "identity-swap",
      title: "轨迹身份交换",
      ruleStatement: "fiducial 轨迹可断裂且可能身份交换",
      minimalInput: refFor(store, "commit_identity_swap_minimal"),
      combinedInput: refFor(store, main.commitId),
      adopted: [{ eventId: eventsOf(store, main.branch.id).find((e) => JSON.stringify(e.payload).includes("identity-fixed"))!.id, summary: "身份纠正候选被采纳" }],
      rejected: [],
      affectedEntityIds: [main.frameIds[20]],
      invalidationScope: { scope: "local", localityKey: "frame:20", frameIds: [main.frameIds[20]] },
    },
    {
      caseCode: "missing-high-tilt",
      title: "缺失高倾角帧",
      ruleStatement: "高倾角缺失只允许局部失效，轴线不确定性必须显式诊断",
      minimalInput: refFor(store, "commit_missing_high_tilt_minimal"),
      combinedInput: refFor(store, "commit_missing_high_tilt"),
      adopted: [],
      rejected: [],
      affectedEntityIds: main.frameIds.slice(-2),
      invalidationScope: { scope: "local", localityKey: "high-tilt>=55", frameIds: main.frameIds.slice(-2) },
    },
    {
      caseCode: "bad-frame-exclusion",
      title: "坏帧排除",
      ruleStatement: "不同候选用相同有效点集比较，不用少帧换低残差；排除可撤销",
      minimalInput: refFor(store, "commit_bad_frame_minimal"),
      combinedInput: refFor(store, main.commitId),
      adopted: [],
      rejected: eventsOf(store, main.branch.id)
        .filter((e) => e.kind === "candidate-rejected" || e.kind === "bad-frames-restored")
        .map((e) => ({ eventId: e.id, summary: e.summary })),
      affectedEntityIds: [blurFrameId],
      invalidationScope: { scope: "local", localityKey: "frame:21", frameIds: [blurFrameId] },
    },
    {
      caseCode: "local-warp-overfit",
      title: "局部形变过拟合",
      ruleStatement: "局部形变必须通过交叉验证，训练低残差不代表可采纳",
      minimalInput: refFor(store, "commit_warp_overfit_minimal"),
      combinedInput: refFor(store, main.commitId),
      adopted: [],
      rejected: eventsOf(store, main.branch.id)
        .filter((e) => e.kind === "candidate-rejected" && JSON.stringify(e.payload).includes("OVERFIT"))
        .map((e) => ({ eventId: e.id, summary: e.summary })),
      affectedEntityIds: main.frameIds,
      invalidationScope: { scope: "global", localityKey: null, frameIds: main.frameIds },
    },
    {
      caseCode: "multi-solution",
      title: "多解",
      ruleStatement: "无法唯一决定时保留全部合法候选，禁止导入时不可逆清洗",
      minimalInput: refFor(store, "commit_multi_solution_minimal"),
      combinedInput: refFor(store, "commit_multi_solution"),
      adopted: [],
      rejected: [],
      affectedEntityIds: multiCommit.frameIds,
      invalidationScope: { scope: "global", localityKey: null, frameIds: multiCommit.frameIds },
    },
    {
      caseCode: "concurrent-freeze",
      title: "多解与并发冻结",
      ruleStatement: "两个窗口同时保存时后提交者看到版本冲突及双方差异，不覆盖先提交者",
      minimalInput: refFor(store, "commit_concurrent_freeze_minimal"),
      combinedInput: refFor(store, main.commitId),
      adopted: [{ eventId: lock.eventId, summary: "最终从审阅页锁定一版配准" }],
      rejected: eventsOf(store, main.branch.id)
        .filter((e) => e.kind === "conflict-frozen" || e.kind === "conflicting-decision")
        .map((e) => ({ eventId: e.id, summary: e.summary })),
      affectedEntityIds: [freezeCandidate.id],
      invalidationScope: { scope: "local", localityKey: "tilt-axis", frameIds: [] },
    },
  ];
  for (const def of dossierDefs) {
    const entry: DossierEntry = { ...def, id: contentId("dossier", { code: def.caseCode }) };
    store.putDossierEntry(entry);
    summary.cases[def.caseCode] = {
      minimal: def.minimalInput.commitId,
      combined: def.combinedInput.commitId,
      adopted: def.adopted.length,
      rejected: def.rejected.length,
      scope: def.invalidationScope,
    };
  }

  store.verifyChainIntegrity();
  const build: BuildResult = { store, caseDir, summary: { ...summary, lock } };
  writeCasePack(build);
  return build;
}
