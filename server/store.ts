import type { DatabaseSync } from "node:sqlite";
import {
  type AlignmentCandidate,
  type ArchiveFile,
  type Adjudication,
  type DomainEvent,
  type EntityEnvelope,
  type EntityKind,
  type EventCode,
  type ReconstructionLock,
  type BranchState,
  CorruptionError,
  VersionConflictError,
  CURRENT_RULESET_VERSION,
} from "../shared/domain.js";
import { newId, nowIso, sha256, structuralDiff } from "./util.js";

interface EntityRow {
  entity_id: string;
  version: number;
  kind: EntityKind;
  digest: string;
  branch_id: string;
  created_at: string;
  body_json: string;
  derived_from_ruleset: string | null;
}

interface RefRow {
  ref_entity_id: string;
  ref_version: number;
  ref_digest: string;
  role: string;
}

export interface EntityRefInput {
  entityId: string;
  version: number;
  digest: string;
  role: string;
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  /* ---------- 不可变原始片段（内容寻址，同一片片段只存一份） ---------- */

  putFragment(bytes: Buffer, mediaType: string): string {
    const digest = sha256(bytes);
    const existing = this.db
      .prepare(`SELECT digest FROM fragments WHERE digest = ?`)
      .get(digest);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO fragments (digest, media_type, byte_length, bytes) VALUES (?, ?, ?, ?)`
        )
        .run(digest, mediaType, bytes.length, bytes);
    }
    return digest;
  }

  getFragment(digest: string): { bytes: Buffer; mediaType: string } {
    const row = this.db
      .prepare(`SELECT bytes, media_type FROM fragments WHERE digest = ?`)
      .get(digest) as { bytes: Buffer; mediaType: string } | undefined;
    if (!row) throw new CorruptionError([{ entityId: digest }], `缺少内容片段 ${digest}`);
    return { bytes: Buffer.from(row.bytes), mediaType: row.media_type };
  }

  /* ---------- 分支 ---------- */

  createBranch(label: string, materialId: string, materialVersion: number): BranchState {
    const branch: BranchState = {
      branchId: newId("br"),
      label,
      materialId,
      materialVersion,
      headEventId: null,
      createdAt: nowIso(),
      status: "active",
    };
    this.db
      .prepare(
        `INSERT INTO branches (branch_id, label, material_id, material_version, head_event_id, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        branch.branchId, branch.label, branch.materialId, branch.materialVersion,
        null, branch.createdAt, branch.status
      );
    return branch;
  }

  getBranch(branchId: string): BranchState {
    const row = this.db
      .prepare(`SELECT * FROM branches WHERE branch_id = ?`)
      .get(branchId) as
      | { branch_id: string; label: string; material_id: string; material_version: number; head_event_id: string | null; created_at: string; status: BranchState["status"] }
      | undefined;
    if (!row) throw new CorruptionError([{ entityId: branchId }], `缺少分支 ${branchId}`);
    return {
      branchId: row.branch_id,
      label: row.label,
      materialId: row.material_id,
      materialVersion: row.material_version,
      headEventId: row.head_event_id,
      createdAt: row.created_at,
      status: row.status,
    };
  }

  listBranches(): BranchState[] {
    const rows = this.db.prepare(`SELECT * FROM branches ORDER BY created_at`).all() as Array<{
      branch_id: string; label: string; material_id: string; material_version: number;
      head_event_id: string | null; created_at: string; status: BranchState["status"];
    }>;
    return rows.map((row) => ({
      branchId: row.branch_id, label: row.label, materialId: row.material_id,
      materialVersion: row.material_version, headEventId: row.head_event_id,
      createdAt: row.created_at, status: row.status,
    }));
  }

  setBranchStatus(branchId: string, status: BranchState["status"]): void {
    this.db.prepare(`UPDATE branches SET status = ? WHERE branch_id = ?`).run(status, branchId);
  }

  /* ---------- 版本化实体（append-only，永不就地覆盖） ---------- */

  nextEntityVersion(entityId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(version) AS v FROM entities WHERE entity_id = ?`)
      .get(entityId) as { v: number | null };
    return (row.v ?? 0) + 1;
  }

  latestEntityVersion(entityId: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(version) AS v FROM entities WHERE entity_id = ?`)
      .get(entityId) as { v: number | null };
    return row.v ?? null;
  }

  /**
   * 写入一个实体新版本。引用必须显式指向具体版本+摘要；
   * 这里不校验引用存在性（导入档案时需要能先写入再整体校验），
   * 读取实体时强制校验，缺引用一律报损坏，不退回最新版。
   */
  putEntity<T>(args: {
    entityId: string;
    kind: EntityKind;
    body: T;
    branchId: string;
    refs?: EntityRefInput[];
    derivedFromRuleSetVersion?: string;
    createdAt?: string;
  }): EntityEnvelope<T> {
    const version = this.nextEntityVersion(args.entityId);
    const bodyJson = JSON.stringify(args.body);
    const digest = sha256(bodyJson);
    const createdAt = args.createdAt ?? nowIso();
    const rule = args.derivedFromRuleSetVersion ?? null;
    this.db
      .prepare(
        `INSERT INTO entities (entity_id, version, kind, digest, branch_id, created_at, body_json, derived_from_ruleset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(args.entityId, version, args.kind, digest, args.branchId, createdAt, bodyJson, rule);
    for (const ref of args.refs ?? []) {
      this.db
        .prepare(
          `INSERT INTO entity_refs (owner_entity_id, owner_version, ref_entity_id, ref_version, ref_digest, role)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(args.entityId, version, ref.entityId, ref.version, ref.digest, ref.role);
    }
    return {
      entityId: args.entityId,
      kind: args.kind,
      version,
      digest,
      createdAt,
      branchId: args.branchId,
      body: args.body,
      refs: (args.refs ?? []).map((ref) => ({
        entityId: ref.entityId, version: ref.version, digest: ref.digest, role: ref.role,
      })),
      derivedFromRuleSetVersion: args.derivedFromRuleSetVersion,
    };
  }

  /** 读取指定版本实体；version 缺省必须显式调用 latest。历史引用绝不回落到最新。 */
  getEntity<T = unknown>(entityId: string, version: number): EntityEnvelope<T> {
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE entity_id = ? AND version = ?`)
      .get(entityId, version) as EntityRow | undefined;
    if (!row) {
      throw new CorruptionError(
        [{ entityId, version }],
        `实体 ${entityId}@${version} 缺失：缺少引用必须报损坏，不能退回当前最新版`
      );
    }
    const refRows = this.db
      .prepare(
        `SELECT ref_entity_id, ref_version, ref_digest, role FROM entity_refs
         WHERE owner_entity_id = ? AND owner_version = ?`
      )
      .all(entityId, version) as RefRow[];
    const refs = refRows.map((ref) => ({
      entityId: ref.ref_entity_id, version: ref.ref_version,
      digest: ref.ref_digest, role: ref.role,
    }));
    // 校验每个引用的版本与摘要都存在且未漂移
    for (const ref of refs) {
      const target = this.db
        .prepare(`SELECT digest FROM entities WHERE entity_id = ? AND version = ?`)
        .get(ref.entityId, ref.version) as { digest: string } | undefined;
      if (!target) {
        throw new CorruptionError(
          [{ entityId: ref.entityId, version: ref.version }],
          `实体 ${entityId}@${version} 引用了缺失对象 ${ref.entityId}@${ref.version}`
        );
      }
      if (target.digest !== ref.digest) {
        throw new CorruptionError(
          [{ entityId: ref.entityId, version: ref.version }],
          `实体 ${entityId}@${version} 的引用 ${ref.entityId}@${ref.version} 内容摘要漂移`
        );
      }
    }
    return {
      entityId: row.entity_id,
      kind: row.kind,
      version: row.version,
      digest: row.digest,
      createdAt: row.created_at,
      branchId: row.branch_id,
      body: JSON.parse(row.body_json) as T,
      refs,
      derivedFromRuleSetVersion: row.derived_from_ruleset ?? undefined,
    };
  }

  getLatest<T = unknown>(entityId: string): EntityEnvelope<T> | null {
    const version = this.latestEntityVersion(entityId);
    return version === null ? null : this.getEntity<T>(entityId, version);
  }

  listEntities(kind?: EntityKind): Array<{ entityId: string; kind: EntityKind; versions: number[] }> {
    const rows = (kind
      ? this.db.prepare(`SELECT entity_id, kind, version FROM entities WHERE kind = ? ORDER BY entity_id, version`).all(kind)
      : this.db.prepare(`SELECT entity_id, kind, version FROM entities ORDER BY entity_id, version`).all()
    ) as Array<{ entity_id: string; kind: EntityKind; version: number }>;
    const map = new Map<string, { entityId: string; kind: EntityKind; versions: number[] }>();
    for (const row of rows) {
      const key = row.entity_id;
      if (!map.has(key)) map.set(key, { entityId: key, kind: row.kind, versions: [] });
      map.get(key)!.versions.push(row.version);
    }
    return [...map.values()];
  }

  /* ---------- 事件溯源（append-only，裁定/撤销/冲突全部落事件） ---------- */

  appendEvent(args: {
    branchId: string;
    code: EventCode;
    message: string;
    payload?: Record<string, unknown>;
    refs?: EntityRefInput[];
    baseHeadEventId?: string | null;
    parentEventId?: string | null;
    at?: string;
    seq?: number;
  }): DomainEvent {
    const seq =
      args.seq ??
      ((
        this.db
          .prepare(`SELECT MAX(seq) AS s FROM events WHERE branch_id = ?`)
          .get(args.branchId) as { s: number | null }
      ).s ?? 0) + 1;
    const event: DomainEvent = {
      eventId: args.seq !== undefined && args.at ? args.at ? args.at + `#${seq}` : "" : newId("evt"),
      seq,
      branchId: args.branchId,
      at: args.at ?? nowIso(),
      code: args.code,
      message: args.message,
      payload: args.payload ?? {},
      refs: (args.refs ?? []).map((ref) => ({
        entityId: ref.entityId, version: ref.version, digest: ref.digest,
      })),
      baseHeadEventId: args.baseHeadEventId ?? null,
    };
    const eventId = args.seq !== undefined && args.at ? `${args.branchId}:${seq}` : event.eventId;
    event.eventId = eventId;
    void event;
    return this.writeEventRow(event, args.parentEventId ?? null);
  }

  private writeEventRow(event: DomainEvent, parentEventId: string | null): DomainEvent {
    this.db
      .prepare(
        `INSERT INTO events (event_id, seq, branch_id, at, code, message, payload_json, refs_json, base_head_event_id, parent_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.eventId, event.seq, event.branchId, event.at, event.code, event.message,
        JSON.stringify(event.payload), JSON.stringify(event.refs), event.baseHeadEventId, parentEventId
      );
    this.db
      .prepare(`UPDATE branches SET head_event_id = ? WHERE branch_id = ?`)
      .run(event.eventId, event.branchId);
    return event;
  }

  listEvents(branchId?: string): DomainEvent[] {
    const rows = (branchId
      ? this.db.prepare(`SELECT * FROM events WHERE branch_id = ? ORDER BY seq`).all(branchId)
      : this.db.prepare(`SELECT * FROM events ORDER BY branch_id, seq`).all()
    ) as Array<{
      event_id: string; seq: number; branch_id: string; at: string; code: EventCode;
      message: string; payload_json: string; refs_json: string; base_head_event_id: string | null;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id, seq: row.seq, branchId: row.branch_id, at: row.at,
      code: row.code, message: row.message,
      payload: JSON.parse(row.payload_json), refs: JSON.parse(row.refs_json),
      baseHeadEventId: row.base_head_event_id,
    }));
  }

  /**
   * 乐观并发的裁定提交：两个窗口同时保存时，后提交者看到版本冲突及双方差异。
   */
  adjudicate(args: {
    branchId: string;
    decision: Adjudication["decision"];
    candidate: AlignmentCandidate;
    candidateEnvelope: EntityEnvelope<AlignmentCandidate>;
    author: string;
    note: string;
    baseHeadEventId: string | null;
    parentAdjudicationId?: string | null;
  }): { adjudication: EntityEnvelope<Adjudication>; event: DomainEvent } {
    const branch = this.getBranch(args.branchId);
    const clientDiff = {
      decision: args.decision,
      candidateId: args.candidate.candidateId,
      candidateVersion: args.candidateEnvelope.version,
      rmsResidualPx: args.candidate.rmsResidualPx,
    };
    if (branch.headEventId !== args.baseHeadEventId) {
      const serverEvent = this.db
        .prepare(`SELECT payload_json FROM events WHERE event_id = ?`)
        .get(branch.headEventId) as { payload_json: string } | undefined;
      const serverDiff = serverEvent ? JSON.parse(serverEvent.payload_json) : null;
      throw new VersionConflictError(
        branch.headEventId!,
        args.baseHeadEventId ?? "(empty)",
        structuralDiff(serverDiff, clientDiff),
        clientDiff
      );
    }
    const adjudication: Adjudication = {
      adjudicationId: newId("adj"),
      decision: args.decision,
      candidateId: args.candidate.candidateId,
      candidateVersion: args.candidateEnvelope.version,
      parentAdjudicationId: args.parentAdjudicationId ?? null,
      author: args.author,
      note: args.note,
      at: nowIso(),
      baseHeadEventId: args.baseHeadEventId,
    };
    const envelope = this.putEntity<Adjudication>({
      entityId: adjudication.adjudicationId,
      kind: "adjudication",
      body: adjudication,
      branchId: args.branchId,
      refs: [
        {
          entityId: args.candidateEnvelope.entityId,
          version: args.candidateEnvelope.version,
          digest: args.candidateEnvelope.digest,
          role: "decides_candidate",
        },
      ],
    });
    const event = this.writeEventRow(
      {
        eventId: `${args.branchId}:${(this.db.prepare(`SELECT MAX(seq) AS s FROM events WHERE branch_id = ?`).get(args.branchId) as { s: number | null }).s! + 1}`,
        seq: ((this.db.prepare(`SELECT MAX(seq) AS s FROM events WHERE branch_id = ?`).get(args.branchId) as { s: number | null }).s ?? 0) + 1,
        branchId: args.branchId,
        at: nowIso(),
        code: "ADJUDICATION_RECORDED",
        message: `${args.author} ${args.decision} 候选 ${args.candidate.candidateId}（${args.candidate.kind}）`,
        payload: { adjudicationId: adjudication.adjudicationId, ...clientDiff, note: args.note },
        refs: [
          {
            entityId: args.candidateEnvelope.entityId,
            version: args.candidateEnvelope.version,
            digest: args.candidateEnvelope.digest,
          },
        ],
        baseHeadEventId: args.baseHeadEventId,
      },
      args.parentAdjudicationId ?? null
    );
    return { adjudication: envelope, event };
  }
