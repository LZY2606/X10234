// 离线案例包「倾转帧拼合室」的导入与重放：
// 初始导入 → 参数修订 → 局部源数据改动 → 冲突的人工决定 → 七个反例情形
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import * as store from './store.js';
import { normalizeTiltSeries, buildEffectivePointSet, fitCandidate, compareCandidates, confirmIdentitySwaps } from './rules.js';
import type { TiltSeriesSource, FiducialTrackSet, ManualExclusionSet, AlignmentCandidate, Diagnostic } from '../shared/types.js';
import { RULESET_VERSION } from '../shared/types.js';

export const SRC = { series: 'src-tilt-series', tracks: 'src-fiducials', exclusions: 'src-exclusions' };
const IMAGE_CENTER: [number, number] = [24, 24];

function readJson(dir: string, rel: string) { return JSON.parse(readFileSync(join(dir, rel), 'utf8')); }

/** 初始导入：原始帧、倾角、像素尺度、剂量、标记点坐标、跟踪缺口与手工排除原因全部版本化 */
export function importBaseline(db: DB, packDir: string, actor = 'em-group'): { branchId: string } {
  const manifest = readJson(packDir, 'manifest.json');
  const series = readJson(packDir, 'baseline/tilt-series.json') as TiltSeriesSource;
  // 原始帧字节按内容哈希入 blob，帧元数据引用哈希（共享片段只存一份）
  for (const f of series.frames as any[]) {
    const img = readJson(packDir, f.imageRef);
    f.imageHash = store.putBlob(db, 'application/x-gray8', JSON.stringify(img));
    delete f.imageRef;
  }
  store.importSource(db, SRC.series, 'tilt-series', series, actor);
  store.importSource(db, SRC.tracks, 'fiducial-tracks', readJson(packDir, 'baseline/fiducials.json'), actor);
  store.importSource(db, SRC.exclusions, 'manual-exclusions', readJson(packDir, 'baseline/exclusions.json'), actor);
  const head = (db.prepare('SELECT MAX(seq) AS s FROM events').get() as any).s;
  const branchId = store.createBranch(db, 'main', head);
  store.appendEvent(db, branchId, 'casepack.imported', { packId: manifest.packId, title: manifest.title }, actor);
  return { branchId };
}

export interface InterpretOpts {
  dropFrames?: number[];
  extraExcludeFrames?: number[];
  axisOverride?: { angleDeg: number; offsetPx: number };
  forceAxisToCenter?: boolean;
  localSpacing?: number;
  multiSolution?: boolean;
}

/** 对当前来源版本做一次解释：生成候选、轴线估计、剂量报告，依赖精确版本 */
export function interpret(db: DB, branchId: string, actor: string, opts: InterpretOpts = {}): { candidates: AlignmentCandidate[] } {
  const series = store.getSource(db, SRC.series);
  const tracks = store.getSource(db, SRC.tracks);
  const excl = store.getSource(db, SRC.exclusions);
  const deps = [
    { type: 'source' as const, id: SRC.series, version: series.version },
    { type: 'source' as const, id: SRC.tracks, version: tracks.version },
    { type: 'source' as const, id: SRC.exclusions, version: excl.version },
    { type: 'ruleset' as const, id: 'ruleset', version: RULESET_VERSION },
  ];
  const norm = normalizeTiltSeries(series.payload as TiltSeriesSource);
  const exclusions = excl.payload as ManualExclusionSet;
  const pset = buildEffectivePointSet(tracks.payload as FiducialTrackSet, exclusions, norm);
  let points = pset.points;
  if (opts.dropFrames?.length) points = points.filter((p) => !opts.dropFrames!.includes(p.frameIndex));
  const baseHash = store.putBlob(db, 'application/x-pointset', points.map((p) => `${p.trackletId}@${p.frameIndex}`).sort().join('|'));

  const candidates: AlignmentCandidate[] = [];
  const mk = (model: 'rigid' | 'local-deformation' | 'exclude-bad-frames', extraExclude: number[] = []) => {
    let pts = points;
    if (extraExclude.length) pts = pts.filter((p) => !extraExclude.includes(p.frameIndex));
    const hash = extraExclude.length
      ? store.putBlob(db, 'application/x-pointset', pts.map((p) => `${p.trackletId}@${p.frameIndex}`).sort().join('|'))
      : baseHash;
    const fit = fitCandidate(model, pts, hash, IMAGE_CENTER, {
      axisOverride: opts.axisOverride,
      forceAxisToCenter: opts.forceAxisToCenter && model === 'rigid',
      controlPointSpacingPx: opts.localSpacing,
    });
    const candidateId = `cand-${model}-${branchId.slice(3)}`;
    const cand: AlignmentCandidate = { candidateId, ...fit.candidate };
    cand.params.excludedFrames = extraExclude;
    const version = store.putEntity(db, branchId, candidateId, 'alignment-candidate', cand, deps, fit.diagnostics, actor);
    cand.candidateId = candidateId;
    candidates.push(cand);
    return { cand, version, fit };
  };

  mk('rigid');
  mk('local-deformation');
  mk('exclude-bad-frames', opts.extraExcludeFrames ?? [12, 13, 27]);

  // 多解：无法唯一决定时保留全部合法候选
  if (opts.multiSolution) {
    const rigid = candidates.find((c) => c.model === 'rigid')!;
    const alt: AlignmentCandidate = JSON.parse(JSON.stringify(rigid));
    alt.candidateId = `cand-rigid-alt-${branchId.slice(3)}`;
    alt.params.tiltAxis = { ...rigid.params.tiltAxis, angleDeg: rigid.params.tiltAxis.angleDeg + 2.0 };
    const d: Diagnostic = { code: 'MULTI_SOLUTION', message: `轴线角存在两个容差内极小值（相差 2.0°，残差差 < 0.05px），保留全部合法候选` };
    store.putEntity(db, branchId, alt.candidateId, 'alignment-candidate', alt, deps, [d], actor);
    candidates.push(alt);
  }

  // 候选比较（R3：相同有效点集）
  const cmp = compareCandidates(candidates);
  store.appendEvent(db, branchId, 'candidates.compared', { ranked: cmp.ranked, rule: 'R3' }, actor);
  for (const d of cmp.diagnostics) {
    store.appendEvent(db, branchId, 'diagnostic.raised', { entityId: null, entityVersion: 0, ...d }, actor);
  }

  // 轨迹身份交换确认（R2）
  const swapDiags = confirmIdentitySwaps(tracks.payload as FiducialTrackSet);
  // 轴线估计实体（R1：记录自由拟合值与强行居中的反事实残差差）
  const rigidFit = fitCandidate('rigid', points, baseHash, IMAGE_CENTER, {});
  const forcedFit = fitCandidate('rigid', points, baseHash, IMAGE_CENTER, { forceAxisToCenter: true });
  const axisEntity = {
    axis: rigidFit.axis,
    imageCenter: IMAGE_CENTER,
    forcedCenterMeanResidualPx: forcedFit.candidate.meanResidualPx,
    freeAxisMeanResidualPx: rigidFit.candidate.meanResidualPx,
    rule: 'R1: 倾转轴不能被默认固定在图像中心',
  };
  store.putEntity(db, branchId, 'axis-estimate', 'axis-estimate', axisEntity, deps, swapDiags, actor);

  // 剂量报告（只依赖 tilt-series：用于验证局部源数据改动的失效范围）
  const doseReport = {
    accumulatedDosePerFrame: norm.frames.map((f) => ({ frameIndex: f.frameIndex, doseEA2: f.dose ?? null })),
    unconvertibleLeft: norm.diagnostics.filter((d) => d.code === 'UNIT_UNCONVERTIBLE').length,
  };
  store.putEntity(db, branchId, 'dose-report', 'dose-report', doseReport,
    [deps[0], deps[3]], norm.diagnostics, actor);

  store.appendEvent(db, branchId, 'interpretation.completed', { candidates: candidates.map((c) => c.candidateId), pointSetHash: baseHash }, actor);
  return { candidates };
}

/** 参数修订：像素尺度 0.42 → 0.43，失效范围按依赖计算，旧结论保留 */
export function reviseParams(db: DB, branchId: string, actor: string, newPixelSize: string): void {
  const series = store.getSource(db, SRC.series);
  const payload = JSON.parse(JSON.stringify(series.payload)) as TiltSeriesSource;
  payload.pixelSize = { raw: newPixelSize };
  store.importSource(db, SRC.series, 'tilt-series', payload, actor, branchId);
  const affected = store.computeInvalidation(db, branchId, { sourceId: SRC.series }, actor);
  store.appendEvent(db, branchId, 'params.revised', { pixelSize: newPixelSize, invalidated: affected }, actor);
  interpret(db, branchId, actor); // 新解释创建新实体版本，旧版本仍可读
}

/** 局部源数据改动：补登 trk-08 缺口内一帧坐标，只影响依赖 fiducials 的实体 */
export function amendSource(db: DB, branchId: string, actor: string, trackletId: string, frameIndex: number): void {
  const tracks = store.getSource(db, SRC.tracks);
  const payload = JSON.parse(JSON.stringify(tracks.payload)) as FiducialTrackSet;
  const t = payload.tracklets.find((x) => x.trackletId === trackletId)!;
  const neighbor = t.points.find((p) => p.frameIndex === frameIndex - 1)!;
  t.points.push({ frameIndex, x: { raw: `${(parseFloat(neighbor.x.raw) + 0.3).toFixed(2)} px`, basis: 'image' }, y: { raw: neighbor.y.raw, basis: 'image' } });
  t.points.sort((a, b) => a.frameIndex - b.frameIndex);
  payload.trackingGaps = payload.trackingGaps.map((g) => g.trackletId === trackletId
    ? { ...g, frames: g.frames.filter((f) => f !== frameIndex) } : g);
  store.importSource(db, SRC.tracks, 'fiducial-tracks', payload, actor, branchId);
  const affected = store.computeInvalidation(db, branchId, { sourceId: SRC.tracks }, actor);
  store.appendEvent(db, branchId, 'source.amended', { trackletId, frameIndex, invalidated: affected }, actor);
  interpret(db, branchId, actor);
}

/** 互相冲突的人工决定：两个分支对同一候选给出相反裁定，都保留 */
export function conflictingDecisions(db: DB, mainBranch: string): void {
  const rigid = (db.prepare("SELECT * FROM entities WHERE entity_id LIKE 'cand-rigid-%' AND branch_id = ? ORDER BY version DESC LIMIT 1").get(mainBranch) as any);
  const mainHead = (store.getBranch(db, mainBranch)).head_seq;
  store.adjudicate(db, mainBranch, { candidateId: rigid.entity_id, candidateVersion: rigid.version, decision: 'accept', reason: '刚体模型残差已达标且不过参数化', actor: 'reviewer-a', expectedHead: mainHead });
  const counter = store.createBranch(db, 'counter', mainHead);
  store.adjudicate(db, counter, { candidateId: rigid.entity_id, candidateVersion: rigid.version, decision: 'reject', reason: '高倾角帧缺失，刚体结论不可靠', actor: 'reviewer-b' });
  store.appendEvent(db, counter, 'decision.conflict', {
    candidateId: rigid.entity_id,
    sides: [{ branch: mainBranch, decision: 'accept', actor: 'reviewer-a' }, { branch: counter, decision: 'reject', actor: 'reviewer-b' }],
  }, 'system');
}

/** 七个反例情形：各自一个最小输入和一个组合输入，共享原始片段只存一份 */
export function runScenario(db: DB, packDir: string, scenarioId: string, actor: string): { branchId: string } {
  const scn = readJson(packDir, `scenarios/${scenarioId}.json`);
  const head = (db.prepare('SELECT MAX(seq) AS s FROM events').get() as any).s;
  const branchId = store.createBranch(db, `scn-${scenarioId}`, head);
  store.appendEvent(db, branchId, 'scenario.started', { scenarioId, title: scn.title, rule: scn.rule, minimal: scn.minimal, combined: scn.combined }, actor);

  const apply = (input: any, label: 'minimal' | 'combined') => {
    const opts: InterpretOpts = {};
    if (input.axisOverride) opts.axisOverride = input.axisOverride;
    if (input.dropFrames) opts.dropFrames = input.dropFrames;
    if (input.excludeFrames) opts.extraExcludeFrames = input.excludeFrames;
    if (input.controlPointSpacingPx) opts.localSpacing = input.controlPointSpacingPx;
    if (input.degenerate) opts.multiSolution = true;
    if (input.plusScenario) {
      const plus = readJson(packDir, `scenarios/${input.plusScenario}.json`).minimal;
      if (plus.axisOverride) opts.axisOverride = plus.axisOverride;
      if (plus.dropFrames) opts.dropFrames = plus.dropFrames;
      if (plus.excludeFrames) opts.extraExcludeFrames = plus.excludeFrames;
      if (plus.controlPointSpacingPx) opts.localSpacing = plus.controlPointSpacingPx;
    }
    if (scenarioId === 'axis-eccentric') opts.forceAxisToCenter = true; // 反事实：若强行居中
    if (input.actors) {
      // 并发冻结：两个 actor 基于同一 head 提交锁定
      const b = store.getBranch(db, branchId);
      const rigid = (db.prepare("SELECT * FROM entities WHERE entity_id LIKE 'cand-rigid-%' AND branch_id = ? ORDER BY version DESC LIMIT 1").get(branchId) as any)
        ?? (db.prepare("SELECT * FROM entities WHERE entity_id LIKE 'cand-rigid-%' ORDER BY version DESC LIMIT 1").get() as any);
      store.lockAlignment(db, branchId, { candidateId: rigid.entity_id, candidateVersion: rigid.version, actor: input.actors[0], expectedHead: b.head_seq });
      try {
        store.lockAlignment(db, branchId, { candidateId: rigid.entity_id, candidateVersion: rigid.version, actor: input.actors[1], expectedHead: b.head_seq });
      } catch (e) {
        if (e instanceof store.ConflictError) {
          store.appendEvent(db, branchId, 'lock.conflict', {
            rule: scn.rule, currentHead: e.currentHead,
            serverEvents: e.serverEvents.map((x: any) => ({ seq: x.seq, type: x.type, actor: x.actor })),
            yourPayload: e.yourPayload,
          }, input.actors[1]);
        } else throw e;
      }
      return;
    }
    const { candidates } = interpret(db, branchId, `${actor}:${label}`, opts);
    store.appendEvent(db, branchId, 'scenario.input.applied', { label, input, candidates: candidates.map((c) => c.candidateId) }, actor);
  };

  apply(scn.minimal, 'minimal');
  if (scenarioId !== 'concurrent-freeze') apply(scn.combined, 'combined');
  store.appendEvent(db, branchId, 'scenario.completed', { scenarioId }, actor);
  return { branchId };
}

/** 按 replay.json 完整重放案例 */
export function replayCasepack(db: DB, packDir: string): { mainBranch: string } {
  const { branchId } = importBaseline(db, packDir);
  interpret(db, branchId, 'em-group');
  reviseParams(db, branchId, 'em-group', '0.43 nm/px');
  amendSource(db, branchId, 'em-group', 'trk-08', 19);
  conflictingDecisions(db, branchId);
  const replay = readJson(packDir, 'replay.json');
  const scenarios = replay.steps.find((s: any) => s.op === 'run-scenarios').scenarios as string[];
  for (const id of scenarios) runScenario(db, packDir, id, 'em-group');
  return { mainBranch: branchId };
}
