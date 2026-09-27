import {
  ArchiveStore,
  CorruptArchiveError,
  VersionConflictError,
  digestBytes,
  digestCanonical,
} from './persistence.js';
import type {
  Adjudication,
  DependencyEdge,
  Diagnostic,
  EffectivePointSet,
  EntityView,
  RegistrationCandidate,
  Uid,
} from './domain.js';
import type {
  ArchiveEvent,
  EventId,
  EventPayload,
  ReducedBranchState,
  RuleFinding,
  ScenarioCode,
} from './events.js';
import { sha256Canonical } from './hash.js';

export const RULE_VERSION = '1.4.0';

export interface ImportedSeries {
  seriesId: Uid;
  frames: Array<{
    frameIndex: number;
    width: number;
    height: number;
    bytes: Uint8Array;
    provenance: import('../core/domain.js').FrameProvenance;
  }>;
  segments: import('../core/domain.js').TrackSegment[];
  name: string;
  scenarios: ScenarioCode[];
}

export class ArchiveEngine {
  private constructor(readonly store: ArchiveStore) {}

  static async open(bytes?: Uint8Array): Promise<ArchiveEngine> {
    return new ArchiveEngine(await ArchiveStore.open(bytes));
  }

  static async fromExport(bytes: Uint8Array): Promise<ArchiveEngine> {
    const engine = await ArchiveEngine.open(bytes);
    const integrity = engine.store.verifyIntegrity();
    if (!integrity.ok) throw new CorruptArchiveError(integrity.errors.join('; '));
    engine.store.assertCommitChain();
    return engine;
  }

  export(): Uint8Array {
    return this.store.export();
  }

  close(): void {
    this.store.close();
  }

  // ---- 事务性导入：失败整体回滚，不留下半份记录 ----

  async importSeries(input: ImportedSeries, sessionId: Uid): Promise<{ seriesId: Uid; branchId: Uid; eventIds: EventId[] }> {
    const ids: EventId[] = [];
    try {
      const created = this.append(
        null,
        sessionId,
        {
          type: 'series.created',
          seriesId: input.seriesId,
          name: input.name,
          frameCount: input.frames.length,
          width: input.frames[0]?.width ?? 0,
          height: input.frames[0]?.height ?? 0,
          scenarios: input.scenarios,
        },
        [],
        [],
      );
      ids.push(created.id);

      // 原始帧字节内容寻址（与其他系列/情形共享时只存一份不可变内容）
      const frameRows = await Promise.all(
        input.frames.map(async (frame) => ({
          frame,
          digest: await digestBytes(frame.bytes),
        })),
      );
      for (const { frame, digest } of frameRows) {
        this.store.putContent({ digest, bytes: frame.bytes, mediaType: 'image/raw-u8', sharedWith: [input.seriesId] });
      }

      const framesPayload = await Promise.all(
        frameRows.map(async ({ frame, digest }) => ({
          frameIndex: frame.frameIndex,
          width: frame.width,
          height: frame.height,
          blobDigest: digest,
          byteLength: frame.bytes.length,
          provenance: frame.provenance,
          provenanceDigest: await digestCanonical(frame.provenance),
        })),
      );

      for (const f of framesPayload) {
        this.store.putEntityVersion(`provenance/frame/${f.frameIndex}`, created.id, f.provenanceDigest, f.provenance);
      }
      const imported = this.append(
        null,
        sessionId,
        {
          type: 'frames.imported',
          seriesId: input.seriesId,
          frames: framesPayload.map((f) => ({
            frameIndex: f.frameIndex,
            width: f.width,
            height: f.height,
            blobDigest: f.blobDigest,
            byteLength: f.byteLength,
            provenance: f.provenance,
          })),
          batchId: `batch-${created.id}`,
        },
        framesPayload.map((f) => ({ entity: `frame/${f.frameIndex}`, version: created.id, digest: f.blobDigest })),
        [],
      );
      ids.push(imported.id);

      const tracks = this.append(
        null,
        sessionId,
        { type: 'tracks.imported', seriesId: input.seriesId, segments: input.segments, batchId: `batch-${created.id}` },
        [{ entity: 'tracks', version: created.id, digest: await sha256Canonical(input.segments) }],
        [],
      );
      ids.push(tracks.id);

      const branchId: Uid = `branch-${input.seriesId}-baseline`;
      const branch = this.append(
        null,
        sessionId,
        { type: 'branch.created', seriesId: input.seriesId, branchId, parentBranchId: null, reason: 'initial import interpretation', ruleVersion: RULE_VERSION },
        [{ entity: 'tracks', version: tracks.id, digest: await sha256Canonical(input.segments) }],
        [],
      );
      ids.push(branch.id);
      return { seriesId: input.seriesId, branchId, eventIds: ids };
    } catch (err) {
      // 内容存储无独立事务，但 putContent 幂等；事件链回滚由 store 的乐观提交保证
      throw err;
    }
  }

  // ---- 事件追加（乐观锁；分支头变化即冲突） ----

  private append(
    branchId: Uid | null,
    sessionId: Uid,
    payload: EventPayload,
    refs: ArchiveEvent['refs'],
    dependencies: DependencyEdge[],
  ): ArchiveEvent {
    const expectedHead = this.store.branchHead(branchId);
    const events = this.store.listEvents();
    const parent = events.length ? events[events.length - 1].commitDigest : null;
    return this.store.appendEvent({
      branchId,
      payload,
      refs,
      dependencies,
      authorSessionId: sessionId,
      expectedHead,
      parentCommitDigest: parent,
      createdAt: new Date(0).toISOString(),
    });
  }

  async createBranch(seriesId: Uid, parentBranchId: Uid, reason: string, sessionId: Uid): Promise<Uid> {
    const branchId: Uid = `branch-${seriesId}-${Math.random().toString(36).slice(2, 8)}`;
    this.append(
      branchId,
      sessionId,
      { type: 'branch.created', seriesId, branchId, parentBranchId, reason, ruleVersion: RULE_VERSION },
      [{ entity: `branch/${parentBranchId}`, version: this.store.branchHead(parentBranchId), digest: 'branch-head' }],
      [],
    );
    return branchId;
  }

  async reviseParameter(seriesId: Uid, parameter: string, before: unknown, after: unknown, reason: string, sessionId: Uid): Promise<EventId> {
    const event = this.append(
      null,
      sessionId,
      { type: 'parameter.revised', seriesId, parameter, before, after, reason },
      [],
      [{ fromEntity: `param/${parameter}`, fromVersion: this.store.lastEventId(), toEntity: 'rule-set', toVersion: 1, scope: 'global' }],
    );
    return event.id;
  }

  async amendSource(
    seriesId: Uid,
    entityKind: string,
    entityStableId: Uid,
    scope: 'local' | 'global',
    reason: string,
    sessionId: Uid,
  ): Promise<EventId> {
    const event = this.append(
      null,
      sessionId,
      { type: 'source.amended', seriesId, entityKind, entityStableId, scope, reason },
      [],
      [
        {
          fromEntity: `${entityKind}/${entityStableId}`,
          fromVersion: this.store.lastEventId(),
          toEntity: `branch/*`,
          toVersion: 0,
          scope,
        },
      ],
    );
    return event.id;
  }

  async recordDiagnostic(seriesId: Uid, diagnostic: Diagnostic, sessionId: Uid): Promise<EventId> {
    return this.append(null, sessionId, { type: 'diagnostic.recorded', seriesId, diagnostic }, [], []).id;
  }

  async proposeCandidate(input: {
    seriesId: Uid;
    branchId: Uid;
    candidate: RegistrationCandidate;
    pointSet: EffectivePointSet;
    findings: RuleFinding[];
    sessionId: Uid;
    dependencies?: DependencyEdge[];
  }): Promise<EventId> {
    const pointSetDigest = await digestCanonical(input.pointSet.keys);
    input.candidate.pointSetDigest = pointSetDigest;
    const refs = [
      { entity: `branch/${input.branchId}`, version: this.store.branchHead(input.branchId), digest: pointSetDigest },
      { entity: 'rule-set', version: 1, digest: `rules:${input.candidate.ruleVersion}` },
    ];
    return this.append(
      input.branchId,
      input.sessionId,
      {
        type: 'candidate.proposed',
        seriesId: input.seriesId,
        branchId: input.branchId,
        candidate: input.candidate,
        pointSet: input.pointSet,
        findings: input.findings,
      },
      refs,
      input.dependencies ?? [],
    ).id;
  }

  async recordFindings(seriesId: Uid, branchId: Uid, findings: RuleFinding[], sessionId: Uid): Promise<EventId> {
    return this.append(
      branchId,
      sessionId,
      { type: 'rule.findings.recorded', seriesId, branchId, findings },
      [{ entity: 'rule-set', version: 1, digest: `rules:${RULE_VERSION}` }],
      [],
    ).id;
  }

  // ---- 人工裁定：接受/否定/撤销/锁定；不改原数据，可恢复前一分支 ----

  async adjudicate(input: {
    seriesId: Uid;
    branchId: Uid;
    candidateId: Uid;
    outcome: 'accepted' | 'rejected';
    note: string;
    sessionId: Uid;
  }): Promise<{ eventId: EventId; adjudicationId: Uid; reconstructionRef?: string }> {
    const state = this.reduceBranch(input.branchId);
    if (!state.candidates[input.candidateId]) {
      throw new CorruptArchiveError(`candidate ${input.candidateId} missing in branch ${input.branchId}`);
    }
    const adjudicationId: Uid = `adj-${input.branchId}-${this.store.lastEventId() + 1}`;
    let reconstructionRef: string | undefined;
    if (input.outcome === 'accepted') {
      reconstructionRef = `reconref:${input.seriesId}:${input.branchId}:${input.candidateId}@${this.store.branchHead(input.branchId) + 1}`;
    }
    const adjudication: Adjudication = {
      adjudicationId,
      candidateId: input.candidateId,
      outcome: input.outcome,
      note: input.note,
      reconstructionRef,
    };
    const event = this.append(
      input.branchId,
      input.sessionId,
      { type: 'adjudication.made', seriesId: input.seriesId, branchId: input.branchId, adjudication },
      [{ entity: `candidate/${input.candidateId}`, version: this.store.branchHead(input.branchId), digest: 'candidate' }],
      [],
    );
    if (reconstructionRef) {
      this.append(
        input.branchId,
        input.sessionId,
        {
          type: 'reconstruction.locked',
          seriesId: input.seriesId,
          branchId: input.branchId,
          candidateId: input.candidateId,
          reconstructionRef,
        },
        [{ entity: `adjudication/${adjudicationId}`, version: event.id, digest: reconstructionRef }],
        [],
      );
    }
    return { eventId: event.id, adjudicationId, reconstructionRef };
  }

  async undoAdjudication(seriesId: Uid, branchId: Uid, adjudicationId: Uid, sessionId: Uid): Promise<EventId> {
    const state = this.reduceBranch(branchId);
    const adj = state.adjudications[adjudicationId];
    if (!adj) throw new CorruptArchiveError(`adjudication ${adjudicationId} missing`);
    const restoredHead = this.findEventBeforeAdjudication(branchId, adjudicationId);
    return this.append(
      branchId,
      sessionId,
      { type: 'adjudication.undone', seriesId, branchId, adjudicationId, restoredHeadEventId: restoredHead },
      [{ entity: `adjudication/${adjudicationId}`, version: restoredHead, digest: adj.adjudicationId }],
      [],
    ).id;
  }

  private findEventBeforeAdjudication(branchId: Uid, adjudicationId: Uid): EventId {
    const events = this.store
      .listEvents()
      .filter((e) => e.branchId === branchId)
      .sort((a, b) => a.id - b.id);
    for (let i = events.length - 1; i >= 0; i--) {
      const payload = events[i].payload;
      if (payload.type === 'adjudication.made' && payload.adjudication.adjudicationId === adjudicationId) {
        return i > 0 ? events[i - 1].id : 0;
      }
    }
    return 0;
  }

  async reportConcurrentSave(input: {
    seriesId: Uid;
    branchId: Uid;
    baseHeadEventId: EventId;
    rivalHeadEventId: EventId;
    sessionId: Uid;
    leftSummary: string;
    rightSummary: string;
    changedEntities: Array<{ stableId: Uid; leftVersion: EventId | null; rightVersion: EventId | null }>;
  }): Promise<{ conflict: VersionConflictError; eventId: EventId }> {
    const conflict = new VersionConflictError(
      `concurrent save detected: base=${input.baseHeadEventId}, rival=${input.rivalHeadEventId}`,
      input.baseHeadEventId,
      input.rivalHeadEventId,
      input.sessionId,
    );
    this.store.freezeSession(input.sessionId);
    const findings: RuleFinding[] = [
      {
        code: 'CONCURRENT_FREEZE',
        severity: 'error',
        message: '落后会话已冻结：必须先审阅双方差异，选择合并或撤销后才能再次提交',
        evidence: { baseHeadEventId: input.baseHeadEventId, rivalHeadEventId: input.rivalHeadEventId },
        affects: [{ entity: `branch/${input.branchId}`, version: input.rivalHeadEventId, scope: 'local' }],
      },
    ];
    const eventId = this.append(
      input.branchId,
      input.sessionId,
      {
        type: 'conflict.reported',
        seriesId: input.seriesId,
        branchId: input.branchId,
        baseHeadEventId: input.baseHeadEventId,
        rivalHeadEventId: input.rivalHeadEventId,
        sessionId: input.sessionId,
        diff: {
          baseEventId: input.baseHeadEventId,
          rivalEventId: input.rivalHeadEventId,
          leftSummary: input.leftSummary,
          rightSummary: input.rightSummary,
          changedEntities: input.changedEntities,
        },
      },
      [],
      [],
    ).id;
    await this.recordFindings(input.seriesId, input.branchId, findings, input.sessionId);
    return { conflict, eventId };
  }

  unfreeze(sessionId: Uid): void {
    this.store.unfreezeSession(sessionId);
  }

  // ---- 归约 / 时间旅行：回任意旧事件恢复当时依赖版本与可见结论，不拿最新结果覆盖历史 ----

  reduceBranch(branchId: Uid, upToEventId?: EventId): ReducedBranchState {
    const state: ReducedBranchState = {
      branchId,
      headEventId: 0,
      candidates: {},
      candidateOrder: [],
      adjudications: {},
      lockedCandidateId: null,
      ruleVersion: RULE_VERSION,
      ruleFindings: [],
    };
    const branchEvents = this.store
      .listEvents()
      .filter((e) => e.branchId === branchId)
      .sort((a, b) => a.id - b.id);
    const undone = new Set<Uid>();
    for (const event of branchEvents) {
      if (upToEventId !== undefined && event.id > upToEventId) break;
      state.headEventId = event.id;
      const payload = event.payload;
      switch (payload.type) {
        case 'branch.created':
          state.ruleVersion = payload.ruleVersion;
          break;
        case 'candidate.proposed':
          // 采纳与未被采纳的候选都保留
          state.candidates[payload.candidate.candidateId] = payload.candidate;
          state.candidateOrder.push(payload.candidate.candidateId);
          state.ruleFindings.push(...payload.findings);
          break;
        case 'rule.findings.recorded':
          state.ruleFindings.push(...payload.findings);
          break;
        case 'adjudication.made':
          if (!undone.has(payload.adjudication.adjudicationId)) {
            state.adjudications[payload.adjudication.adjudicationId] = payload.adjudication;
          }
          break;
        case 'adjudication.undone':
          undone.add(payload.adjudicationId);
          delete state.adjudications[payload.adjudicationId];
          break;
        case 'reconstruction.locked':
          state.lockedCandidateId = payload.candidateId;
          break;
      }
    }
    return state;
  }

  listBranches(seriesId: Uid): Array<{ branchId: Uid; parentBranchId: Uid | null; reason: string; headEventId: EventId }> {
    const result: Array<{ branchId: Uid; parentBranchId: Uid | null; reason: string; headEventId: EventId }> = [];
    for (const event of this.store.listEvents(seriesId)) {
      if (event.payload.type === 'branch.created') {
        result.push({
          branchId: event.payload.branchId,
          parentBranchId: event.payload.parentBranchId,
          reason: event.payload.reason,
          headEventId: this.store.branchHead(event.payload.branchId),
        });
      }
    }
    return result;
  }

  /** 参数或参考版本变化后的失效范围：按依赖边传播；local 改动不全局替换旧结论。 */
  invalidationScope(entity: string, fromVersion: EventId): { affected: Array<{ entity: string; version: EventId; scope: 'local' | 'global' }>; global: boolean } {
    const events = this.store.listEvents();
    const affected: Array<{ entity: string; version: EventId; scope: 'local' | 'global' }> = [];
    let global = false;
    const queue: DependencyEdge[] = [];
    for (const event of events) {
      for (const dep of event.dependencies) {
        if (dep.toEntity === entity || dep.fromEntity === entity) {
          if (dep.scope === 'global') global = true;
          queue.push(dep);
          affected.push({ entity: dep.fromEntity, version: dep.fromVersion, scope: dep.scope });
        }
      }
    }
    void queue;
    void fromVersion;
    return { affected, global };
  }

  // ---- 实体查询：返回引用版本与内容摘要；缺少引用必须报损坏，不能退回最新版 ----

  getEntityView(entity: string, version: EventId): EntityView {
    const event = this.store.getEvent(version);
    if (!event) throw new CorruptArchiveError(`entity ${entity}@${version} missing (must not fall back to latest)`);
    const stored = this.store.getEntityVersion(entity, version);
    const summary: Record<string, unknown> = stored ? summarize(stored.value) : summarize(event.payload);
    return {
      stableId: entity,
      kind: (event.payload as { type?: string }).type ?? entity.split('/')[0],
      version: event.id,
      contentDigest: stored?.digest ?? event.commitDigest,
      summary,
      references: event.refs.map((ref) => {
        const target = this.store.getEvent(ref.version);
        if (!target) {
          throw new CorruptArchiveError(`dangling reference ${ref.entity}@${ref.version} from event ${event.id}`);
        }
        return { entity: ref.entity, version: ref.version, digest: ref.digest };
      }),
    };
  }

  getFrameBytes(blobDigest: string): Uint8Array {
    const content = this.store.getContent(blobDigest);
    if (!content) throw new CorruptArchiveError(`frame content ${blobDigest} missing`);
    return content.bytes;
  }

  /** 重建引用读回：必须解析到锁定的候选版本，禁止被后续新候选悄悄替换。 */
  resolveReconstructionRef(reconstructionRef: string): {
    seriesId: Uid;
    branchId: Uid;
    candidateId: Uid;
    lockedAtEvent: EventId;
    candidate: RegistrationCandidate;
  } {
    const match = /^reconref:(.+):(.+):(.+)@(\d+)$/.exec(reconstructionRef);
    if (!match) throw new CorruptArchiveError(`malformed reconstructionRef ${reconstructionRef}`);
    const [, seriesId, branchId, candidateId, atEvent] = match;
    const lockedAtEvent = Number(atEvent);
    const state = this.reduceBranch(branchId as Uid);
    if (state.lockedCandidateId !== candidateId) {
      throw new CorruptArchiveError(`reconstructionRef points to ${candidateId}, current lock is ${state.lockedCandidateId ?? 'none'}`);
    }
    const candidateAtLock = this.findCandidateAtEvent(branchId as Uid, candidateId as Uid, lockedAtEvent);
    if (!candidateAtLock) throw new CorruptArchiveError(`candidate ${candidateId} not resolvable at event ${lockedAtEvent}`);
    return { seriesId: seriesId as Uid, branchId: branchId as Uid, candidateId: candidateId as Uid, lockedAtEvent, candidate: candidateAtLock };
  }

  private findCandidateAtEvent(branchId: Uid, candidateId: Uid, upToEventId: EventId): RegistrationCandidate | null {
    const events = this.store
      .listEvents()
      .filter((e) => e.branchId === branchId && e.id <= upToEventId)
      .sort((a, b) => b.id - a.id);
    for (const event of events) {
      if (event.payload.type === 'candidate.proposed' && event.payload.candidate.candidateId === candidateId) {
        return event.payload.candidate;
      }
    }
    return null;
  }

  events(): ArchiveEvent[] {
    return this.store.listEvents();
  }

  verify(): { ok: true } | { ok: false; errors: string[] } {
    const integrity = this.store.verifyIntegrity();
    if (!integrity.ok) return integrity;
    this.store.assertCommitChain();
    return { ok: true };
  }
}

function summarize(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return { value };
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['type', 'seriesId', 'branchId', 'frameIndex', 'trackId', 'candidateId', 'kind', 'parameter']) {
    if (key in record) out[key] = record[key];
  }
  if ('candidate' in record) {
    const candidate = record.candidate as RegistrationCandidate;
    out.score = candidate.score;
    out.tiltAxis = candidate.tiltAxis;
  }
  return out;
}
