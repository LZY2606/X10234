import type { DatabaseSync } from 'node:sqlite';
import {
  contentId,
  entityVersionId,
  sha256,
  sha256Short,
  stableId,
} from '../shared/identity';
import type {
  ArchiveExport,
  Branch,
  CandidateMethod,
  DependencyRef,
  DiagnosisCode,
  DomainEvent,
  DomainQuantity,
  EventType,
  LockedRegistration,
  RegistrationCandidate,
  ReviewDecision,
  SourceEntity,
  SourceKind,
  SourceVersion,
  TiltAxisModel,
} from '../shared/model';
import { CORRUPTION_ERROR } from '../shared/model';

export interface StoreError extends Error {
  code: string;
  details?: unknown;
}

export function err(code: string, message: string, details?: unknown): StoreError {
  const e = new Error(message) as StoreError;
  e.code = code;
  e.details = details;
  return e;
}

export interface AddSourceInput {
  branchId: string;
  kind: SourceKind;
  label: string;
  quantity: DomainQuantity;
  frameId?: string;
  trackId?: string;
  blobId?: string;
  createdBy?: string;
}

export interface SaveCandidateInput {
  branchId: string;
  method: CandidateMethod;
  axis: TiltAxisModel;
  transforms: Record<string, { tx: number; ty: number }>;
  perFrame: RegistrationCandidate['perFrame'];
  effectiveFrameIds: string[];
  effectivePointKey: string;
  rmsePx: number;
  holdoutRmsePx?: number;
  dof: number;
  diagnoses: DiagnosisCode[];
  status?: RegistrationCandidate['status'];
  ambiguityGroupId?: string;
  dependencies: DependencyRef[];
  basisRuleVersion: string;
}

export class Store {
  constructor(private db: DatabaseSync) {}

  now(): string {
    return new Date().toISOString();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- blobs ----------
  putBlob(bytes: Buffer, mediaType: string): { blobId: string; reused: boolean } {
    const digest = sha256(bytes);
    const blobId = `blob_${digest.slice(0, 24)}`;
    const existing = this.db.prepare('SELECT blob_id FROM blobs WHERE blob_id=?').get(blobId);
    if (existing) return { blobId, reused: true };
    this.db
      .prepare('INSERT INTO blobs(blob_id,byte_sha256,byte_count,media_type,bytes) VALUES (?,?,?,?,?)')
      .run(blobId, digest, bytes.length, mediaType, bytes);
    return { blobId, reused: false };
  }

  getBlob(blobId: string): Buffer | undefined {
    const row = this.db.prepare('SELECT bytes FROM blobs WHERE blob_id=?').get(blobId) as
      | { bytes?: Buffer }
      | undefined;
    return row?.bytes;
  }

  // ---------- branches ----------
  createBranch(name: string, parentBranchId?: string): Branch {
    const branch: Branch = {
      id: stableId('br', { name, parentBranchId, t: this.now() }),
      name,
      parentBranchId,
      revision: 0,
      headSeq: 0,
      createdAt: this.now(),
    };
    this.db
      .prepare('INSERT INTO branches(branch_id,name,parent_branch_id,revision,head_seq,created_at) VALUES (?,?,?,?,?,?)')
      .run(branch.id, branch.name, parentBranchId ?? null, 0, 0, branch.createdAt);
    this.appendEvent({
      type: 'branch.created',
      branchId: branch.id,
      payload: { name, parentBranchId: parentBranchId ?? null },
      basisVersion: 'rules@v1',
      createdBy: 'system',
    });
    return branch;
  }

  private rowToBranch(r: Record<string, unknown>): Branch {
    return {
      id: r.branch_id as string,
      name: r.name as string,
      parentBranchId: (r.parent_branch_id as string) ?? undefined,
      revision: r.revision as number,
      headSeq: r.head_seq as number,
      createdAt: r.created_at as string,
    };
  }

  getBranch(branchId: string): Branch | undefined {
    const r = this.db.prepare('SELECT * FROM branches WHERE branch_id=?').get(branchId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToBranch(r) : undefined;
  }

  listBranches(): Branch[] {
    return (this.db.prepare('SELECT * FROM branches ORDER BY created_at').all() as Record<string, unknown>[]).map((r) =>
      this.rowToBranch(r)
    );
  }

  // ---------- events ----------
  private nextSeq(branchId: string): number {
    const max = this.db
      .prepare('SELECT COALESCE(MAX(seq),0) AS m FROM events WHERE branch_id=?')
      .get(branchId) as { m: number };
    return max.m + 1;
  }

  appendEvent(args: {
    type: EventType;
    branchId: string;
    payload: unknown;
    basisVersion: string;
    createdBy: string;
    parentEventId?: string;
  }): DomainEvent {
    const branch = this.getBranch(args.branchId);
    if (!branch) throw err('NO_BRANCH', `branch not found: ${args.branchId}`);
    const seq = this.nextSeq(args.branchId);
    const createdAt = this.now();
    const event: DomainEvent = {
      eventId: `evt_${sha256Short(
        JSON.stringify({ type: args.type, branchId: args.branchId, seq, payload: args.payload, basisVersion: args.basisVersion, createdAt })
      )}`,
      seq,
      type: args.type,
      branchId: args.branchId,
      parentEventId: args.parentEventId,
      basisVersion: args.basisVersion,
      payload: args.payload,
      createdAt,
      createdBy: args.createdBy,
    };
    this.db
      .prepare(
        `INSERT INTO events(event_id,seq,type,branch_id,parent_event_id,basis_version,payload_json,created_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        event.eventId, event.seq, event.type, event.branchId, event.parentEventId ?? null,
        event.basisVersion, JSON.stringify(event.payload), event.createdAt, event.createdBy
      );
    this.db.prepare('UPDATE branches SET revision=revision+1, head_seq=? WHERE branch_id=?').run(seq, args.branchId);
    return event;
  }

  private rowToEvent(r: Record<string, unknown>): DomainEvent {
    return {
      eventId: r.event_id as string,
      seq: r.seq as number,
      type: r.type as EventType,
      branchId: r.branch_id as string,
      parentEventId: (r.parent_event_id as string) ?? undefined,
      basisVersion: r.basis_version as string,
      payload: JSON.parse(r.payload_json as string) as unknown,
      createdAt: r.created_at as string,
      createdBy: r.created_by as string,
    };
  }

  listEvents(branchId?: string): DomainEvent[] {
    const rows = branchId
      ? (this.db.prepare('SELECT * FROM events WHERE branch_id=? ORDER BY seq').all(branchId) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM events ORDER BY branch_id, seq').all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToEvent(r));
  }

  branchViewAt(branchId: string, atSeq?: number): DomainEvent[] {
    const events = this.listEvents(branchId);
    return typeof atSeq === 'number' ? events.filter((e) => e.seq <= atSeq) : events;
  }

  // ---------- 来源版本化 ----------
  addSourceVersion(input: AddSourceInput): { entity: SourceEntity; version: SourceVersion; event: DomainEvent } {
    return this.tx(() => {
      const entityId = contentId('src', {
        kind: input.kind,
        frameId: input.frameId ?? null,
        trackId: input.trackId ?? null,
        label: input.label,
      });
      const existing = this.db.prepare('SELECT * FROM source_entities WHERE entity_id=?').get(entityId) as
        | Record<string, unknown>
        | undefined;
      const version = existing ? ((existing.current_version as number) + 1) : 1;
      const versionId = entityVersionId(entityId, version);
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO source_entities(entity_id,kind,frame_id,track_id,label,current_version,branch_id)
             VALUES (?,?,?,?,?,?,?)`
          )
          .run(entityId, input.kind, input.frameId ?? null, input.trackId ?? null, input.label, 1, input.branchId);
      } else {
        this.db.prepare('UPDATE source_entities SET current_version=? WHERE entity_id=?').run(version, entityId);
      }
      const event = this.appendEvent({
        type: 'source.versioned',
        branchId: input.branchId,
        basisVersion: this.currentRulesVersion(),
        createdBy: input.createdBy ?? 'importer',
        payload: {
          entityId,
          kind: input.kind,
          version,
          frameId: input.frameId ?? null,
          trackId: input.trackId ?? null,
          quantity: input.quantity,
          blobId: input.blobId ?? null,
        },
      });
      this.db
        .prepare(
          `INSERT INTO source_versions(version_id,entity_id,version,payload_json,blob_id,branch_id,event_id,created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          versionId, entityId, version, JSON.stringify(input.quantity), input.blobId ?? null,
          input.branchId, event.eventId, event.createdAt
        );
      return {
        entity: {
          id: entityId,
          kind: input.kind,
          frameId: input.frameId,
          trackId: input.trackId,
          label: input.label,
          currentVersion: version,
        },
        version: {
          id: versionId,
          entityId,
          version,
          quantity: input.quantity,
          blobId: input.blobId,
          branchId: input.branchId,
          eventId: event.eventId,
          createdAt: event.createdAt,
        },
        event,
      };
    });
  }

  private getEntityRow(entityId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM source_entities WHERE entity_id=?').get(entityId) as
      | Record<string, unknown>
      | undefined;
  }

  getSourceVersion(versionId: string): SourceVersion | undefined {
    const r = this.db.prepare('SELECT * FROM source_versions WHERE version_id=?').get(versionId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: r.version_id as string,
      entityId: r.entity_id as string,
      version: r.version as number,
      quantity: JSON.parse(r.payload_json as string) as DomainQuantity,
      blobId: (r.blob_id as string) ?? undefined,
      branchId: r.branch_id as string,
      eventId: r.event_id as string,
      createdAt: r.created_at as string,
    };
  }

  listSourceEntities(): SourceEntity[] {
    return (this.db.prepare('SELECT * FROM source_entities ORDER BY kind,label').all() as Record<string, unknown>[]).map(
      (r) => ({
        id: r.entity_id as string,
        kind: r.kind as SourceKind,
        frameId: (r.frame_id as string) ?? undefined,
        trackId: (r.track_id as string) ?? undefined,
        label: r.label as string,
        currentVersion: r.current_version as number,
      })
    );
  }

  // ---------- 参数 / 规则 ----------
  currentRulesVersion(): string {
    const r = this.db.prepare(`SELECT value_json FROM parameters WHERE param_key='__rules__'`).get() as
      | { value_json?: string }
      | undefined;
    return r ? (JSON.parse(r.value_json!) as { v: string }).v : 'rules@v1';
  }

  reviseParameter(
    branchId: string,
    key: string,
    value: unknown,
    rulesVersion: string,
    createdBy: string,
    note: string
  ): { event: DomainEvent; invalidated: string[] } {
    return this.tx(() => {
      const event = this.appendEvent({
        type: 'parameter.revised',
        branchId,
        basisVersion: rulesVersion,
        createdBy,
        payload: { key, value, note },
      });
      this.db
        .prepare(
          `INSERT INTO parameters(param_key,value_json,rule_version,updated_event_id,updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(param_key) DO UPDATE SET value_json=excluded.value_json,
             rule_version=excluded.rule_version, updated_event_id=excluded.updated_event_id, updated_at=excluded.updated_at`
        )
        .run(key, JSON.stringify(value), rulesVersion, event.eventId, event.createdAt);
      if (key === '__rules__') {
        // 规则版本变化单独参数；这里仍记录失效范围。
      }
      const invalidated = this.invalidateDependents({
        refKind: 'parameter',
        refId: key,
        newVersion: `${rulesVersion}#${event.eventId}`,
        reason: `parameter revised: ${key} (${note})`,
        eventId: event.eventId,
        branchId,
      });
      return { event, invalidated };
    });
  }

  getParameter(key: string): unknown {
    const r = this.db.prepare('SELECT value_json FROM parameters WHERE param_key=?').get(key) as
      | { value_json?: string }
      | undefined;
    return r ? JSON.parse(r.value_json!) : undefined;
  }

  reviseSourceVersion(args: {
    branchId: string;
    entityId: string;
    quantity: DomainQuantity;
    kind: SourceKind;
    createdBy: string;
    note: string;
    blobId?: string;
  }): { version: SourceVersion; invalidated: string[] } {
    return this.tx(() => {
      const entity = this.getEntityRow(args.entityId);
      if (!entity) throw err('NOT_FOUND', args.entityId);
      const version = (entity.current_version as number) + 1;
      const versionId = entityVersionId(args.entityId, version);
      const event = this.appendEvent({
        type: 'source.reinterpreted',
        branchId: args.branchId,
        basisVersion: this.currentRulesVersion(),
        createdBy: args.createdBy,
        payload: { entityId: args.entityId, kind: args.kind, version, quantity: args.quantity, note: args.note },
      });
      this.db
        .prepare(
          `INSERT INTO source_versions(version_id,entity_id,version,payload_json,blob_id,branch_id,event_id,created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          versionId, args.entityId, version, JSON.stringify(args.quantity), args.blobId ?? null,
          args.branchId, event.eventId, event.createdAt
        );
      this.db.prepare('UPDATE source_entities SET current_version=? WHERE entity_id=?').run(version, args.entityId);
      const invalidated = this.invalidateDependents({
        refKind: 'source_version',
        refId: args.entityId,
        newVersion: versionId,
        reason: `源数据改动（局部依赖）：${args.entityId} → ${versionId}；${args.note}`,
        eventId: event.eventId,
        branchId: args.branchId,
      });
      return { version: this.getSourceVersion(versionId)!, invalidated };
    });
  }

  // ---------- 候选 / 依赖失效 ----------
  saveCandidate(input: SaveCandidateInput): { candidate: RegistrationCandidate; event: DomainEvent } {
    return this.tx(() => {
      const id = stableId('cand', {
        method: input.method,
        branchId: input.branchId,
        axis: input.axis,
        effectivePointKey: input.effectivePointKey,
        rmsePx: input.rmsePx,
        perFrame: input.perFrame,
      });
      const existing = this.db.prepare('SELECT candidate_id FROM candidates WHERE candidate_id=?').get(id);
      const event = this.appendEvent({
        type: 'candidate.computed',
        branchId: input.branchId,
        basisVersion: input.basisRuleVersion,
        createdBy: 'engine',
        payload: {
          candidateId: id,
          method: input.method,
          rmsePx: input.rmsePx,
          holdoutRmsePx: input.holdoutRmsePx ?? null,
          diagnoses: input.diagnoses,
          effectivePointKey: input.effectivePointKey,
          effectiveFrameIds: input.effectiveFrameIds,
          axis: input.axis,
          reused: !!existing,
        },
      });
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO candidates(candidate_id,branch_id,method,basis_rule_version,axis_json,transforms_json,
               per_frame_json,effective_frame_ids,effective_point_key,rmse_px,holdout_rmse_px,dof,
               diagnoses_json,status,ambiguity_group_id,dependencies_json,valid,stale_reason,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,?)`
          )
          .run(
            id, input.branchId, input.method, input.basisRuleVersion, JSON.stringify(input.axis),
            JSON.stringify(input.transforms), JSON.stringify(input.perFrame), JSON.stringify(input.effectiveFrameIds),
            input.effectivePointKey, input.rmsePx, input.holdoutRmsePx ?? null, input.dof,
            JSON.stringify(input.diagnoses), input.status ?? 'valid', input.ambiguityGroupId ?? null,
            JSON.stringify(input.dependencies), event.createdAt
          );
        for (const dep of input.dependencies) {
          this.db
            .prepare('INSERT OR IGNORE INTO dependencies(derived_id,ref_kind,ref_id,ref_version) VALUES (?,?,?,?)')
            .run(id, dep.refKind, dep.refId, dep.refVersion);
        }
      }
      return { candidate: this.getCandidate(id)!, event };
    });
  }

  private rowToCandidate(r: Record<string, unknown>): RegistrationCandidate {
    return {
      id: r.candidate_id as string,
      branchId: r.branch_id as string,
      method: r.method as CandidateMethod,
      basisRuleVersion: r.basis_rule_version as string,
      axis: JSON.parse(r.axis_json as string) as TiltAxisModel,
      frameTransforms: JSON.parse(r.transforms_json as string),
      perFrame: JSON.parse(r.per_frame_json as string),
      effectiveFrameIds: JSON.parse(r.effective_frame_ids as string),
      effectivePointKey: r.effective_point_key as string,
      rmsePx: r.rmse_px as number,
      holdoutRmsePx: (r.holdout_rmse_px as number) ?? undefined,
      dof: r.dof as number,
      diagnoses: JSON.parse(r.diagnoses_json as string),
      status: r.status as RegistrationCandidate['status'],
      ambiguityGroupId: (r.ambiguity_group_id as string) ?? undefined,
      createdAt: r.created_at as string,
    };
  }

  getCandidate(id: string): RegistrationCandidate | undefined {
    const r = this.db.prepare('SELECT * FROM candidates WHERE candidate_id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToCandidate(r) : undefined;
  }

  listCandidates(branchId?: string): RegistrationCandidate[] {
    const rows = branchId
      ? (this.db
          .prepare('SELECT * FROM candidates WHERE branch_id=? ORDER BY created_at')
          .all(branchId) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM candidates ORDER BY created_at').all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToCandidate(r));
  }

  private candidateBranch(id: string): string | undefined {
    const r = this.db.prepare('SELECT branch_id FROM candidates WHERE candidate_id=?').get(id) as
      | { branch_id?: string }
      | undefined;
    return r?.branch_id;
  }

  invalidateDependents(args: {
    refKind: string;
    refId: string;
    newVersion: string;
    reason: string;
    eventId: string;
    branchId: string;
  }): string[] {
    const affected = new Set<string>();
    const queue: string[] = [];
    const direct = this.db
      .prepare('SELECT DISTINCT derived_id FROM dependencies WHERE ref_kind=? AND ref_id=?')
      .all(args.refKind, args.refId) as { derived_id: string }[];
    for (const d of direct) queue.push(d.derived_id);
    while (queue.length) {
      const id = queue.shift()!;
      if (affected.has(id)) continue;
      affected.add(id);
      const next = this.db
        .prepare("SELECT DISTINCT derived_id FROM dependencies WHERE ref_kind='candidate' AND ref_id=?")
        .all(id) as { derived_id: string }[];
      for (const n of next) if (!affected.has(n.derived_id)) queue.push(n.derived_id);
    }
    for (const id of affected) {
      // 已采纳/锁定不被悄悄替换：仅标记 stale，旧结论继续可读。
      this.db.prepare('UPDATE candidates SET valid=0, stale_reason=? WHERE candidate_id=?').run(args.reason, id);
      this.db
        .prepare(
          `INSERT INTO invalidations(derived_id,source_ref_kind,source_ref_id,source_old_version,source_new_version,reason,event_id,created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(id, args.refKind, args.refId, 'prior', args.newVersion, args.reason, args.eventId, this.now());
      this.appendEvent({
        type: 'dependency.invalidated',
        branchId: this.candidateBranch(id) ?? args.branchId,
        basisVersion: this.currentRulesVersion(),
        createdBy: 'system',
        payload: { derivedId: id, reason: args.reason, refKind: args.refKind, refId: args.refId },
      });
    }
    return [...affected];
  }

  listInvalidations() {
    return (this.db.prepare('SELECT * FROM invalidations ORDER BY rowid').all() as Record<string, unknown>[]).map(
      (r) => ({
        derivedId: r.derived_id,
        sourceRefKind: r.source_ref_kind,
        sourceRefId: r.source_ref_id,
        reason: r.reason,
        eventId: r.event_id,
      })
    );
  }

  addDependency(derivedId: string, dep: DependencyRef): void {
    this.tx(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO dependencies(derived_id,ref_kind,ref_id,ref_version) VALUES (?,?,?,?)')
        .run(derivedId, dep.refKind, dep.refId, dep.refVersion);
    });
  }

  savePreparedCandidate(c: RegistrationCandidate, dependencies: DependencyRef[]): RegistrationCandidate {
    return this.tx(() => {
      const existing = this.db.prepare('SELECT candidate_id FROM candidates WHERE candidate_id=?').get(c.id);
      const event = this.appendEvent({
        type: 'candidate.computed',
        branchId: c.branchId,
        basisVersion: c.basisRuleVersion,
        createdBy: 'engine',
        payload: {
          candidateId: c.id,
          method: c.method,
          rmsePx: c.rmsePx,
          diagnoses: c.diagnoses,
          effectivePointKey: c.effectivePointKey,
          effectiveFrameIds: c.effectiveFrameIds,
          axis: c.axis,
          illegal: c.diagnoses.includes('FEW_FRAMES_RESIDUAL_GAMBIT'),
        },
      });
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO candidates(candidate_id,branch_id,method,basis_rule_version,axis_json,transforms_json,
               per_frame_json,effective_frame_ids,effective_point_key,rmse_px,holdout_rmse_px,dof,
               diagnoses_json,status,ambiguity_group_id,dependencies_json,valid,stale_reason,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,?)`
          )
          .run(
            c.id, c.branchId, c.method, c.basisRuleVersion, JSON.stringify(c.axis), JSON.stringify(c.frameTransforms),
            JSON.stringify(c.perFrame), JSON.stringify(c.effectiveFrameIds), c.effectivePointKey,
            c.rmsePx, c.holdoutRmsePx ?? null, c.dof, JSON.stringify(c.diagnoses), c.status,
            c.ambiguityGroupId ?? null, JSON.stringify(dependencies), event.createdAt
          );
        for (const dep of dependencies) {
          this.db
            .prepare('INSERT OR IGNORE INTO dependencies(derived_id,ref_kind,ref_id,ref_version) VALUES (?,?,?,?)')
            .run(c.id, dep.refKind, dep.refId, dep.refVersion);
        }
      }
      return this.getCandidate(c.id)!;
    });
  }


  // ---------- 复核裁定 / 锁定 / 撤销 ----------
  decide(args: {
    branchId: string;
    candidateId: string;
    action: ReviewDecision['action'];
    note: string;
    reviewer: string;
    expectedRevision: number;
  }): { decision: ReviewDecision; event: DomainEvent } {
    const branch = this.getBranch(args.branchId);
    if (!branch) throw err('NO_BRANCH', args.branchId);
    if (branch.revision !== args.expectedRevision) {
      const otherEvents = this.branchDelta(args.branchId, args.expectedRevision);
      const ev = this.appendEvent({
        type: 'conflict.detected',
        branchId: args.branchId,
        basisVersion: this.currentRulesVersion(),
        createdBy: args.reviewer,
        payload: {
          expectedRevision: args.expectedRevision,
          actualRevision: branch.revision,
          otherEvents,
          attempted: { candidateId: args.candidateId, action: args.action },
        },
      });
      throw err('BRANCH_REVISION_CONFLICT', `版本冲突：期望 revision ${args.expectedRevision}，当前 ${branch.revision}`, {
        conflictEventId: ev.eventId,
        actualRevision: branch.revision,
        otherEvents,
      });
    }
    return this.tx(() => {
      if (!this.db.prepare('SELECT candidate_id FROM candidates WHERE candidate_id=?').get(args.candidateId))
        throw err('NO_CANDIDATE', args.candidateId);
      const id = stableId('dec', {
        branchId: args.branchId,
        candidateId: args.candidateId,
        action: args.action,
        t: this.now(),
      });
      const event = this.appendEvent({
        type: 'review.decided',
        branchId: args.branchId,
        basisVersion: this.currentRulesVersion(),
        createdBy: args.reviewer,
        payload: { decisionId: id, candidateId: args.candidateId, action: args.action, note: args.note },
      });
      this.db
        .prepare(
          `INSERT INTO decisions(decision_id,branch_id,candidate_id,action,note,reviewer,event_id,active,created_at)
           VALUES (?,?,?,?,?,?,?,1,?)`
        )
        .run(id, args.branchId, args.candidateId, args.action, args.note, args.reviewer, event.eventId, event.createdAt);
      if (args.action === 'accept')
        this.db.prepare("UPDATE candidates SET status='adopted' WHERE candidate_id=?").run(args.candidateId);
      if (args.action === 'reject')
        this.db.prepare("UPDATE candidates SET status='rejected' WHERE candidate_id=?").run(args.candidateId);
      return {
        decision: {
          id,
          branchId: args.branchId,
          candidateId: args.candidateId,
          action: args.action,
          note: args.note,
          reviewer: args.reviewer,
          eventId: event.eventId,
          active: true,
          createdAt: event.createdAt,
        },
        event,
      };
    });
  }

  private branchDelta(branchId: string, fromRevision: number) {
    return this.listEvents(branchId)
      .filter((e) => e.seq > fromRevision)
      .map((e) => ({ eventId: e.eventId, type: e.type, payload: e.payload }));
  }

  undoDecision(decisionId: string, reviewer: string): { event: DomainEvent } {
    return this.tx(() => {
      const r = this.db.prepare('SELECT * FROM decisions WHERE decision_id=?').get(decisionId) as
        | Record<string, unknown>
        | undefined;
      if (!r) throw err('NO_DECISION', decisionId);
      const event = this.appendEvent({
        type: 'decision.undone',
        branchId: r.branch_id as string,
        basisVersion: this.currentRulesVersion(),
        createdBy: reviewer,
        payload: { decisionId, priorAction: r.action, candidateId: r.candidate_id },
      });
      this.db.prepare('UPDATE decisions SET active=0, undone_by_event_id=? WHERE decision_id=?').run(event.eventId, decisionId);
      this.db.prepare("UPDATE candidates SET status='valid' WHERE candidate_id=?").run(r.candidate_id as string);
      return { event };
    });
  }

  private rowToDecision(r: Record<string, unknown>): ReviewDecision {
    return {
      id: r.decision_id as string,
      branchId: r.branch_id as string,
      candidateId: r.candidate_id as string,
      action: r.action as ReviewDecision['action'],
      note: r.note as string,
      reviewer: r.reviewer as string,
      eventId: r.event_id as string,
      active: !!r.active,
      undoneByEventId: (r.undone_by_event_id as string) ?? undefined,
      createdAt: r.created_at as string,
    };
  }

  listDecisions(branchId?: string): ReviewDecision[] {
    const rows = branchId
      ? (this.db.prepare('SELECT * FROM decisions WHERE branch_id=? ORDER BY rowid').all(branchId) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM decisions ORDER BY rowid').all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToDecision(r));
  }

  lockRegistration(args: {
    branchId: string;
    candidateId: string;
    reviewer: string;
    expectedRevision: number;
  }): { lock: LockedRegistration; event: DomainEvent } {
    const branch = this.getBranch(args.branchId);
    if (!branch) throw err('NO_BRANCH', args.branchId);
    if (branch.revision !== args.expectedRevision)
      throw err('BRANCH_REVISION_CONFLICT', `版本冲突：当前 revision ${branch.revision}`, {
        actualRevision: branch.revision,
      });
    return this.tx(() => {
      const accepted = this.db
        .prepare("SELECT decision_id FROM decisions WHERE branch_id=? AND candidate_id=? AND action='accept' AND active=1")
        .get(args.branchId, args.candidateId);
      if (!accepted) throw err('NOT_ACCEPTED', '锁定前必须先接受该候选');
      const id = stableId('lock', { candidateId: args.candidateId, t: this.now() });
      const event = this.appendEvent({
        type: 'registration.locked',
        branchId: args.branchId,
        basisVersion: this.currentRulesVersion(),
        createdBy: args.reviewer,
        payload: { lockId: id, candidateId: args.candidateId },
      });
      this.db
        .prepare('INSERT INTO locks(lock_id,branch_id,candidate_id,event_id,active,created_at) VALUES (?,?,?,?,1,?)')
        .run(id, args.branchId, args.candidateId, event.eventId, event.createdAt);
      this.db.prepare("UPDATE candidates SET status='locked' WHERE candidate_id=?").run(args.candidateId);
      return {
        lock: {
          id,
          branchId: args.branchId,
          candidateId: args.candidateId,
          eventId: event.eventId,
          active: true,
          createdAt: event.createdAt,
        },
        event,
      };
    });
  }

  getActiveLock(branchId: string): LockedRegistration | undefined {
    const r = this.db
      .prepare('SELECT * FROM locks WHERE branch_id=? AND active=1 ORDER BY rowid DESC LIMIT 1')
      .get(branchId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.lock_id as string,
      branchId: r.branch_id as string,
      candidateId: r.candidate_id as string,
      eventId: r.event_id as string,
      active: true,
      createdAt: r.created_at as string,
    };
  }

  compareCandidates(ids: string[]): {
    sharedPointKey: string | null;
    sharedFrames: string[];
    results: { id: string; method: string; rmsePx: number; pointKey: string; nFrames: number; comparable: boolean }[];
    gambit: string[];
  } {
    const cands = ids.map((id) => this.getCandidate(id)!);
    if (cands.some((c) => !c)) throw err('NO_CANDIDATE', '某个候选不存在');
    const pointKeys = new Set(cands.map((c) => c.effectivePointKey));
    const sharedPointKey = pointKeys.size === 1 ? [...pointKeys][0] : null;
    const frameSets = cands.map((c) => new Set(c.effectiveFrameIds));
    const sharedFrames =
      frameSets.length === 0
        ? []
        : cands[0].effectiveFrameIds.filter((f) => frameSets.every((set) => set.has(f)));
    const maxFrames = Math.max(...cands.map((c) => c.effectiveFrameIds.length));
    const gambit: string[] = [];
    const results = cands.map((c) => {
      const fewer = c.effectiveFrameIds.length < maxFrames;
      const comparable = !!sharedPointKey && c.effectiveFrameIds.length === maxFrames;
      if (fewer) gambit.push(c.id);
      return {
        id: c.id,
        method: c.method,
        rmsePx: c.rmsePx,
        pointKey: c.effectivePointKey,
        nFrames: c.effectiveFrameIds.length,
        comparable,
      };
    });
    if (gambit.length) {
      this.appendEvent({
        type: 'candidate.compared',
        branchId: cands[0].branchId,
        basisVersion: this.currentRulesVersion(),
        createdBy: 'engine',
        payload: {
          rule: 'candidates_compared_on_identical_effective_point_set',
          gambit,
          sharedPointKey,
          rejectedReason: 'no_trading_frames_for_lower_residual',
        },
      });
    }
    return { sharedPointKey, sharedFrames, results, gambit };
  }


  // ---------- 反例档案 ----------
  saveArchiveCase(a: {
    diagKey: DiagnosisCode;
    kind: 'minimal' | 'composite';
    title: string;
    adopted: boolean;
    branchId: string;
    sharedBlobIds: string[];
    summary: string;
  }): string {
    return this.tx(() => {
      const id = stableId('arch', { diagKey: a.diagKey, kind: a.kind, branchId: a.branchId });
      this.db
        .prepare(
          `INSERT OR REPLACE INTO archive_cases(archive_id,diag_key,kind,title,adopted,branch_id,shared_blob_ids,summary,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(id, a.diagKey, a.kind, a.title, a.adopted ? 1 : 0, a.branchId, JSON.stringify(a.sharedBlobIds), a.summary, this.now());
      return id;
    });
  }

  listArchiveCases() {
    return (this.db.prepare('SELECT * FROM archive_cases ORDER BY diag_key,kind').all() as Record<string, unknown>[]).map(
      (r) => ({
        id: r.archive_id as string,
        diagKey: r.diag_key as DiagnosisCode,
        kind: r.kind as 'minimal' | 'composite',
        title: r.title as string,
        adopted: !!r.adopted,
        branchId: r.branch_id as string,
        sharedBlobIds: JSON.parse(r.shared_blob_ids as string) as string[],
        summary: r.summary as string,
      })
    );
  }

  linkCounterexample(c: {
    diagKey: DiagnosisCode;
    minimalBranchId: string;
    compositeBranchId: string;
    sharedBlobIds: string[];
  }): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO counterexamples(diag_key,minimal_branch_id,composite_branch_id,shared_blob_ids)
           VALUES (?,?,?,?)`
        )
        .run(c.diagKey, c.minimalBranchId, c.compositeBranchId, JSON.stringify(c.sharedBlobIds));
    });
  }

  listCounterexamples() {
    return (this.db.prepare('SELECT * FROM counterexamples').all() as Record<string, unknown>[]).map((r) => ({
      diagKey: r.diag_key as DiagnosisCode,
      minimalBranchId: r.minimal_branch_id as string,
      compositeBranchId: r.composite_branch_id as string,
      sharedBlobIds: JSON.parse(r.shared_blob_ids as string) as string[],
    }));
  }

  // ---------- 损坏检测 ----------
  entityRefQuery(id: string): {
    id: string;
    kind: string;
    version: string;
    summary: string;
    refs: { kind: string; id: string; version: string; contentDigest: string }[];
  } {
    const entity = this.getEntityRow(id);
    if (entity) {
      const version = entity.current_version as number;
      const sv = this.getSourceVersion(entityVersionId(id, version));
      if (!sv) throw err(CORRUPTION_ERROR, `缺少来源版本：${id}#v${version}`);
      const refs = [
        { kind: 'event', id: sv.eventId, version: '1', contentDigest: sha256Short(sv.eventId) },
      ];
      if (sv.blobId) {
        if (!this.getBlob(sv.blobId))
          throw err(CORRUPTION_ERROR, `缺少引用的不可变原始字节：${sv.blobId}`, { entityId: id, missing: sv.blobId });
        refs.push({ kind: 'blob', id: sv.blobId, version: '1', contentDigest: sv.blobId.replace('blob_', '') });
      }
      return {
        id,
        kind: entity.kind as string,
        version: `v${version}`,
        summary: `${entity.label} @ v${version}`,
        refs,
      };
    }
    const candidate = this.getCandidate(id);
    if (candidate) {
      const deps = (this.db
        .prepare('SELECT * FROM dependencies WHERE derived_id=?')
        .all(id) as Record<string, unknown>[]).map((r) => {
        const refId = r.ref_id as string;
        const refVersion = r.ref_version as string;
        if (r.ref_kind === 'source_version' && !this.getSourceVersion(refVersion)) {
          this.recordCorruption(id, r.ref_kind as string, refId, refVersion);
          throw err(
            CORRUPTION_ERROR,
            `候选引用了缺失版本 ${refVersion}（不得退回最新版）`,
            { candidateId: id, missing: refId, version: refVersion }
          );
        }
        return {
          kind: r.ref_kind as string,
          id: refId,
          version: refVersion,
          contentDigest: sha256Short(`${refId}@${refVersion}`),
        };
      });
      return {
        id,
        kind: 'registration_candidate',
        version: candidate.basisRuleVersion,
        summary: `${candidate.method} rmse=${candidate.rmsePx.toFixed(3)}px [${candidate.status}]`,
        refs: deps,
      };
    }
    throw err('NOT_FOUND', `实体不存在：${id}`);
  }

  private recordCorruption(entityId: string, kind: string, refId: string, version: string) {
    const id = stableId('corr', { entityId, kind, refId, version });
    this.db
      .prepare(
        `INSERT OR IGNORE INTO corruption_reports(report_id,entity_id,missing_ref_kind,missing_ref_id,missing_ref_version,detected_at)
         VALUES (?,?,?,?,?,?)`
      )
      .run(id, entityId, kind, refId, version, this.now());
  }

  listCorruption() {
    return (this.db.prepare('SELECT * FROM corruption_reports').all() as Record<string, unknown>[]).map((r) => ({
      reportId: r.report_id,
      entityId: r.entity_id,
      missingRefKind: r.missing_ref_kind,
      missingRefId: r.missing_ref_id,
      missingRefVersion: r.missing_ref_version,
    }));
  }

  // ---------- 导入批次（失败整体回滚） ----------
  runImportBatch<T>(fn: () => T): T {
    const batchId = stableId('batch', { t: this.now(), r: Math.random() });
    this.db
      .prepare('INSERT INTO import_batches(batch_id,started_at,status,item_count) VALUES (?,?,?,0)')
      .run(batchId, this.now(), 'running');
    try {
      const out = this.tx(fn);
      this.db.prepare("UPDATE import_batches SET status='committed', finished_at=? WHERE batch_id=?").run(this.now(), batchId);
      return out;
    } catch (e) {
      this.db
        .prepare("UPDATE import_batches SET status='rolled_back', finished_at=?, error=? WHERE batch_id=?")
        .run('rolled_back', this.now(), (e as Error).message, batchId);
      throw e;
    }
  }

  listBatches() {
    return (this.db.prepare('SELECT * FROM import_batches ORDER BY rowid').all() as Record<string, unknown>[]).map((r) => ({
      batchId: r.batch_id,
      status: r.status,
      error: r.error,
      itemCount: r.item_count,
    }));
  }

  isEmpty(): boolean {
    const e = this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
    return e.c === 0;
  }


}
