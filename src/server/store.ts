import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AlignmentCandidateBody,
  BranchRecord,
  DiagnosticRow,
  EventRecord,
  ReviewBundle,
  SourceVersionRow,
} from "../shared/types.ts";

export class ConflictError extends Error {
  status = 409;
  code: string;
  theirs: unknown;
  yours: unknown;
  conflictEventId?: string;
  constructor(code: string, message: string, theirs: unknown, yours: unknown) {
    super(message);
    this.code = code;
    this.theirs = theirs;
    this.yours = yours;
  }
}

export class CorruptionError extends Error {
  status = 409;
  code = "CORRUPT_DANGLING_REFERENCE";
  constructor(message: string) {
    super(message);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentHashOf(value: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex");
}

interface ReplayState {
  sources: Map<string, SourceVersionRow>;
  candidates: Map<string, AlignmentCandidateBody>;
  activeAdjudication: { candidateId: string; kind: string; eventId: string } | null;
  diagnostics: DiagnosticRow[];
  events: EventRecord[];
  locked: boolean;
}

function newState(): ReplayState {
  return {
    sources: new Map(),
    candidates: new Map(),
    activeAdjudication: null,
    diagnostics: [],
    events: [],
    locked: false,
  };
}

export class Store {
  constructor(private db: DatabaseSync) {}

  now(): string {
    return new Date().toISOString();
  }

  // ---------- 分支 ----------

  listBranches(): BranchRecord[] {
    return this.db
      .prepare("SELECT * FROM branches ORDER BY created_at")
      .all() as unknown as BranchRecord[];
  }

  getBranch(branchId: string): BranchRecord | null {
    return (
      (this.db
        .prepare("SELECT * FROM branches WHERE branch_id = ?")
        .get(branchId) as unknown as BranchRecord) ?? null
    );
  }

  requireBranch(branchId: string): BranchRecord {
    const b = this.getBranch(branchId);
    if (!b) throw new CorruptionError(`unknown-branch:${branchId}`);
    return b;
  }

  createBranch(input: {
    branchId: string;
    name: string;
    parentBranchId?: string | null;
    forkHeadEventId?: string | null;
    actor: string;
  }): BranchRecord {
    const exists = this.getBranch(input.branchId);
    if (exists) return exists;
    this.db
      .prepare(
        `INSERT INTO branches(branch_id, name, parent_branch_id, head_event_id, base_version, created_at)
         VALUES (?, ?, ?, NULL, 0, ?)`,
      )
      .run(input.branchId, input.name, input.parentBranchId ?? null, this.now());
    this.appendEvent({
      branchId: input.branchId,
      type: "interpretation_created",
      actor: input.actor,
      payload: {
        branchId: input.branchId,
        name: input.name,
        parentBranchId: input.parentBranchId ?? null,
        forkHeadEventId: input.forkHeadEventId ?? null,
      },
      dependencyRefs: input.forkHeadEventId ? [input.forkHeadEventId] : [],
    });
    return this.requireBranch(input.branchId);
  }

  // ---------- 事件提交（乐观并发） ----------

  appendEvent(input: {
    branchId: string;
    type: EventRecord["type"];
    scenario?: EventRecord["scenario"];
    actor: string;
    payload: Record<string, unknown>;
    dependencyRefs?: string[];
    expectedBaseVersion?: number;
  }): EventRecord {
    const branch = this.requireBranch(input.branchId);
    const state = this.replayState(input.branchId, null);
    const kind = (input.payload as { kind?: string }).kind;
    const isUnlock = input.type === "adjudication" && kind === "undone";
    if (state.locked && !isUnlock) {
      throw new ConflictError(
        "BRANCH_FROZEN_LOCKED_FOR_RECONSTRUCTION",
        `branch ${input.branchId} locked for reconstruction; undo the lock first`,
        { headEventId: branch.headEventId, baseVersion: branch.baseVersion },
        { attempted: input.type },
      );
    }
    if (
      input.expectedBaseVersion !== undefined &&
      input.expectedBaseVersion !== branch.baseVersion
    ) {
      const currentHead = this.headSummary(input.branchId);
      const conflict = this.insertEvent({
        branchId: input.branchId,
        type: "conflict_detected",
        scenario: "concurrent_freeze",
        actor: input.actor,
        payload: {
          expectedBaseVersion: input.expectedBaseVersion,
          actualBaseVersion: branch.baseVersion,
          attempted: { type: input.type, payload: input.payload, actor: input.actor },
          currentHead,
        },
        dependencyRefs: branch.headEventId ? [branch.headEventId] : [],
      });
      const err = new ConflictError(
        "VERSION_CONFLICT",
        `baseVersion ${input.expectedBaseVersion} != ${branch.baseVersion}`,
        currentHead,
        { type: input.type, payload: input.payload, actor: input.actor },
      );
      err.conflictEventId = conflict.eventId;
      throw err;
    }
    return this.insertEvent({
      branchId: input.branchId,
      type: input.type,
      scenario: input.scenario,
      actor: input.actor,
      payload: input.payload,
      dependencyRefs: input.dependencyRefs ?? [],
    });
  }

  private headSummary(branchId: string): unknown {
    const state = this.replayState(branchId, null);
    const head = state.events[state.events.length - 1] ?? null;
    if (!head) return null;
    return {
      eventId: head.eventId,
      seq: head.seq,
      type: head.type,
      actor: head.actor,
      summary: summarizePayload(head),
    };
  }

  private insertEvent(input: {
    branchId: string;
    type: EventRecord["type"];
    scenario?: EventRecord["scenario"];
    actor: string;
    payload: Record<string, unknown>;
    dependencyRefs: string[];
  }): EventRecord {
    const seq = (
      this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM events WHERE branch_id = ?")
        .get(input.branchId) as { s: number }
    ).s;
    const eventId = `EV-${input.branchId}-${String(seq).padStart(3, "0")}`;

    for (const ref of input.dependencyRefs) this.assertReferenceResolves(ref);

    const snapshot = this.computeViewSnapshot(input.branchId, input);
    const record: EventRecord = {
      eventId,
      branchId: input.branchId,
      seq,
      type: input.type,
      scenario: input.scenario,
      actor: input.actor,
      payload: input.payload,
      dependencyRefs: input.dependencyRefs,
      viewSnapshot: snapshot,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO events(event_id, branch_id, seq, type, scenario, actor, payload, dependency_refs, view_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.eventId,
        record.branchId,
        record.seq,
        record.type,
        record.scenario ?? null,
        record.actor,
        canonicalJson(record.payload),
        canonicalJson(record.dependencyRefs),
        canonicalJson(record.viewSnapshot),
        record.createdAt,
      );
    for (const ref of input.dependencyRefs) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO dependency_edges(from_event_id, branch_id, to_ref) VALUES (?, ?, ?)",
        )
        .run(eventId, input.branchId, ref);
    }
    this.db
      .prepare("UPDATE branches SET head_event_id = ?, base_version = ? WHERE branch_id = ?")
      .run(eventId, seq, input.branchId);
    return record;
  }

  // ---------- 引用完整性：缺引用必须报损坏，不能退回最新版 ----------

  assertReferenceResolves(ref: string): void {
    if (ref.startsWith("EV-")) {
      const row = this.db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(ref);
      if (!row) throw new CorruptionError(`dangling-event-reference:${ref}`);
      return;
    }
    const at = ref.lastIndexOf("@");
    if (at < 0) throw new CorruptionError(`malformed-reference:${ref}`);
    const entityId = ref.slice(0, at);
    const versionNo = Number(ref.slice(at + 1));
    const row = this.db
      .prepare("SELECT 1 FROM source_versions WHERE entity_id = ? AND version_no = ?")
      .get(entityId, versionNo);
    if (!row) throw new CorruptionError(`dangling-source-reference:${ref}`);
  }

  // ---------- 源版本提交 ----------

  commitSourceVersion(input: {
    branchId: string;
    entityId: string;
    kind: SourceVersionRow["kind"];
    content: unknown;
    rawRepresentation?: string | null;
    units?: string | null;
    coordFrame?: string | null;
    actor: string;
    expectedBaseVersion?: number;
    scenario?: EventRecord["scenario"];
    replaces?: string | null;
  }): { row: SourceVersionRow; event: EventRecord } {
    const nextVersion =
      ((
        this.db
          .prepare(
            "SELECT COALESCE(MAX(version_no), 0) + 1 AS v FROM source_versions WHERE entity_id = ?",
          )
          .get(input.entityId) as { v: number } | undefined
      )?.v ?? 1);
    const hash = contentHashOf(input.content);
    this.db
      .prepare("INSERT OR IGNORE INTO content_blobs(content_hash, kind, content) VALUES (?, ?, ?)")
      .run(hash, input.kind, canonicalJson(input.content));
    const event = this.appendEvent({
      branchId: input.branchId,
      type: "source_version_committed",
      scenario: input.scenario,
      actor: input.actor,
      expectedBaseVersion: input.expectedBaseVersion,
      dependencyRefs: input.replaces ? [input.replaces] : [],
      payload: {
        entityId: input.entityId,
        versionNo: nextVersion,
        kind: input.kind,
        contentHash: hash,
        contentSummary: summarizeContent(input.content),
        units: input.units ?? null,
        coordFrame: input.coordFrame ?? null,
        rawRepresentation: input.rawRepresentation ?? null,
        replaces: input.replaces ?? null,
      },
    });
    const row: SourceVersionRow = {
      entityId: input.entityId,
      versionNo: nextVersion,
      kind: input.kind,
      contentHash: hash,
      content: input.content,
      rawRepresentation: input.rawRepresentation ?? null,
      units: input.units ?? null,
      coordFrame: input.coordFrame ?? null,
      branchId: input.branchId,
      commitEventId: event.eventId,
      createdAt: event.createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO source_versions(entity_id, version_no, kind, content_hash, content, raw_representation, units, coord_frame, branch_id, commit_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.entityId,
        row.versionNo,
        row.kind,
        row.contentHash,
        canonicalJson(row.content),
        row.rawRepresentation,
        row.units,
        row.coordFrame,
        row.branchId,
        row.commitEventId,
        row.createdAt,
      );
    return { row, event };
  }

  addDiagnostic(input: {
    branchId: string;
    entityRef: string;
    severity: DiagnosticRow["severity"];
    message: string;
    rawValue?: string | null;
    actor?: string;
  }): DiagnosticRow {
    const id = `DG-${randomUUID().slice(0, 8)}`;
    const row: DiagnosticRow = {
      diagnosticId: id,
      entityRef: input.entityRef,
      severity: input.severity,
      message: input.message,
      rawValue: input.rawValue ?? null,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO diagnostics(diagnostic_id, entity_ref, severity, message, raw_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.diagnosticId, row.entityRef, row.severity, row.message, row.rawValue, row.createdAt);
    this.insertEvent({
      branchId: input.branchId,
      type: "diagnostic_raised",
      actor: input.actor ?? "system",
      payload: { ...row },
      dependencyRefs: input.entityRef.includes("@") ? [input.entityRef] : [],
    });
    return row;
  }
