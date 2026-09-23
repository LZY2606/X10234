import type { GeneratedSeries } from './generator.ts';
import { CASE_PACK_ID, SERIES_ID, generateSeries } from './generator.ts';

export type ProbeCode =
  | 'axis_offset'
  | 'track_identity_swap'
  | 'missing_high_tilt'
  | 'bad_frame_exclusion'
  | 'local_warp_overfit'
  | 'multi_solution'
  | 'concurrent_freeze';

export interface ProbeSpec {
  probeId: string;
  code: ProbeCode;
  title: string;
  fragmentRole: 'minimal' | 'combined';
  fragmentId: string;
  expectedJudgementCodes: string[];
  expectation: string;
}

export interface CaseManifest {
  packId: string;
  title: string;
  domain: string;
  seriesId: string;
  narrative: string;
  baseline: {
    fragmentId: string;
    description: string;
  };
  timeline: Array<{
    step: string;
    kind: 'parameter_revision' | 'local_source_change' | 'conflicting_decision';
    summary: string;
  }>;
  probes: ProbeSpec[];
}

export interface CasePack {
  manifest: CaseManifest;
  fragments: Record<string, { series: GeneratedSeries; role: 'baseline' | 'minimal' | 'combined' }>;
}

export function buildCasePack(): CasePack {
  // 组合输入：完整基线序列，含偏心、交换、缺口、坏帧、不可转换剂量
  const baseline = generateSeries({
    frameCount: 19,
    tiltMaxDeg: 60,
    axisOffsetPx: 26,
    badFrameShifts: { 7: { tx: 11, ty: -7 } },
    occlusion: [{ markerId: 'fmk_c', from: 11, to: 13 }],
    swap: ['fmk_d', 'fmk_e', 14],
    badDoseAt: 12,
    seed: 20260924
  });

  // —— 各反例的最小输入：小片段、单一诱因 ——
  const minimalAxis = generateSeries({ frameCount: 7, tiltMaxDeg: 50, axisOffsetPx: 24, seed: 11 });
  const minimalSwap = generateSeries({
    frameCount: 7, tiltMaxDeg: 45, axisOffsetPx: 0, swap: ['fmk_a', 'fmk_b', 5], seed: 22
  });
  // 高倾角帧整帧缺失（仅保留 ±8° 内三帧 → cosα≈1 族）
  const minimalMissing = generateSeries({
    frameCount: 11, tiltMaxDeg: 60, axisOffsetPx: 18,
    missingFrames: [1, 2, 3, 4, 8, 9, 10, 11], seed: 33
  });
  const minimalBadFrame = generateSeries({
    frameCount: 7, tiltMaxDeg: 45, axisOffsetPx: 0,
    badFrameShifts: { 4: { tx: 14, ty: 9 } }, seed: 44
  });
  const minimalWarp = generateSeries({
    frameCount: 13, tiltMaxDeg: 55, axisOffsetPx: 0, noiseSigmaPx: 0.9, seed: 55
  });
  // 多解：所有帧倾角接近 0 → p/cx 共线
  const minimalMulti = generateSeries({ frameCount: 5, tiltMaxDeg: 3, axisOffsetPx: 15, seed: 66 });
  // 并发冻结不需要独立数据，使用基线副本片段（共享 blob 去重在装载层完成）
  const minimalConcurrent = generateSeries({ frameCount: 5, tiltMaxDeg: 40, axisOffsetPx: 10, seed: 77 });

  const fragments: CasePack['fragments'] = {
    frag_baseline: { series: baseline, role: 'baseline' },
    frag_min_axis: { series: minimalAxis, role: 'minimal' },
    frag_min_swap: { series: minimalSwap, role: 'minimal' },
    frag_min_missing: { series: minimalMissing, role: 'minimal' },
    frag_min_badframe: { series: minimalBadFrame, role: 'minimal' },
    frag_min_warp: { series: minimalWarp, role: 'minimal' },
    frag_min_multi: { series: minimalMulti, role: 'minimal' },
    frag_min_concurrent: { series: minimalConcurrent, role: 'minimal' },
    frag_combined: { series: baseline, role: 'combined' }
  };

  const manifest: CaseManifest = {
    packId: CASE_PACK_ID,
    title: '倾转帧拼合室：电镜 tilt-series 轴线、fiducial 轨迹与配准分支',
    domain: 'electron-tomography/tilt-series-registration',
    seriesId: SERIES_ID,
    narrative:
      '电镜小组导入倾转序列、曝光剂量与 fiducial 点轨迹，比较刚体、局部形变与排除坏帧的配准方案。'
      + '审阅者先核对全部版本化原始材料，再依次触发七类边界组合；第二个分支专门检验轴线偏心与轨迹断裂/交换，'
      + '并在无法唯一决定时保留全部合法候选；最终在审阅页锁定一版配准供重建引用。',
    baseline: {
      fragmentId: 'frag_baseline',
      description: '初始版本完整呈现原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口与手工排除原因（全部版本化）。'
    },
    timeline: [
      {
        step: 'revision-1-axis-free',
        kind: 'parameter_revision',
        summary: '轴线规则修订：从“默认图像中心固定”改为“允许偏心、由配准估计”。失效范围仅限依赖轴线的候选。'
      },
      {
        step: 'source-change-1-dose',
        kind: 'local_source_change',
        summary: '只修正 frm_0012 剂量计丢帧的剂量原文；仅该帧剂量与累计剂量派生结论失效，几何候选不受影响。'
      },
      {
        step: 'decision-conflict-1',
        kind: 'conflicting_decision',
        summary: '两个审阅窗口分别接受不同候选；后提交者收到版本冲突与双方差异，须显式选择分支。'
      }
    ],
    probes: [
      {
        probeId: 'probe_axis_offset', code: 'axis_offset',
        title: '轴线偏心：固定中心候选残差应劣于自由轴线候选',
        fragmentRole: 'minimal', fragmentId: 'frag_min_axis',
        expectedJudgementCodes: ['AXIS_NOT_CENTER_DEFAULT', 'COMMON_EFFECTIVE_POINT_SET'],
        expectation: 'free-axis 候选恢复 ~24px 偏心；fixed-center 候选在共同点集上残差显著偏大。'
      },
      {
        probeId: 'probe_track_swap', code: 'track_identity_swap',
        title: '轨迹身份交换：交换后旧身份映射产生大残差，需重连裁定',
        fragmentRole: 'minimal', fragmentId: 'frag_min_swap',
        expectedJudgementCodes: ['TRACK_CAN_BREAK_AND_SWAP'],
        expectation: '未处理交换时 d/e 段残差异常；显式交换段映射后残差回落，缺口不被静默插值。'
      },
      {
        probeId: 'probe_missing_high_tilt', code: 'missing_high_tilt',
        title: '缺失高倾角帧：p 与轴线偏心共线，结论变弱而非伪装精确',
        fragmentRole: 'minimal', fragmentId: 'frag_min_missing',
        expectedJudgementCodes: ['MISSING_HIGH_TILT_UNINFORMATIVE', 'KEEP_ALL_LEGAL_CANDIDATES'],
        expectation: '标记 nonUnique=true 与参数族；覆盖帧减少；不得回退为单一精确轴线。'
      },
      {
        probeId: 'probe_bad_frame', code: 'bad_frame_exclusion',
        title: '坏帧排除：去帧降低拟合 RMSE，但必须用共同有效点集公平比较',
        fragmentRole: 'minimal', fragmentId: 'frag_min_badframe',
        expectedJudgementCodes: ['BAD_FRAME_EXCLUSION', 'NO_FEWER_FRAMES_LOWER_RESIDUAL'],
        expectation: 'frm_0004 被识别为坏帧；排除候选的被排除帧预测残差高，覆盖度下降可见。'
      },
      {
        probeId: 'probe_warp_overfit', code: 'local_warp_overfit',
        title: '局部形变过拟合：训练残差改善但留出点变差',
        fragmentRole: 'minimal', fragmentId: 'frag_min_warp',
        expectedJudgementCodes: ['LOCAL_WARP_OVERFIT'],
        expectation: 'warp 训练 RMSE 更低而 held-out RMSE 不优于刚体 → overfit=true。'
      },
      {
        probeId: 'probe_multi_solution', code: 'multi_solution',
        title: '多解：近零倾角下保留全部合法候选',
        fragmentRole: 'minimal', fragmentId: 'frag_min_multi',
        expectedJudgementCodes: ['KEEP_ALL_LEGAL_CANDIDATES'],
        expectation: 'ambiguity.nonUnique=true，equivalentCandidateIds 非空，锁版要求人工选择。'
      },
      {
        probeId: 'probe_concurrent_freeze', code: 'concurrent_freeze',
        title: '并发冻结：两个窗口同时保存，后提交者看到冲突与双方差异',
        fragmentRole: 'minimal', fragmentId: 'frag_min_concurrent',
        expectedJudgementCodes: ['CONCURRENT_FREEZE'],
        expectation: '第二次提交返回 409 版本冲突，携带双方差异；先提交者保持已冻结版本。'
      },
      {
        probeId: 'probe_combined', code: 'axis_offset',
        title: '组合输入：七类边界在完整序列上的叠加复核',
        fragmentRole: 'combined', fragmentId: 'frag_combined',
        expectedJudgementCodes: [
          'AXIS_NOT_CENTER_DEFAULT', 'TRACK_CAN_BREAK_AND_SWAP', 'MISSING_HIGH_TILT_UNINFORMATIVE',
          'BAD_FRAME_EXCLUSION', 'NO_FEWER_FRAMES_LOWER_RESIDUAL', 'LOCAL_WARP_OVERFIT',
          'KEEP_ALL_LEGAL_CANDIDATES', 'CONCURRENT_FREEZE'
        ],
        expectation: '完整叙事重放：来源链、失效范围与人工决定均可从最终状态反查。'
      }
    ]
  };

  return { manifest, fragments };
}
