import type {
  AdjudicationContent, DomainEvent, ImportDiagnostic, RegistrationCandidateContent,
  RegistrationLockContent, RuleJudgementContent, TiltAxisRuleContent, TrackSegmentContent
} from '../core/types.ts';
import { blobDigest } from '../core/identity.ts';
import type { ProjectionState, SourceBundle } from './state.ts';
import { applyEvent, Corruption, replay } from './reducer.ts';
import { makeEvent } from './events.ts';
import { buildCandidates } from './candidates.ts';

export class VersionConflict extends Error {
  constructor(
    public clientHeadSeq: number,
    public serverHeadSeq: number,
    public diff: { branch: string; clientCandidateId: string; serverCandidateId: string; metrics: unknown }
  ) {
    super(`version conflict: client at ${clientHeadSeq}, server at ${serverHeadSeq}`);
    this.name = 'VersionConflict';
  }
}

export interface AppendResult {
  event: DomainEvent;
}

export interface StoredBlob {
  sha256: string;
  bytes: number;
  data: string;
}

export class ArchiveEngine {
  state: ProjectionState;
  private blobsData = new Map<string, string>();

  constructor(public archiveId: string, events: DomainEvent[] = [], blobs: StoredBlob[] = []) {
    this.state = replay(events, archiveId);
    for (const blob of blobs) {
      this.blobsData.set(blob.sha256, blob.data);
      this.state.blobs.set(blob.sha256, { bytes: blob.bytes, storedOnce: true });
    }
    // blob 已存在后重新校验引用
    if (events.length > 0) {
      for (const event of events) this.assertBlobPresence(event);
    }
  }

  get headSeq(): number {
    return this.state.headSeq;
  }

  events(): DomainEvent[] {
    return [...this.state.events];
  }

  blobs(): StoredBlob[] {
    return [...this.blobsData.entries()].map(([sha256, data]) => ({
      sha256, bytes: data.length, data
    }));
  }

  stateAt(seq: number): ProjectionState {
    return replay(this.state.events, this.archiveId, seq);
  }

  private assertBlobPresence(event: DomainEvent): void {
    for (const [key, ref] of Object.entries(event.dependencyRefs)) {
      if (key.startsWith('blob:') && !this.state.blobs.has(String(ref))) {
        throw new Corruption('CORRUPT_BLOB', `event ${event.eventId} missing blob ${ref}`, String(ref), event.seq);
      }
    }
  }

  private append(
    type: DomainEvent['type'],
    payload: unknown,
    branch: string,
    dependencyRefs: Record<string, string>,
    invalidationScope: string[],
    provenance: DomainEvent['provenance'],
    author: string,
    probeId?: string
  ): DomainEvent {
    const seq = this.state.headSeq + 1;
    const event = makeEvent({
      seq, type, branch, payload, author, dependencyRefs, invalidationScope, provenance, probeId
    });
    applyEvent(this.state, event);
    for (const [key, ref] of Object.entries(dependencyRefs)) {
      if (key.startsWith('blob:') && !this.blobsData.has(String(ref))) {
        throw new Corruption('CORRUPT_BLOB', `missing blob data ${ref}`, String(ref), seq);
      }
    }
    return event;
  }

  create(author = 'microscopy_team'): DomainEvent {
    if (this.state.headSeq !== 0) throw new Error('archive already created');
    const seq = 1;
    const event = makeEvent({
      seq, type: 'archive.created', branch: 'main',
      payload: { archiveId: this.archiveId, format: 'tilt-chamber-archive/v1' },
      author, dependencyRefs: {}, invalidationScope: [],
      provenance: { directSourceEventIds: [] }
    });
    applyEvent(this.state, event);
    return event;
  }

  /** 原子导入：结构失败整体回滚；不可转换量只产生诊断、保留原位 */
  importSource(bundle: SourceBundle, batch: { batchId: string; kind: string; summary: string },
               author = 'microscopy_team', probeId?: string): {
    event: DomainEvent; diagnostics: ImportDiagnostic[]; blobs: StoredBlob[]
  } {
    const checkpoint = this.state.headSeq;
    const diagnostics: ImportDiagnostic[] = [];
    const newBlobs = new Map<string, StoredBlob>();
    try {
      // 结构校验：帧/倾角一一对应、观测引用合法帧与标记、缺口引用帧
      const frameIds = new Set(bundle.frames.map((f) => f.frameId));
      if (frameIds.size !== bundle.frames.length) {
        throw new Error('duplicate frameId in import');
      }
      for (const tilt of bundle.tilts) {
        if (!frameIds.has(tilt.frameId)) throw new Error(`tilt references unknown frame ${tilt.frameId}`);
      }
      const markerIds = new Set(bundle.markers.map((m) => m.markerId));
      for (const obs of bundle.observations) {
        if (!frameIds.has(obs.frameId)) throw new Error(`observation references unknown frame ${obs.frameId}`);
        if (!markerIds.has(obs.markerId)) throw new Error(`observation references unknown marker ${obs.markerId}`);
      }
      for (const gap of bundle.gaps) {
        if (!markerIds.has(gap.markerId)) throw new Error(`gap references unknown marker ${gap.markerId}`);
      }

      const checkQ = (path: string, q: { convertible: boolean; diagnostic?: string; raw?: unknown }) => {
        if (!q.convertible) {
          diagnostics.push({
            level: 'warning', code: 'UNCONVERTIBLE_QUANTITY',
            message: q.diagnostic ?? 'unconvertible quantity retained in place',
            path, quantityRaw: (q.raw as string | number | null) ?? null
          });
        }
      };
      for (const t of bundle.tilts) checkQ(`tilts.${t.frameId}.angle`, t.angle);
      for (const d of bundle.doses) checkQ(`doses.${d.frameId}.dose`, d.dose);
      for (const s of bundle.scales) checkQ('scales.scale', s.scale);
      for (const o of bundle.observations) {
        checkQ(`observations.${o.observationId}.x`, o.x);
        checkQ(`observations.${o.observationId}.y`, o.y);
      }

      // blob 去重：共享原始片段只存一份不可变内容
      const blobRefs: Record<string, string> = {};
      for (const frame of bundle.frames) {
        const sha = frame.contentRef.sha256;
        blobRefs[`blob:frame:${frame.frameId}`] = sha;
        if (!this.blobsData.has(sha) && !newBlobs.has(sha)) {
          const data = `RAW-TIFF/${frame.rawFileName}/${frame.intensitySignature.join(',')}`;
          if (blobDigest(data) !== sha) {
            throw new Error(`blob digest mismatch for ${frame.frameId}`);
          }
          newBlobs.set(sha, { sha256: sha, bytes: data.length, data });
        }
      }

      const event = this.append('source.imported', { batch, source: bundle },
        'main', blobRefs, [
          'rawFrame', 'tiltAngle', 'pixelScale', 'dose',
          'fiducialMarker', 'markerObservation', 'trackingGap', 'manualExclusion'
        ], { directSourceEventIds: [], importBatchId: batch.batchId, note: batch.summary },
        author, probeId);

      for (const blob of newBlobs.values()) {
        this.blobsData.set(blob.sha256, blob.data);
        this.state.blobs.set(blob.sha256, { bytes: blob.bytes, storedOnce: true });
      }
      this.state.lastImportDiagnostics = { batchId: batch.batchId, diagnostics };
      return { event, diagnostics, blobs: [...newBlobs.values()] };
    } catch (err) {
      // 回滚本次变更：重放到检查点，不留半份记录
      this.state = replay(this.state.events.filter((e) => e.seq <= checkpoint), this.archiveId);
      for (const [sha, blob] of this.blobsData) {
        if (newBlobs.has(sha)) this.state.blobs.set(sha, { bytes: blob.length, storedOnce: true });
      }
      throw err;
    }
  }

  reviseAxis(rule: TiltAxisRuleContent, reason: string, author = 'reviewer',
             branch = 'main', probeId?: string): DomainEvent {
    const prev = this.latestVersionRef('tiltAxisRule', rule.axisId);
    const scope = ['tiltAxisRule:' + rule.axisId, ...this.candidateIdsDependingOnAxis()];
    return this.append('axis.rule_revised', rule, branch,
      prev ? { 'axis:rule': prev } : {},
      scope,
      { directSourceEventIds: prev ? [this.latestEventIdFor(rule.axisId) as string] : [], note: reason },
      author, probeId);
  }

  reviseSegment(segment: TrackSegmentContent, reason: string, author = 'reviewer',
                branch = 'main', probeId?: string): DomainEvent {
    const refs: Record<string, string> = {};
    for (const obsId of segment.observationIds) {
      const ref = this.latestVersionRef('markerObservation', obsId);
      if (ref) refs[`obs:${obsId}`] = ref;
    }
    return this.append('track.segment_revised', segment, branch, refs,
      ['trackSegmentRule:' + segment.segmentId, 'registrationCandidate:*'],
      { directSourceEventIds: [this.latestEventIdFor(segment.segmentId) ?? ''].filter(Boolean), note: reason },
      author, probeId);
  }

  changeFrameExclusion(exclusionId: string, active: boolean, reason: string,
                       author = 'reviewer', branch = 'main', probeId?: string): DomainEvent {
    const ref = this.latestVersionRef('manualExclusion', exclusionId);
    return this.append('frame.exclusion_changed',
      { exclusionId, active }, branch, ref ? { `exclusion:${exclusionId}`: ref } : {},
      [`manualExclusion:${exclusionId}`, 'registrationCandidate:*'],
      { directSourceEventIds: [], note: reason }, author, probeId);
  }

  reviseSource(kind: ProjectionState['entities'] extends never ? never : string,
               stableId: string, content: unknown, reason: string, blobRefs: string[] = [],
               author = 'reviewer', branch = 'main', probeId?: string): DomainEvent {
    const prev = this.latestVersionRef(kind as never, stableId);
    const refs: Record<string, string> = {};
    if (prev) refs[`${this.refPrefix(kind)}:${stableId}`] = prev;
    for (const sha of blobRefs) refs[`blob:${stableId}:${sha.slice(0, 8)}`] = sha;
    return this.append('source.revised', { kind, stableId, content, blobRefs }, branch, refs,
      [`${kind}:${stableId}`, ...this.dependentDerived(kind, stableId)],
      { directSourceEventIds: prev ? [this.latestEventIdFor(stableId) as string] : [], note: reason },
      author, probeId);
  }

  createBranch(branch: string, parentBranch = 'main', reason = 'second review branch',
               author = 'reviewer'): DomainEvent {
    if (this.state.branches.has(branch)) throw new Error(`branch ${branch} already exists`);
    const parentTip = this.state.branches.get(parentBranch)?.tipEventId;
    return this.append('branch.created', { branch, parentBranch, reason }, parentBranch,
      {}, [], { directSourceEventIds: parentTip ? [parentTip] : [], note: reason }, author);
  }

  openProbe(probeId: string, code: string, author = 'reviewer'): DomainEvent {
    return this.append('probe.opened', { probeId, code }, 'main', {},
      [`probe:${probeId}`], { directSourceEventIds: [], note: `open ${code}` }, author, probeId);
  }

  closeProbe(probeId: string, author = 'reviewer'): DomainEvent {
    return this.append('probe.closed', { probeId }, 'main', {},
      [`probe:${probeId}`], { directSourceEventIds: [], note: 'close' }, author, probeId);
  }

  private latestVersionRef(kind: string, stableId: string): string | null {
    const env = this.state.entities.get(stableId)?.envelope;
    if (!env || env.kind !== kind) return null;
    return `${stableId}@${env.versionId}`;
  }

  private latestEventIdFor(stableId: string): string | null {
    return this.state.entities.get(stableId)?.envelope.createdByEventId ?? null;
  }

  private refPrefix(kind: string): string {
    const map: Record<string, string> = {
      tiltAngle: 'tilt', dose: 'dose', pixelScale: 'scale', rawFrame: 'frame',
      fiducialMarker: 'marker', markerObservation: 'obs', trackingGap: 'gap',
      manualExclusion: 'exclusion'
    };
    return map[kind] ?? kind;
  }

  private candidateIdsDependingOnAxis(): string[] {
    const ids: string[] = [];
    for (const record of this.state.entities.values()) {
      if (record.envelope.kind === 'registrationCandidate') ids.push(`registrationCandidate:${(record.envelope.content as RegistrationCandidateContent).candidateId}`);
    }
    return ids;
  }

  private dependentDerived(kind: string, stableId: string): string[] {
    // 依赖关系计算失效范围：源数据改动只影响引用它的派生候选，不做全局替换
    const affected: string[] = [];
    if (kind === 'dose' || kind === 'pixelScale') {
      // 几何配准不依赖剂量；仅标记剂量派生层
      affected.push(`doseDerivation:${stableId}`);
      return affected;
    }
    if (kind === 'tiltAngle') {
      for (const record of this.state.entities.values()) {
        if (record.envelope.kind === 'registrationCandidate') {
          affected.push(`registrationCandidate:${(record.envelope.content as RegistrationCandidateContent).candidateId}`);
        }
      }
    }
    return affected;
  }
  /** 计算并显式保存多候选 + 机器可读判断依据 */
  computeAndRecordCandidates(author = 'reviewer', branch = 'main', probeId?: string): {
    candidateEvents: DomainEvent[];
    judgementEvents: DomainEvent[];
    result: ReturnType<typeof buildCandidates>;
  } {
    const result = buildCandidates(this.state, { probeId, author });
    const axisRef = this.latestVersionRef('tiltAxisRule', 'axis_primary');
    const candidateEvents: DomainEvent[] = [];
    const judgementEvents: DomainEvent[] = [];

    for (const candidate of result.candidates) {
      const refs: Record<string, string> = {};
      if (axisRef) refs['axis:axis_primary'] = axisRef;
      candidate.effectiveObservationIds.slice(0, 40).forEach((obsId, i) => {
        const ref = this.latestVersionRef('markerObservation', obsId);
        if (ref) refs[`obs:${i}:${obsId}`] = ref;
      });
      const sourceEvents = [...new Set(candidate.effectiveObservationIds
        .map((id) => this.latestEventIdFor(id)).filter((v): v is string => !!v))];
      candidateEvents.push(this.append('registration.computed', candidate, branch, refs,
        [`registrationCandidate:${candidate.candidateId}`],
        { directSourceEventIds: sourceEvents, note: candidate.label, importBatchId: probeId },
        author, probeId));
    }
    for (const judgement of result.judgements) {
      const refs: Record<string, string> = {};
      for (const id of judgement.relatedCandidateIds.slice(0, 4)) {
        const ref = this.latestVersionRef('registrationCandidate', id);
        if (ref) refs[`candidate:${id}`] = ref;
      }
      judgementEvents.push(this.append('rule.judged', judgement, branch, refs,
        [`ruleJudgement:${judgement.judgementId}`],
        { directSourceEventIds: candidateEvents.map((e) => e.eventId), note: judgement.code },
        author, probeId));
    }
    return { candidateEvents, judgementEvents, result };
  }

  /** 无法唯一决定时保存全部合法候选；显式选定只是记录选择，不抹掉其余候选 */
  resolveAmbiguitySet(chosenCandidateId: string, allLegalCandidateIds: string[],
                      reason: string, author = 'reviewer', branch = 'main', probeId?: string): DomainEvent {
    const ref = this.latestVersionRef('registrationCandidate', chosenCandidateId);
    const refs = ref ? { [`candidate:${chosenCandidateId}`]: ref } : {};
    return this.append('ambiguity.resolved_set',
      { chosenCandidateId, allLegalCandidateIds, reason }, branch, refs,
      allLegalCandidateIds.map((id) => `registrationCandidate:${id}`),
      { directSourceEventIds: [], note: reason }, author, probeId);
  }

  /** 接受/否定；expectedHeadSeq 实现乐观锁，后提交者收到 409 与双方差异 */
  adjudicate(input: {
    candidateId: string;
    decision: AdjudicationContent['decision'];
    reason: string;
    author?: string;
    branch?: string;
    expectedHeadSeq: number;
    probeId?: string;
  }): DomainEvent {
    const author = input.author ?? 'reviewer';
    const branch = input.branch ?? 'main';
    if (input.expectedHeadSeq !== this.state.headSeq) {
      const mine = this.state.entities.get(input.candidateId)?.envelope.content as
        RegistrationCandidateContent | undefined;
      const otherAccepted = this.state.acceptedCandidate.get(branch);
      const other = otherAccepted
        ? (this.state.entities.get(otherAccepted)?.envelope.content as AdjudicationContent | undefined)
        : undefined;
      throw new VersionConflict(input.expectedHeadSeq, this.state.headSeq, {
        branch,
        clientCandidateId: input.candidateId,
        serverCandidateId: other?.candidateId ?? '(uncommitted other change)',
        metrics: {
          client: mine ? { rmse: mine.metrics.commonSetRmsePx, coverage: mine.metrics.coverageFrames } : null,
          server: other ? { adjudicationId: other.adjudicationId } : null
        }
      });
    }
    const candidateRef = this.latestVersionRef('registrationCandidate', input.candidateId);
    if (!candidateRef) throw new Error(`unknown candidate ${input.candidateId}`);
    const n = this.state.events.filter((e) => e.type === 'adjudication.recorded').length + 1;
    const content: AdjudicationContent = {
      adjudicationId: `adj_${String(n).padStart(3, '0')}_${input.candidateId}`,
      decision: input.decision,
      candidateId: input.candidateId,
      reason: input.reason,
      author,
      revoked: false
    };
    return this.append('adjudication.recorded', content, branch,
      { [`candidate:${input.candidateId}`]: candidateRef },
      [`adjudication:${content.adjudicationId}`, `registrationCandidate:${input.candidateId}`],
      { directSourceEventIds: [this.latestEventIdFor(input.candidateId) as string], note: input.reason },
      author, input.probeId);
  }

  revokeAdjudication(adjudicationId: string, reason: string, author = 'reviewer',
                     branch = 'main', probeId?: string): DomainEvent {
    const ref = this.latestVersionRef('adjudication', adjudicationId);
    if (!ref) throw new Error(`unknown adjudication ${adjudicationId}`);
    return this.append('adjudication.revoked', { adjudicationId, reason }, branch,
      { [`adjudication:${adjudicationId}`]: ref },
      [`adjudication:${adjudicationId}`],
      { directSourceEventIds: [this.latestEventIdFor(adjudicationId) as string], note: reason },
      author, probeId);
  }

  /** 锁定一版配准供重建引用：引用候选版本+全部依赖版本摘要 */
  lockRegistration(candidateId: string, expectedHeadSeq: number, author = 'reviewer',
                   branch = 'main', probeId?: string): DomainEvent {
    if (expectedHeadSeq !== this.state.headSeq) {
      throw new VersionConflict(expectedHeadSeq, this.state.headSeq, {
        branch, clientCandidateId: candidateId, serverCandidateId: '(lock conflict)', metrics: null
      });
    }
    const candidateEnv = this.state.entities.get(candidateId)?.envelope;
    if (!candidateEnv) throw new Error(`unknown candidate ${candidateId}`);
    const candidate = candidateEnv.content as RegistrationCandidateContent;
    if (candidate.ambiguity.nonUnique && candidate.ambiguity.equivalentCandidateIds.length > 0) {
      const chosen = this.state.events.some((e) => e.type === 'ambiguity.resolved_set'
        && (e.payload as { chosenCandidateId?: string }).chosenCandidateId === candidateId);
      if (!chosen) {
        throw new Error('cannot lock: non-unique solution requires explicit ambiguity resolution first');
      }
    }
    const dependencyDigest = [...candidate.effectiveObservationIds]
      .map((id) => this.latestVersionRef('markerObservation', id))
      .filter(Boolean).sort().join('|');
    const referenceDigest = `${candidateId}@${candidateEnv.versionId}|${candidate.tiltAxisId}|${dependencyDigest.length}`;
    const content: RegistrationLockContent = {
      lockId: `lock_${String(this.state.events.filter((e) => e.type === 'registration.locked').length + 1).padStart(3, '0')}`,
      candidateId,
      referenceDigest,
      active: true
    };
    return this.append('registration.locked', content, branch,
      { [`candidate:${candidateId}`]: `${candidateId}@${candidateEnv.versionId}` },
      [`registrationLock:${content.lockId}`],
      { directSourceEventIds: [candidateEnv.createdByEventId], note: 'locked for reconstruction reference' },
      author, probeId);
  }

  releaseLock(lockId: string, reason: string, author = 'reviewer', branch = 'main'): DomainEvent {
    const ref = this.latestVersionRef('registrationLock', lockId);
    if (!ref) throw new Error(`unknown lock ${lockId}`);
    return this.append('registration.lock_released', { lockId, reason }, branch,
      { [`adjudication:${lockId}`]: ref }, [`registrationLock:${lockId}`],
      { directSourceEventIds: [this.latestEventIdFor(lockId) as string], note: reason }, author);
  }

  /** 显式记录机器可读判断依据（如并发冻结的运行时事件） */
  recordJudgement(judgement: RuleJudgementContent, reason: string, author = 'reviewer',
                  branch = 'main', probeId?: string): DomainEvent {
    const refs: Record<string, string> = {};
    for (const id of judgement.relatedCandidateIds.slice(0, 4)) {
      const ref = this.latestVersionRef('registrationCandidate', id);
      if (ref) refs[`candidate:${id}`] = ref;
    }
    return this.append('rule.judged', judgement, branch, refs,
      [`ruleJudgement:${judgement.judgementId}`],
      { directSourceEventIds: [], note: reason }, author, probeId);
  }

  /** 查询实体：返回稳定身份、当前版本、内容摘要、上一版引用与全部版本链 */
  queryEntity(stableId: string): unknown {
    const env = this.state.entities.get(stableId)?.envelope;
    if (!env) {
      throw new Corruption('CORRUPT_REFERENCE', `entity not found: ${stableId}`, stableId);
    }
    const versions = (this.state.history.get(stableId) ?? []).map((e) => ({
      versionId: e.versionId,
      seq: e.seq,
      contentSummary: e.contentSummary,
      status: e.status,
      createdByEventId: e.createdByEventId,
      branch: e.branch
    }));
    return {
      stableId: env.stableId,
      kind: env.kind,
      versionId: env.versionId,
      contentSummary: env.contentSummary,
      status: env.status,
      predecessorVersionId: env.predecessorVersionId,
      blobRefs: env.blobRefs,
      createdByEventId: env.createdByEventId,
      dependencyVersions: this.dependencyVersionsOf(stableId),
      content: env.content,
      versions
    };
  }

  private dependencyVersionsOf(stableId: string): Record<string, string> {
    const eventId = this.state.entities.get(stableId)?.envelope.createdByEventId;
    const event = this.state.events.find((e) => e.eventId === eventId);
    return event ? { ...event.dependencyRefs } : {};
  }

  /** 失效范围：给定事件 seq 之后哪些实体的版本被更新（不静默替换旧结论） */
  invalidationAfter(seq: number): Array<{ scope: string; events: DomainEvent[] }> {
    const scopes = new Map<string, DomainEvent[]>();
    for (const event of this.state.events) {
      if (event.seq <= seq) continue;
      for (const scope of event.invalidationScope) {
        const list = scopes.get(scope) ?? [];
        list.push(event);
        scopes.set(scope, list);
      }
    }
    return [...scopes.entries()].map(([scope, events]) => ({ scope, events }));
  }

  /** 反查来源链：实体 → 创建事件 → 直接来源事件 → 输入批次 */
  provenanceChain(stableId: string): unknown {
    const chain: unknown[] = [];
    let currentId = this.state.entities.get(stableId)?.envelope.createdByEventId ?? null;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const event = this.state.events.find((e) => e.eventId === currentId);
      if (!event) break;
      chain.push({
        eventId: event.eventId,
        seq: event.seq,
        type: event.type,
        branch: event.branch,
        importBatchId: event.provenance.importBatchId ?? null,
        note: event.provenance.note ?? null,
        dependencyRefs: event.dependencyRefs,
        invalidationScope: event.invalidationScope,
        author: event.author,
        atIso: event.atIso
      });
      currentId = event.provenance.directSourceEventIds[0] ?? null;
    }
    return { stableId, chain };
  }


}
