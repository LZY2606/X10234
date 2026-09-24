import { renderFramePGM } from './generator';
import {
  fitExcludedFramesCandidate,
  fitLocalWarpCandidate,
  fitRigidCandidate,
  observationsFromCase,
  type EngineParams,
} from './engine';
import { baselineCase, compositeCase, minimalCases } from './cases';
import type { CaseSpec } from './case-types';
import type { Store } from './store';
import type { DependencyRef, DomainQuantity, RegistrationCandidate } from '../shared/model';
import { entityVersionId, pointSetFingerprint } from '../shared/identity';

export interface ImportedCaseHandle {
  branchId: string;
  spec: CaseSpec;
  frameEntityIds: string[];
  sourceCount: number;
  blobReused: number;
}

// 七类来源全部版本化导入；任一失败整体回滚。
export function importCase(store: Store, spec: CaseSpec, branchId: string): ImportedCaseHandle {
  let sourceCount = 0;
  let blobReused = 0;
  store.runImportBatch(() => {
    // 像素尺度（全局，一条来源）
    store.addSourceVersion({
      branchId,
      kind: 'pixel_scale',
      label: `${spec.caseId}/pixel-scale`,
      quantity: spec.pixelQuantity,
      createdBy: 'importer',
    });
    sourceCount++;

    for (const frame of spec.frames) {
      // 原始帧字节（缺失帧仍保存“缺失声明”，但不造图像字节）
      if (!frame.missing) {
        const bytes = renderFramePGM(spec, frame);
        const { blobId, reused } = store.putBlob(bytes, 'image/x-portable-graymap');
        if (reused) blobReused++;
        store.addSourceVersion({
          branchId,
          kind: 'raw_frame',
          label: `${spec.caseId}/raw/${frame.index}`,
          frameId: frame.frameId,
          blobId,
          quantity: {
            value: [frame.width, frame.height],
            unit: 'pixel',
            repr: `PGM ${frame.width}x${frame.height}`,
            coordBasis: 'image_origin_top_left',
          },
        });
        sourceCount++;
      }

      // 倾角（度，保留原始表示）
      store.addSourceVersion({
        branchId,
        kind: 'tilt_angle',
        label: `${spec.caseId}/tilt/${frame.index}`,
        frameId: frame.frameId,
        quantity: {
          value: frame.tiltDeg,
          unit: 'degree',
          repr: `${frame.tiltDeg}° (tilt-series stage)`,
          coordBasis: 'stage_goniometer',
        },
      });
      sourceCount++;

      // 曝光剂量（e-/A^2）；保留无法规范化的值在原处并附诊断
      const badDose = frame.excluded && /剂量/.test(frame.excludeReason ?? '');
      store.addSourceVersion({
        branchId,
        kind: 'exposure_dose',
        label: `${spec.caseId}/dose/${frame.index}`,
        frameId: frame.frameId,
        quantity: badDose
          ? {
              value: null,
              unit: 'e-/A^2',
              repr: 'N/A (dose log corrupted at acquisition)',
              unconvertible: { reason: 'dose-log 缺失，无法规范化，保留原位' },
            }
          : {
              value: Math.round(frame.dose * 1000) / 1000,
              unit: 'e-/A^2',
              repr: `${frame.dose.toFixed(2)} e-/A^2`,
              normalized: Math.round(frame.dose * 1000) / 1000,
            },
      });
      sourceCount++;
    }

    // fiducial 观测坐标（像素，保留图像坐标系）
    const obs = observationsFromCase(spec);
    for (const o of obs) {
      store.addSourceVersion({
        branchId,
        kind: 'fiducial_observation',
        label: `${o.trackId}@${o.frameId}`,
        frameId: o.frameId,
        trackId: o.trackId,
        quantity: {
          value: [Math.round(o.point.x * 1000) / 1000, Math.round(o.point.y * 1000) / 1000],
          unit: 'pixel',
          repr: `(${o.point.x.toFixed(2)}, ${o.point.y.toFixed(2)}) px`,
          coordBasis: 'image_origin_top_left',
        },
      });
      sourceCount++;
    }

    // 跟踪缺口（轨迹可断裂）
    for (const tr of spec.tracks) {
      for (const gap of tr.gaps) {
        store.addSourceVersion({
          branchId,
          kind: 'track_gap',
          label: `${tr.trackId} gap ${gap.from}..${gap.to}`,
          trackId: tr.trackId,
          frameId: gap.from,
          quantity: {
            value: [gap.from, gap.to],
            unit: 'frame_id',
            repr: `${gap.from} → ${gap.to}: ${gap.reason}`,
          },
        });
        sourceCount++;
      }
      if (tr.swapAfterFrame) {
        // 交换作为缺口的解释性来源记录（不覆盖原观测）
        store.addSourceVersion({
          branchId,
          kind: 'track_gap',
          label: `${tr.trackId} identity-swap after ${tr.swapAfterFrame}`,
          trackId: tr.trackId,
          frameId: tr.swapAfterFrame,
          quantity: {
            value: [tr.trackId, tr.swapTargetId ?? '?', tr.swapAfterFrame],
            unit: 'track_id',
            repr: `suspected swap ${tr.trackId} ↔ ${tr.swapTargetId} after ${tr.swapAfterFrame}`,
          },
        });
        sourceCount++;
      }
    }

    // 手工排除原因（版本化）
    for (const frame of spec.frames) {
      if (frame.excluded) {
        store.addSourceVersion({
          branchId,
          kind: 'manual_exclusion',
          label: `${spec.caseId}/exclude/${frame.index}`,
          frameId: frame.frameId,
          quantity: {
            value: 1,
            unit: 'flag',
            repr: frame.excludeReason ?? 'manual exclusion',
          },
        });
        sourceCount++;
      }
    }
  });

  return {
    branchId,
    spec,
    frameEntityIds: spec.frames.map((f) => f.frameId),
    sourceCount,
    blobReused,
  };
}

// 为分支构建刚体 / 局部形变 / 排除坏帧三类候选，依赖显式登记具体来源版本。
export function buildCandidates(
  store: Store,
  spec: CaseSpec,
  branchId: string,
  params: EngineParams
): { rigid: RegistrationCandidate; local: RegistrationCandidate; excluded: RegistrationCandidate } {
  const obs = observationsFromCase(spec);
  const sourceEntities = store.listSourceEntities();
  const frameVersions = spec.frames.map((f) => {
    const angleEntity = sourceEntities.find((e) => e.kind === 'tilt_angle' && e.frameId === f.frameId);
    return angleEntity ? entityVersionId(angleEntity.id, angleEntity.currentVersion) : '';
  });
  const depsBase: DependencyRef[] = frameVersions
    .filter(Boolean)
    .map((v) => ({ refKind: 'source_version', refId: v.split('#')[0], refVersion: v }));
  depsBase.push({ refKind: 'rule', refId: 'registration-rules', refVersion: params.rulesVersion });
  depsBase.push({ refKind: 'parameter', refId: 'engine-params', refVersion: params.rulesVersion });

  const pointKeys = (frameIds: string[]) => {
    const keys: string[] = [];
    for (const o of obs) {
      if (frameIds.includes(o.frameId) && !o.missing) keys.push(`${o.trackId}@${o.frameId}`);
    }
    return pointSetFingerprint(keys);
  };

  const rigidFit = fitRigidCandidate(obs, params);
  const rigid = store.saveCandidate({
    branchId,
    method: 'rigid',
    axis: rigidFit.axis,
    transforms: rigidFit.transforms,
    perFrame: rigidFit.perFrame,
    effectiveFrameIds: rigidFit.effectiveFrameIds,
    effectivePointKey: pointKeys(rigidFit.effectiveFrameIds),
    rmsePx: rigidFit.rmsePx,
    holdoutRmsePx: rigidFit.holdoutRmsePx,
    dof: rigidFit.dof,
    diagnoses: rigidFit.diagnoses,
    ambiguityGroupId: rigidFit.altAngles.length ? `amb_${branchId.slice(-8)}` : undefined,
    dependencies: depsBase,
    basisRuleVersion: params.rulesVersion,
  }).candidate;

  const localFit = fitLocalWarpCandidate(obs, params);
  const local = store.saveCandidate({
    branchId,
    method: 'local_warp',
    axis: localFit.axis,
    transforms: localFit.transforms,
    perFrame: localFit.perFrame,
    effectiveFrameIds: localFit.effectiveFrameIds,
    effectivePointKey: pointKeys(localFit.effectiveFrameIds),
    rmsePx: localFit.rmsePx,
    holdoutRmsePx: localFit.holdoutRmsePx,
    dof: localFit.dof,
    diagnoses: localFit.diagnoses,
    ambiguityGroupId: localFit.altAngles.length ? `amb_${branchId.slice(-8)}` : undefined,
    dependencies: depsBase,
    basisRuleVersion: params.rulesVersion,
  }).candidate;

  const manualExcluded = spec.frames.filter((f) => f.excluded).map((f) => f.frameId);
  const excludedFit = fitExcludedFramesCandidate(obs, params, manualExcluded);
  const excluded = store.saveCandidate({
    branchId,
    method: 'rigid_excluded_frames',
    axis: excludedFit.axis,
    transforms: excludedFit.transforms,
    perFrame: excludedFit.perFrame,
    effectiveFrameIds: excludedFit.effectiveFrameIds,
    effectivePointKey: pointKeys(excludedFit.effectiveFrameIds),
    rmsePx: excludedFit.rmsePx,
    holdoutRmsePx: excludedFit.holdoutRmsePx,
    dof: excludedFit.dof,
    diagnoses: excludedFit.diagnoses,
    dependencies: depsBase,
    basisRuleVersion: params.rulesVersion,
  }).candidate;

  return { rigid, local, excluded };
}

export function buildDemoWorld(store: Store): {
  mainBranch: string;
  minimal: { key: string; branchId: string; spec: CaseSpec }[];
  composite: { key: string; branchId: string; spec: CaseSpec };
} {
  const main = store.createBranch('基线 · 倾转帧拼合室');
  const baseSpec = baselineCase();
  importCase(store, baseSpec, main.id);
  buildCandidates(store, baseSpec, main.id, baseParams());

  const minimal = minimalCases().map(({ key, spec }) => {
    const br = store.createBranch(`反例（最小）· ${key}`);
    importCase(store, spec, br.id);
    buildCandidates(store, spec, br.id, baseParams());
    store.saveArchiveCase({
      diagKey: key as never,
      kind: 'minimal',
      title: spec.title,
      adopted: false,
      branchId: br.id,
      sharedBlobIds: [],
      summary: `最小输入，仅触发 ${key}`,
    });
    return { key, branchId: br.id, spec };
  });

  const compSpec = compositeCase();
  const compBr = store.createBranch('反例（组合）· 多边界叠加');
  importCase(store, compSpec, compBr.id);
  buildCandidates(store, compSpec, compBr.id, baseParams());

  // 关联最小 / 组合，共享帧字节通过内容寻址自动只存一份。
  for (const m of minimal) {
    const shared = sharedBlobIds(store, m.branchId, compBr.id);
    store.linkCounterexample({
      diagKey: m.key as never,
      minimalBranchId: m.branchId,
      compositeBranchId: compBr.id,
      sharedBlobIds: shared,
    });
  }

  return { mainBranch: main.id, minimal, composite: { key: 'COMPOSITE', branchId: compBr.id, spec: compSpec } };
}

function sharedBlobIds(store: Store, a: string, b: string): string[] {
  const blobsOf = (branch: string) =>
    store
      .listSourceEntities()
      .filter((e) => e.kind === 'raw_frame')
      .map((e) => store.getSourceVersion(entityVersionId(e.id, e.currentVersion)))
      .filter((v) => v?.branchId === branch)
      .map((v) => v!.blobId!)
      .filter(Boolean);
  const setB = new Set(blobsOf(b));
  return blobsOf(a).filter((id) => setB.has(id));
}

export function baseParams(): import('./engine').EngineParams {
  return {
    ...baseEngineDefaults,
  };
}

import { DEFAULT_PARAMS as baseEngineDefaults } from './engine';
