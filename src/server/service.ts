import type { DatabaseSync } from 'node:sqlite';
import { Store, VersionConflictError } from './store.js';
import { digestOf } from '../domain/ids.js';
import { decodePGM } from '../domain/frames.js';
import { requireValue } from '../domain/units.js';
import { DOMAIN_RULES, type EntityVersionRef, type EventRecord } from '../domain/types.js';
import type { CaseBundle } from '../case/generate.js';
import { CASE_BRANCH_MAIN, CASE_BRANCH_AXIS, generateCaseBundle } from '../case/generate.js';
import {
  buildEffectiveSet,
  runRegistration,
  type EngineInput,
  type NormFrame,
  type NormPoint,
} from '../reg/engine.js';
import { estimateTiltAxis } from '../reg/axis.js';

export { VersionConflictError };

export class ReviewService {
  store: Store;
  constructor(public db: DatabaseSync) {
    this.store = new Store(db);
  }

  /** 原子导入案例包：任一步失败整体回滚，不留半份记录。 */
  importCase(bundle: CaseBundle = generateCaseBundle(), opts: { axisBranch?: boolean } = {}): {
    seriesId: string;
    branches: string[];
    imported: number;
  } {
    const imp = this.store.beginImport();
    try {
      const sid = bundle.manifest.seriesId;
      for (const b of bundle.manifest.branches) {
        if (!this.store.getBranch(b.branchId)) {
          this.store.createBranch(b.branchId, sid, b.name, b.parent);
        }
      }

      // 内容寻址字节：共享片段只存一份（putBlob 幂等）
      for (const b of bundle.blobs) {
        const bytes = new Uint8Array(Buffer.from(b.bytesBase64, 'base64'));
        this.store.putBlob(bytes, b.mediaType);
      }

      const branch = CASE_BRANCH_MAIN;
      let count = 0;
      this.store.appendEvent({
        seriesId: sid,
        branchId: branch,
        type: 'series.imported',
        payload: {
          seriesId: sid,
          title: bundle.manifest.title,
          rules: DOMAIN_RULES,
          schemaVersion: bundle.manifest.schemaVersion,
        },
        rationale: { rule: 'NO_IRREVERSIBLE_CLEANING', retained: true },
      });
      count++;

      for (const f of bundle.frames) {
        this.appendSource(branch, 'source.frame.recorded', f as unknown as Record<string, unknown>, f.blobRef ? [{ entityId: f.blobRef, version: 1, digest: f.blobRef }] : []);
        count++;
      }
      for (const t of bundle.tilts) this.appendSource(branch, 'source.tilt.recorded', t as unknown as Record<string, unknown>, [{ entityId: t.frameId, version: 1, digest: '' }]), count++;
      for (const s of bundle.scales) this.appendSource(branch, 'source.pixelscale.recorded', s as unknown as Record<string, unknown>, []), count++;
      for (const d of bundle.doses) this.appendSource(branch, 'source.dose.recorded', d as unknown as Record<string, unknown>, [{ entityId: d.frameId, version: 1, digest: '' }]), count++;
      for (const p of bundle.points) this.appendSource(branch, 'source.point.recorded', p as unknown as Record<string, unknown>, [{ entityId: p.frameId, version: 1, digest: '' }]), count++;
      for (const g of bundle.gaps) this.appendSource(branch, 'source.gap.recorded', g as unknown as Record<string, unknown>, []), count++;
      for (const x of bundle.exclusions) this.appendSource(branch, 'source.exclusion.recorded', x as unknown as Record<string, unknown>, []), count++;

      // 轨迹解释（可断裂+身份交换）与初始候选
      const eng = this.buildEngineInput(branch, bundle);
      const out = runRegistration(eng);
      this.store.appendEvent({
        seriesId: sid,
        branchId: branch,
        type: 'interpretation.tracks.committed',
        payload: { tracks: out.tracks, version: 1 },
        rationale: { rules: ['TRACKS_MAY_BREAK', 'IDENTITY_MAY_SWAP'], swaps: out.tracks.swaps.length, segments: out.tracks.segments.length },
      });
      count++;
      const axis = estimateTiltAxis(eng.frames, eng.points, eng.width, eng.height, eng.frames[0].frameId);
      this.store.appendEvent({
        seriesId: sid,
        branchId: branch,
        type: 'param.revised',
        payload: {
          entityType: 'axis',
          version: 1,
          axis: {
            originX: axis.identifiable ? axis.originX : null,
            originY: axis.identifiable ? axis.originY : null,
            angleDeg: axis.angleDeg,
            source: axis.identifiable ? 'estimated' : 'manual',
            eccentricityPx: axis.identifiable ? axis.eccentricityPx : null,
            referenceFrameId: axis.referenceFrameId,
            identifiable: axis.identifiable,
            reason: axis.reason ?? null,
          },
        },
        rationale: { rule: 'AXIS_NOT_CENTER', defaultCenterAllowed: false },
      });
      count++;
      for (const c of out.candidates) {
        this.store.appendEvent({
          seriesId: sid,
          branchId: branch,
          type: 'candidate.committed',
          payload: { candidate: c },
          rationale: {
            rules: ['SAME_EFFECTIVE_SET', 'NO_DROPPING_FRAMES_FOR_LOWER_RESIDUAL', 'KEEP_ALL_LEGAL_SOLUTIONS'],
            effectiveFingerprint: c.effectiveSet.fingerprint,
          },
        });
        count++;
      }

      // 记录固定情形（输入片段/判定状态/受影响对象）
      for (const sc of bundle.manifest.scenarios) {
        const detail = bundle.scenarios[sc.code];
        this.store.appendEvent({
          seriesId: sid,
          branchId: sc.branch,
          type: 'scenario.replayed',
          payload: {
            code: sc.code,
            title: sc.title,
            minimal: detail.minimal,
            combined: detail.combined,
            sharedBlobs: sc.sharedBlobs,
          },
        });
        count++;
      }

      // 轴线偏心分叉：先记录血缘，再在分叉上提交偏心参数修订（第二分支叙事）。
      this.fork(CASE_BRANCH_AXIS, sid, 'axis-offcenter-review', CASE_BRANCH_MAIN);
      const axisStep = bundle.playbook.find((p) => p.op === 'param-revise');
      if (axisStep && axisStep.op === 'param-revise') {
        this.reviseAxis(CASE_BRANCH_AXIS, axisStep.axisOrigin[0], axisStep.axisOrigin[1], axisStep.axisAngleDeg);
      }
      this.store.commitImport(imp, count);
      return { seriesId: sid, branches: bundle.manifest.branches.map((b) => b.branchId), imported: count };
    } catch (err) {
      this.store.rollbackImport(imp);
      throw err;
    }
  }

  private appendSource(branch: string, type: any, entity: Record<string, unknown>, refs: EntityVersionRef[]): EventRecord {
    return this.store.appendEvent({
      seriesId: entity.seriesId as string,
      branchId: branch,
      type,
      payload: { entity, references: refs, digest: digestOf(entity) },
    });
  }

  /** 从某分支事件状态构造规范化引擎输入；不可转换值在此被拦下并附诊断（来源层保留原值）。 */
  buildEngineInput(branchId: string, bundle?: CaseBundle): EngineInput {
    const state = this.store.replayBranch(branchId);
    const s = state.source;
    const frames: NormFrame[] = [];
    for (const f of Object.values(s.frames)) {
      if (!f.acquisitionRecorded) continue;
      const tilt = Object.values(s.tilts).find((t2) => t2.frameId === f.id) as any;
      const dose = Object.values(s.doses).find((d2) => d2.frameId === f.id) as any;
      frames.push({
        frameId: f.id as string,
        frameIndex: f.index as number,
        angleDeg: requireValue(tilt.angle, `tilt ${f.id}`),
        dose: dose ? requireValue(dose.cumulative, `dose ${f.id}`) : 0,
        width: f.width as number,
        height: f.height as number,
      });
    }
    frames.sort((a, b) => a.frameIndex - b.frameIndex);

    const points: NormPoint[] = Object.values(s.points).map((p: any) => ({
      pointId: p.id,
      markerId: p.markerId,
      frameId: p.frameId,
      frameIndex: frames.find((ff) => ff.frameId === p.frameId)?.frameIndex ?? -1,
      x: p.x,
      y: p.y,
      sigmaPx: p.sigmaPx ?? 1,
    }));

    const gaps = Object.values(s.gaps).map((g: any) => ({
      markerId: g.markerId,
      fromFrameIndex: g.fromFrameIndex,
      toFrameIndex: g.toFrameIndex,
      reason: g.reason,
    }));

    const excludedFrameIds = Object.values(s.exclusions)
      .filter((x: any) => x.active && x.scope === 'frame')
      .map((x: any) => ({ frameId: x.frameId, reasonId: x.id, rationale: x.rationale }));

    const swaps = state.tracks?.swaps ?? [];

    return {
      seriesId: state.seriesId!,
      branchId,
      frames,
      points,
      gaps,
      excludedFrameIds,
      width: bundle?.manifest ? 120 : frames[0]?.width ?? 120,
      height: bundle?.manifest ? 96 : frames[0]?.height ?? 96,
      knownSwaps: swaps,
    };
  }

  /** 参数/源变化后按依赖闭包计算失效范围，而非全局替换。 */
  invalidationScope(branchId: string, changed: { frameIds?: string[]; axis?: boolean }): {
    affectedCandidates: string[];
    affectedFrames: string[];
    reason: string;
  } {
    const state = this.store.replayBranch(branchId);
    const affectedFrames = new Set(changed.frameIds ?? []);
    const affectedCandidates: string[] = [];
    for (const c of Object.values(state.candidates)) {
      const touchesFrame = c.perFrame.some((pf) => affectedFrames.has(pf.frameId));
      const dependsOnAxis = changed.axis && (c.kind === 'rigid' || c.kind === 'bad-frame-excluded' || c.kind === 'local-deformation');
      if (touchesFrame || dependsOnAxis) affectedCandidates.push(c.id);
    }
    return {
      affectedCandidates,
      affectedFrames: [...affectedFrames],
      reason: changed.axis
        ? 'axis-revision-invalidates-registration-closure'
        : 'source-change-invalidates-frame-local-dependents',
    };
  }

  /** 修订参数：在指定分支追加 param.revised，并返回受影响（失效）范围。不删除旧候选。 */
  reviseAxis(branchId: string, originX: number, originY: number, angleDeg: number, expectedHead?: string) {
    const state = this.store.replayBranch(branchId);
    const sid = state.seriesId!;
    const version = state.axisVersion + 1;
    const width = 120,
      height = 96;
    const evt = this.store.appendEvent({
      seriesId: sid,
      branchId,
      type: 'param.revised',
      expectedHead: expectedHead ?? null,
      payload: {
        entityType: 'axis',
        version,
        axis: {
          originX,
          originY,
          angleDeg,
          source: 'manual',
          eccentricityPx: Math.hypot(originX - width / 2, originY - height / 2),
          referenceFrameId: Object.values(state.source.frames).sort((a: any, b: any) => a.index - b.index)[0]?.id,
          identifiable: true,
        },
      },
      rationale: { rule: 'AXIS_NOT_CENTER' },
    });
    const scope = this.invalidationScope(branchId, { axis: true });
    return { event: evt, scope };
  }

  /** 只影响局部依赖的源数据改动：记录 source.reinterpreted + 新版本实体，旧版本保留。 */
  reviseSourceValue(branchId: string, entityType: 'dose', entityId: string, newValueRaw: string, expectedHead?: string) {
    const state = this.store.replayBranch(branchId);
    const current = Object.values(state.source.doses).find((d: any) => d.id === entityId) as any;
    if (!current) throw new Error(`unknown-entity: ${entityId}`);
    const next = {
      ...current,
      cumulative: { ...current.cumulative, raw: newValueRaw, value: Number.parseFloat(newValueRaw) },
    };
    const evt = this.store.appendEvent({
      seriesId: state.seriesId!,
      branchId,
      type: 'source.reinterpreted',
      expectedHead: expectedHead ?? null,
      payload: { entityType, entity: next, digest: digestOf(next) },
      rationale: { rule: 'DEPENDENCY_INVALIDATION', oldVersion: state.versions[entityId] ?? 1 },
    });
    // 新版本实体仍落到来源桶，保证时间旅行可见
    this.store.appendEvent({
      seriesId: state.seriesId!,
      branchId,
      type: 'source.dose.recorded',
      payload: { entity: next, references: [], digest: digestOf(next) },
    });
    const scope = this.invalidationScope(branchId, { frameIds: [next.frameId] });
    return { event: evt, scope };
  }

  private decisionSeq: Record<string, number> = {};

  /** 接受/否定候选：乐观并发 expectedHead；冲突抛 VersionConflictError 附双方差异。 */
  adjudicate(
    branchId: string,
    decision: 'accept' | 'reject' | 'parameter-revise',
    candidateId: string | undefined,
    comment: string,
    decidedBy: string,
    expectedHead: string,
  ): { event: EventRecord; conflict?: never } {
    const state = this.store.replayBranch(branchId);
    const seq = (this.decisionSeq[branchId] ??= 0) + 1;
    this.decisionSeq[branchId] = seq;
    const id = `${branchId}/dec-${String(seq).padStart(3, '0')}`;
    const evt = this.store.appendEvent({
      seriesId: state.seriesId!,
      branchId,
      type: 'adjudication.made',
      expectedHead,
      payload: {
        adjudication: {
          id,
          seriesId: state.seriesId,
          branchId,
          candidateId,
          decision,
          comment,
          decidedBy,
          basedOnHead: expectedHead,
          undone: false,
        },
      },
      rationale: candidateId
        ? { rule: 'SAME_EFFECTIVE_SET', candidateId, effectiveFingerprint: state.candidates[candidateId]?.effectiveSet.fingerprint }
        : undefined,
    });
    return { event: evt };
  }

  /** 撤销裁定：追加 decision.undone，恢复前一分支，不删除历史。 */
  undoDecision(branchId: string, adjudicationId: string, expectedHead?: string): EventRecord {
    return this.store.appendEvent({
      seriesId: this.store.replayBranch(branchId).seriesId!,
      branchId,
      type: 'decision.undone',
      expectedHead: expectedHead ?? null,
      payload: { adjudicationId },
    });
  }

  /** 锁定一版配准供重建引用；重建 ref 携带实体版本+摘要。 */
  lockForReconstruction(branchId: string, candidateId: string, lockedBy: string, expectedHead: string) {
    const state = this.store.replayBranch(branchId);
    const cand = state.candidates[candidateId];
    if (!cand) throw new Error(`unknown-candidate: ${candidateId}`);
    const references: EntityVersionRef[] = [];
    for (const fid of cand.effectiveSet.frameIds) {
      const v = state.versions[fid];
      if (v) references.push({ entityId: fid, version: v, digest: state.digests[`${fid}@${v}`] ?? '' });
    }
    references.push({ entityId: cand.id, version: 1, digest: digestOf(cand) });
    const lock = {
      branchId,
      seriesId: state.seriesId!,
      candidateId,
      reconstructionRef: `recon:${state.seriesId}:${candidateId}@head:${expectedHead}`,
      lockedBy,
      references,
    };
    this.store.appendEvent({
      seriesId: state.seriesId!,
      branchId,
      type: 'registration.locked',
      expectedHead,
      payload: { lock },
      rationale: { stableReferences: references.length },
    });
    this.store.setLock(lock);
    return lock;
  }

  fork(newBranchId: string, seriesId: string, name: string, parentBranchId: string): void {
    this.store.forkBranch(newBranchId, seriesId, name, parentBranchId);
    const state = this.store.replayBranch(parentBranchId);
    // 分叉锚点事件记录血缘；之后解释独立
    this.store.appendEvent({
      seriesId,
      branchId: newBranchId,
      type: 'branch.forked',
      payload: { parentBranch: parentBranchId, parentHead: this.store.getBranch(parentBranchId)?.head_event_id },
    });
    void state;
  }

  /** 案例剧本：把参数修订落到独立的轴线偏心分叉，并给出失效范围。 */
  applyCasePlaybook(): void {
    const bundle = generateCaseBundle();
    for (const step of bundle.playbook) {
      if (step.op === 'param-revise') {
        this.reviseAxis(step.branch, step.axisOrigin[0], step.axisOrigin[1], step.axisAngleDeg);
      } else if (step.op === 'source-fix') {
        this.reviseSourceValue(
          step.branch,
          'dose',
          `${step.frameId}/dose`,
          step.after.replace(' e-/Å^2', ''),
        );
      }
    }
  }

  /** 查询实体：返回引用版本号与内容摘要；缺少引用报损坏，不退回最新版。 */
  lookup(branchId: string, entityId: string, atOrdinal?: number) {
    const state = this.store.replayBranch(branchId, atOrdinal);
    const version = state.versions[entityId];
    if (!version) return { entityId, entityType: 'unknown', version: 0, digest: '', data: {}, references: [], missingReferences: [{ entityId, reason: 'no-such-version' }], corrupted: true };
    const refs = this.store.assertReferencesExist(state, entityId, version);
    const data = state.history[entityId][version];
    return {
      entityId,
      entityType: (data as any).entityType ?? 'entity',
      version,
      digest: state.digests[`${entityId}@${version}`] ?? digestOf(data),
      data,
      references: refs,
      missingReferences: [],
      corrupted: false,
    };
  }

  /** 时间旅行：重放到某事件，恢复当时依赖版本与可见结论。 */
  atEvent(branchId: string, ordinal: number) {
    const state = this.store.replayBranch(branchId, ordinal);
    return this.summarizeState(branchId, state);
  }

  snapshot(branchId: string) {
    return this.summarizeState(branchId, this.store.replayBranch(branchId));
  }

  private summarizeState(branchId: string, state: ReturnType<Store['replayBranch']>) {
    const branch = this.store.getBranch(branchId)!;
    return {
      seriesId: state.seriesId,
      branchId,
      headEventId: branch.head_event_id,
      headVersion: branch.head_version,
      rules: state.rules,
      frameCount: Object.keys(state.source.frames).length,
      recordedFrames: Object.values(state.source.frames).filter((f: any) => f.acquisitionRecorded).length,
      tiltCount: Object.keys(state.source.tilts).length,
      scales: Object.values(state.source.scales),
      doseCount: Object.keys(state.source.doses).length,
      pointCount: Object.keys(state.source.points).length,
      gapCount: Object.keys(state.source.gaps).length,
      exclusions: Object.values(state.source.exclusions),
      tracks: state.tracks,
      axis: state.axis,
      axisVersion: state.axisVersion,
      candidates: Object.values(state.candidates),
      adjudications: state.adjudicationOrder.map((id) => state.adjudications[id]),
      lock: state.lock ?? this.store.getLock(branchId) ?? null,
      diagnostics: state.diagnostics,
      scenarios: state.scenarios,
    };
  }

  events(branchId: string) {
    return this.store.listEvents(branchId);
  }

  getEvent(eventId: string) {
    return this.store.getEvent(eventId);
  }

  blob(contentId: string) {
    const row = this.store.getBlob(contentId);
    if (!row) return undefined;
    return { ...row, bytes: new Uint8Array(row.bytes) };
  }

  resetDatabase(): void {
    this.db.exec(`
      DELETE FROM locks; DELETE FROM entity_refs; DELETE FROM entity_versions;
      DELETE FROM events; DELETE FROM branches; DELETE FROM blobs; DELETE FROM imports;
    `);
  }
}
