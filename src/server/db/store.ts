import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema";
import { contentId, bytesId, stableStringify, sha256Hex, shortDigest } from "../../shared/ids";
import type {
  ConflictRecord,
  DecisionEvent,
  DecisionKind,
  DossierEntry,
  EntityEnvelope,
  IngestCommit,
  LockedRegistration,
  RegistrationCandidate,
  RegistrationParameters,
  RuleVersion,
  InterpretationBranch,
} from "../../shared/types";

export class StoreError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const ENTITY_KINDS = new Set([
  "RawFrame", "TiltAngle", "PixelScale", "FrameDose",
  "FiducialObservation", "TrackGap", "ManualFrameExclusion",
]);

export interface BundleExport {
  format: "tilt-review-archive/v1";
  exportedAt: string;
  tables: Record<string, unknown[]>;
  blobObjects: { id: string; kind: string; bytesDigest: string; dataBase64: string }[];
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  /** 事务包装：任何失败都整体回滚，禁止留下半份记录。 */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  migrate() {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    let current = row?.user_version ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.tx(() => {
        for (const sql of migration.sql) this.db.exec(sql);
        this.db.exec(`PRAGMA user_version=${migration.version}`);
        migration.verify?.(this.db);
      });
      current = migration.version;
    }
  }

  userVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  // ---------- 来源层：内容寻址、不可变 ----------

  putObject(kind: string, content: Record<string, unknown>, seqHint?: number): string {
    if (!ENTITY_KINDS.has(kind)) throw new StoreError("UNKNOWN_KIND", `未知来源实体类型 ${kind}`);
    const id = (content as { id?: string }).id ?? contentId(kindToPrefix(kind), content);
    const digest = sha256Hex(stableStringify(content));
    const existing = this.db.prepare("SELECT content_digest FROM objects WHERE id=?").get(id) as
      | { content_digest: string }
      | undefined;
    if (existing) {
      if (existing.content_digest !== digest) {
        throw new StoreError("CONTENT_ID_COLLISION", `稳定身份 ${id} 对应了不同内容`);
      }
      return id;
    }
    const seq = seqHint ?? (this.db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM objects").get() as { n: number }).n;
    this.db
      .prepare("INSERT INTO objects(id,kind,content_json,content_digest,created_seq) VALUES(?,?,?,?,?)")
      .run(id, kind, stableStringify(content), digest, seq);
    return id;
  }

  putBlob(kind: string, data: Uint8Array, rawFileName: string, width: number, height: number): string {
    const bytesDigest = sha256Hex(data);
    const id = bytesId("frame", data);
    const exists = this.db.prepare("SELECT id FROM blob_objects WHERE id=?").get(id);
    if (!exists) {
      this.db
        .prepare("INSERT INTO blob_objects(id,kind,data,bytes_digest,created_seq) VALUES(?,?,?,?,?)")
        .run(id, kind, Buffer.from(data), bytesDigest, Date.now());
    }
    const meta = { indexOrder: 0, width, height, bytesDigest, encoding: "uint8-raw", rawFileName };
    this.putObject("RawFrame", { ...meta, id });
    return id;
  }

  getBlob(id: string): Uint8Array | null {
    const row = this.db.prepare("SELECT data FROM blob_objects WHERE id=?").get(id) as { data: Uint8Array } | undefined;
    return row ? new Uint8Copy(row.data) : null;
  }

  getObject(id: string): EntityEnvelope | null {
    const row = this.db.prepare("SELECT kind,content_json,content_digest FROM objects WHERE id=?").get(id) as
      | { kind: string; content_json: string; content_digest: string }
      | undefined;
    if (!row) return null;
    const content = JSON.parse(row.content_json);
    return {
      id,
      kind: row.kind,
      versionDigest: row.content_digest,
      content,
      summary: summarize(row.kind, content),
      refs: collectRefs(content),
    };
  }

  listByKind(kind: string): EntityEnvelope[] {
    const rows = this.db
      .prepare("SELECT id FROM objects WHERE kind=? ORDER BY created_seq")
      .all(kind) as { id: string }[];
    return rows.map((r) => this.getObject(r.id)!).filter(Boolean);
  }

  createCommit(input: {
    rationale: string;
    parentCommitId?: string | null;
    materialVersion: string;
    entityIds: string[];
    importedAt: string;
    seqHint?: number;
    idHint?: string;
  }): IngestCommit {
    const seq = input.seqHint
      ?? (this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM ingest_commits").get() as { n: number }).n;
    const commitBase = {
      indexOrder: seq,
      materialVersion: input.materialVersion,
      parentCommitId: input.parentCommitId ?? null,
      rationale: input.rationale,
      importedAt: input.importedAt,
      entityIds: input.entityIds,
    };
    const id = input.idHint ?? contentId("commit", commitBase);
    this.db
      .prepare(
        "INSERT INTO ingest_commits(id,seq,material_version,parent_commit_id,rationale,imported_at,entity_ids_json) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        seq,
        commitBase.materialVersion,
        commitBase.parentCommitId,
        commitBase.rationale,
        commitBase.importedAt,
        stableStringify(commitBase.entityIds),
      );
    return { id, ...commitBase };
  }

  listCommits(): IngestCommit[] {
    return (this.db.prepare("SELECT * FROM ingest_commits ORDER BY seq").all() as DbCommit[]).map(rowToCommit);
  }

  // ---------- 规则版本（参数修订） ----------

  putRuleVersion(input: { version: string; parameters: RegistrationParameters; note: string; createdAt: string }): RuleVersion {
    const id = contentId("rule", { version: input.version, parameters: input.parameters });
    const exists = this.db.prepare("SELECT id FROM rule_versions WHERE id=?").get(id);
    if (!exists) {
      this.db
        .prepare("INSERT INTO rule_versions(id,version,params_json,note,created_at) VALUES(?,?,?,?,?)")
        .run(id, input.version, stableStringify(input.parameters), input.note, input.createdAt);
    }
    return { id, ...input };
  }

  getRuleVersion(id: string): RuleVersion | null {
    const row = this.db.prepare("SELECT * FROM rule_versions WHERE id=?").get(id) as DbRule | undefined;
    return row
      ? { id: row.id, version: row.version, parameters: JSON.parse(row.params_json), note: row.note, createdAt: row.created_at }
      : null;
  }

  listRuleVersions(): RuleVersion[] {
    return (this.db.prepare("SELECT * FROM rule_versions ORDER BY created_at,id").all() as DbRule[]).map((r) => ({
      id: r.id,
      version: r.version,
      parameters: JSON.parse(r.params_json),
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  // ---------- 分支（对同一份材料重新解释时新建分支） ----------

  createBranch(input: {
    name: string;
    commitId: string;
    ruleVersionId: string;
    createdAt: string;
  }): InterpretationBranch {
    const id = contentId("branch", {
      name: input.name,
      commitId: input.commitId,
      ruleVersionId: input.ruleVersionId,
      createdAt: input.createdAt,
    });
    this.db
      .prepare(
        "INSERT INTO branches(id,name,commit_id,rule_version_id,head_event_id,superseded_by,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, input.name, input.commitId, input.ruleVersionId, null, null, input.createdAt);
    return {
      id,
      name: input.name,
      commitId: input.commitId,
      ruleVersionId: input.ruleVersionId,
      headEventId: null,
      supersededBy: null,
      createdAt: input.createdAt,
    };
  }

  markBranchSuperseded(branchId: string, byBranchId: string) {
    this.db.prepare("UPDATE branches SET superseded_by=? WHERE id=?").run(byBranchId, branchId);
  }

  listBranches(): InterpretationBranch[] {
    return (this.db.prepare("SELECT * FROM branches ORDER BY created_at,id").all() as DbBranch[]).map(rowToBranch);
  }

  getBranch(id: string): InterpretationBranch | null {
    const row = this.db.prepare("SELECT * FROM branches WHERE id=?").get(id) as DbBranch | undefined;
    return row ? rowToBranch(row) : null;
  }
}

// ---------- 事件链（接受/否定/参数调整都生成新事件，永不覆盖历史） ----------

export interface AppendEventArgs {
  branchId: string;
  kind: DecisionKind;
  actor: string;
  summary: string;
  refs?: Record<string, string | string[]>;
  payload?: Record<string, unknown>;
  dependencies?: { dependsOn: string; scope: "global" | "local"; localityKey?: string | null }[];
  expectedHeadEventId?: string | null;
  at: string;
  seqHint?: number;
  idHint?: string;
}

declare module "./store" {}

export interface AppendSuccess {
  status: "appended";
  event: DecisionEvent;
}
export interface AppendConflict {
  status: "conflict";
  conflictId: string;
  expectedHeadEventId: string;
  actualHeadEventId: string;
}

export class StoreWrite extends Store {
  appendEvent(args: AppendEventArgs): AppendSuccess | AppendConflict {
    const branch = this.db.prepare("SELECT * FROM branches WHERE id=?").get(args.branchId) as DbBranch | undefined;
    if (!branch) throw new StoreError("BRANCH_NOT_FOUND", `分支 ${args.branchId} 不存在`);
    const currentHead = branch.head_event_id ?? null;
    if (
      args.expectedHeadEventId !== undefined &&
      (args.expectedHeadEventId ?? null) !== currentHead
    ) {
      // 并发冻结：后提交者不允许覆盖，冲突双方差异被显式记录。
      const conflict = this.recordConflict({
        branchId: args.branchId,
        at: args.at,
        expectedHeadEventId: args.expectedHeadEventId ?? null,
        actualHeadEventId: currentHead ?? "",
        submittedSummary: args.summary,
        actorA: args.actor,
        incoming: args.payload ?? {},
        baseHead: args.expectedHeadEventId ?? null,
      });
      return {
        status: "conflict",
        conflictId: conflict.id,
        expectedHeadEventId: currentHead ?? "",
        actualHeadEventId: currentHead ?? "",
      };
    }
    const seq =
      args.seqHint ??
      ((this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE branch_id=?").get(args.branchId) as {
        n: number;
      }).n);
    const dependencySnapshot: Record<string, string> = {};
    for (const dep of args.dependencies ?? []) {
      const digest = this.digestOf(dep.dependsOn);
      if (!digest) throw new StoreError("DANGLING_DEPENDENCY", `依赖实体 ${dep.dependsOn} 不存在`);
      dependencySnapshot[dep.dependsOn] = digest;
    }
    const eventBase = {
      branchId: args.branchId,
      seq,
      kind: args.kind,
      prevEventId: currentHead,
      at: args.at,
      actor: args.actor,
      summary: args.summary,
      refs: args.refs ?? {},
      payload: args.payload ?? {},
      dependencySnapshot,
    };
    const id = args.idHint ?? contentId("evt", eventBase);
    const event: DecisionEvent = { id, ...eventBase };

    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO events(id,branch_id,seq,kind,prev_event_id,at,actor,summary,refs_json,payload_json,dependency_snapshot_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          event.id,
          event.branchId,
          event.seq,
          event.kind,
          event.prevEventId,
          event.at,
          event.actor,
          event.summary,
          stableStringify(event.refs),
          stableStringify(event.payload),
          stableStringify(event.dependencySnapshot),
        );
      this.db.prepare("UPDATE branches SET head_event_id=? WHERE id=?").run(event.id, args.branchId);
      for (const dep of args.dependencies ?? []) {
        this.db
          .prepare(
            "INSERT INTO dependencies(branch_id,event_id,depends_on,depends_on_digest,scope,locality_key) VALUES(?,?,?,?,?,?)",
          )
          .run(
            args.branchId,
            event.id,
            dep.dependsOn,
            dependencySnapshot[dep.dependsOn],
            dep.scope,
            dep.localityKey ?? null,
          );
      }
      this.applyEventSideEffects(event);
    });
    return { status: "appended", event };
  }

  private applyEventSideEffects(event: DecisionEvent) {
    if (event.kind === "registration-locked") {
      const candidateId = String(event.refs.candidateId);
      const ref = String(event.payload.forReconstructionRef ?? `recon@${event.id}`);
      this.db
        .prepare(
          "INSERT INTO locks(id,branch_id,candidate_id,event_id,for_reconstruction_ref,revoked,locked_at) VALUES(?,?,?,?,?,0,?)",
        )
        .run(`lock_${shortDigest(event.id)}`, event.branchId, candidateId, event.id, ref, event.at);
    }
    if (event.kind === "lock-revoked") {
      this.db.prepare("UPDATE locks SET revoked=1 WHERE branch_id=? AND revoked=0").run(event.branchId);
    }
    if (event.kind === "conflict-frozen") {
      // 冲突事实本身可作为事件记录（人工显式登记时）
    }
  }

  recordConflict(input: {
    branchId: string;
    at: string;
    expectedHeadEventId: string | null;
    actualHeadEventId: string;
    submittedSummary: string;
    actorA: string;
    incoming: Record<string, unknown>;
    baseHead: string | null;
  }): ConflictRecord {
    const headEvent = this.db.prepare("SELECT * FROM events WHERE id=?").get(input.actualHeadEventId) as
      | DbEvent
      | undefined;
    const id = `conflict_${sha256Hex(stableStringify({ ...input, nonce: input.at })).slice(0, 16)}`;
    const incomingDigest = sha256Hex(stableStringify(input.incoming));
    const baseDigest = input.baseHead ? this.digestOf(input.baseHead) ?? input.baseHead : "ROOT";
    const headDigest = this.digestOf(input.actualHeadEventId) ?? input.actualHeadEventId;
    this.db
      .prepare(
        `INSERT INTO conflicts(id,branch_id,at,expected_head_event_id,submitted_summary,actual_head_event_id,
           incoming_digest,base_digest,head_digest,actor_a,actor_b,resolved,resolution_event_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,0,NULL)`,
      )
      .run(
        id,
        input.branchId,
        input.at,
        input.expectedHeadEventId,
        input.submittedSummary,
        input.actualHeadEventId,
        incomingDigest,
        baseDigest,
        headDigest,
        input.actorA,
        headEvent?.actor ?? "other-reviewer",
      );
    return {
      id,
      branchId: input.branchId,
      at: input.at,
      expectedHeadEventId: input.expectedHeadEventId,
      submittedSummary: input.submittedSummary,
      actualHeadEventId: input.actualHeadEventId,
      incomingDigest,
      baseDigest,
      headDigest,
      actors: [input.actorA, headEvent?.actor ?? "other-reviewer"],
      resolved: false,
      resolutionEventId: null,
    };
  }

  resolveConflict(conflictId: string, resolutionEventId: string) {
    this.db.prepare("UPDATE conflicts SET resolved=1,resolution_event_id=? WHERE id=?").run(resolutionEventId, conflictId);
  }

  listEvents(branchId: string): DecisionEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE branch_id=? ORDER BY seq").all(branchId) as DbEvent[]).map(
      rowToEvent,
    );
  }

  getEvent(id: string): DecisionEvent | null {
    const row = this.db.prepare("SELECT * FROM events WHERE id=?").get(id) as DbEvent | undefined;
    return row ? rowToEvent(row) : null;
  }

  // ---------- 候选 ----------

  putCandidate(candidate: RegistrationCandidate, createdEventId: string) {
    this.db
      .prepare(
        `INSERT INTO candidates(id,branch_id,rule_version_id,label,model,comparison_group,point_set_digest,
           valid_frame_ids_json,identity_map_json,per_frame_json,rms_px,max_px,cv_rms_px,complexity_penalty,
           score,diagnostics_json,created_event_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        candidate.id,
        candidate.branchId,
        candidate.ruleVersionId,
        candidate.label,
        candidate.model,
        candidate.comparisonGroup,
        candidate.pointSetDigest,
        stableStringify(candidate.validFrameIds),
        stableStringify(candidate.identityMap),
        stableStringify(candidate.perFrame),
        candidate.rmsPx,
        candidate.maxPx,
        candidate.cvRmsPx,
        candidate.complexityPenalty,
        candidate.score,
        stableStringify(candidate.diagnostics),
        createdEventId,
      );
  }

  getCandidate(id: string): RegistrationCandidate | null {
    const row = this.db.prepare("SELECT * FROM candidates WHERE id=?").get(id) as DbCandidate | undefined;
    return row ? rowToCandidate(row) : null;
  }

  listCandidates(branchId?: string): RegistrationCandidate[] {
    const rows = (
      branchId
        ? (this.db.prepare("SELECT * FROM candidates WHERE branch_id=? ORDER BY id").all(branchId) as DbCandidate[])
        : (this.db.prepare("SELECT * FROM candidates ORDER BY id").all() as DbCandidate[])
    );
    return rows.map(rowToCandidate);
  }

  getLock(branchId: string): (LockedRegistration & { candidateId: string }) | null {
    const row = this.db.prepare("SELECT * FROM locks WHERE branch_id=? ORDER BY locked_at DESC LIMIT 1").get(branchId) as
      | DbLock
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      branchId: row.branch_id,
      candidateId: row.candidate_id,
      eventId: row.event_id,
      forReconstructionRef: row.for_reconstruction_ref,
      revoked: Boolean(row.revoked),
      lockedAt: row.locked_at,
    };
  }

  listConflicts(branchId?: string): ConflictRecord[] {
    const rows = (
      branchId
        ? (this.db.prepare("SELECT * FROM conflicts WHERE branch_id=? ORDER BY at").all(branchId) as DbConflict[])
        : (this.db.prepare("SELECT * FROM conflicts ORDER BY at").all() as DbConflict[])
    );
    return rows.map(rowToConflict);
  }

  // ---------- 反例档案 ----------

  putDossierEntry(entry: DossierEntry) {
    this.db
      .prepare("INSERT INTO dossier_entries(id,case_code,title,rule_statement,doc_json) VALUES(?,?,?,?,?)")
      .run(entry.id, entry.caseCode, entry.title, entry.ruleStatement, stableStringify(entry));
  }

  getDossierEntry(caseCode: string): DossierEntry | null {
    const row = this.db.prepare("SELECT doc_json FROM dossier_entries WHERE case_code=?").get(caseCode) as
      | { doc_json: string }
      | undefined;
    return row ? (JSON.parse(row.doc_json) as DossierEntry) : null;
  }

  listDossierEntries(): DossierEntry[] {
    return (this.db.prepare("SELECT doc_json FROM dossier_entries ORDER BY case_code").all() as { doc_json: string }[]).map(
      (r) => JSON.parse(r.doc_json) as DossierEntry,
    );
  }

  addDiagnosis(entityId: string, code: string, message: string, atField: string) {
    this.db
      .prepare("INSERT INTO diagnoses(entity_id,code,message,at_field) VALUES(?,?,?,?)")
      .run(entityId, code, message, atField);
  }

  listDiagnoses(entityId?: string) {
    const rows = (
      entityId
        ? (this.db.prepare("SELECT entity_id,code,message,at_field FROM diagnoses WHERE entity_id=?").all(entityId) as DbDiag[])
        : (this.db.prepare("SELECT entity_id,code,message,at_field FROM diagnoses").all() as DbDiag[])
    );
    return rows.map((r) => ({ entityId: r.entity_id, code: r.code, message: r.message, atField: r.at_field }));
  }

  // ---------- 依赖与失效范围 ----------

  invalidationFor(entityId: string, versionDigest: string): {
    affectedEvents: { branchId: string; eventId: string; scope: string; localityKey: string | null }[];
  } {
    const rows = this.db
      .prepare(
        `SELECT d.branch_id AS branchId, d.event_id AS eventId, d.scope AS scope, d.locality_key AS localityKey
         FROM dependencies d
         WHERE d.depends_on=? AND d.depends_on_digest<>?`,
      )
      .all(entityId, versionDigest) as { branchId: string; eventId: string; scope: string; localityKey: string | null }[];
    return { affectedEvents: rows };
  }

  digestOf(id: string): string | null {
    const obj = this.db.prepare("SELECT content_digest AS d FROM objects WHERE id=?").get(id) as { d: string } | undefined;
    if (obj) return obj.d;
    const evt = this.db.prepare("SELECT id FROM events WHERE id=?").get(id);
    if (evt) return shortDigest(id);
    const rule = this.db.prepare("SELECT id FROM rule_versions WHERE id=?").get(id);
    if (rule) return shortDigest(id);
    const commit = this.db.prepare("SELECT id FROM ingest_commits WHERE id=?").get(id);
    if (commit) return shortDigest(id);
    return null;
  }
}

// ---------- 导出入：整库 JSON 包；删除本地数据库后重新导入，身份/顺序/来源关系必须保持 ----------

class Uint8Copy extends Uint8Array {}

export class ArchiveStore extends StoreWrite {
  exportBundle(): BundleExport {
    const tables: Record<string, unknown[]> = {};
    for (const table of [
      "meta", "objects", "ingest_commits", "rule_versions", "branches", "events",
      "dependencies", "candidates", "locks", "conflicts", "dossier_entries", "diagnoses",
    ]) {
      tables[table] = (this.db.prepare(`SELECT * FROM ${table}`).all() as unknown[]).map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
          out[k] = v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v;
        }
        return out;
      });
    }
    const blobObjects = (
      this.db.prepare("SELECT id,kind,data,bytes_digest FROM blob_objects").all() as {
        id: string; kind: string; data: Uint8Array; bytes_digest: string;
      }[]
    ).map((b) => ({
      id: b.id,
      kind: b.kind,
      bytesDigest: b.bytes_digest,
      dataBase64: Buffer.from(b.data).toString("base64"),
    }));
    return {
      format: "tilt-review-archive/v1",
      exportedAt: new Date().toISOString(),
      tables,
      blobObjects,
    };
  }

  importBundle(bundle: BundleExport, opts: { intoFresh: true }): Record<string, number> {
    if (!opts.intoFresh) throw new StoreError("IMPORT_NOT_FRESH", "导入只允许进入空库，避免半份记录与身份冲突");
    if (bundle.format !== "tilt-review-archive/v1") {
      throw new StoreError("BAD_BUNDLE_FORMAT", `不支持的档案格式 ${bundle.format}`);
    }
    const count = this.db.prepare("SELECT (SELECT COUNT(*) FROM objects) + (SELECT COUNT(*) FROM events) AS n").get() as {
      n: number;
    };
    if (count.n > 0) throw new StoreError("IMPORT_NOT_FRESH", "目标数据库非空；导入失败回滚，不覆盖既有记录");
    const imported: Record<string, number> = {};
    try {
    this.tx(() => {
      for (const [table, rows] of Object.entries(bundle.tables)) {
        for (const row of rows as Record<string, unknown>[]) {
          const cols = Object.keys(row);
          const placeholders = cols.map(() => "?").join(",");
          const values = cols.map((c) => {
            const v = row[c];
            if (table === "objects" && (c === "content_json" || c === "content_digest")) return v;
            return typeof v === "string" && /_json$/.test(c) ? v : v;
          });
          this.db.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${placeholders})`).run(...(values as (string|number|null)[]));
        }
        imported[table] = rows.length;
      }
      for (const b of bundle.blobObjects) {
        this.db
          .prepare("INSERT INTO blob_objects(id,kind,data,bytes_digest,created_seq) VALUES(?,?,?,?,?)")
          .run(b.id, "RawFrameBytes", Buffer.from(b.dataBase64, "base64"), b.bytesDigest, 0);
      }
      this.verifyChainIntegrity();
    });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      throw new StoreError("IMPORT_ROLLED_BACK", `导入失败，本次变更已整体回滚：${(err as Error).message}`);
    }
    return imported;
  }

  /** 来源链完整性：缺少引用必须报损坏，不能退回当前最新版。 */
  verifyChainIntegrity(): void {
    const events = this.db.prepare("SELECT * FROM events ORDER BY branch_id,seq").all() as DbEvent[];
    const byBranch = new Map<string, DbEvent[]>();
    for (const e of events) {
      const list = byBranch.get(e.branch_id) ?? [];
      list.push(e);
      byBranch.set(e.branch_id, list);
    }
    for (const [branchId, list] of byBranch) {
      let prev: string | null = null;
      for (const e of list) {
        if ((e.prev_event_id ?? null) !== prev) {
          throw new StoreError("EVENT_CHAIN_BROKEN", `分支 ${branchId} 事件链在 seq=${e.seq} 断裂`);
        }
        prev = e.id;
      }
    }
    const referencedIds = new Set<string>();
    for (const e of events) {
      for (const v of Object.values(JSON.parse(e.refs_json) as Record<string, string | string[]>)) {
        for (const id of Array.isArray(v) ? v : [v]) referencedIds.add(id);
      }
      for (const id of Object.keys(JSON.parse(e.dependency_snapshot_json) as Record<string, string>)) {
        referencedIds.add(id);
      }
    }
    for (const id of referencedIds) {
      if (!this.digestOf(id)) {
        throw new StoreError("CORRUPT_REFERENCE", `事件引用的实体 ${id} 缺失；档案已损坏，禁止回退到最新版`);
      }
    }
  }
}

// ---------- 行映射与摘要 ----------

type DbCommit = {
  id: string; seq: number; material_version: string; parent_commit_id: string | null;
  rationale: string; imported_at: string; entity_ids_json: string;
};
type DbRule = { id: string; version: string; params_json: string; note: string; created_at: string };
type DbBranch = {
  id: string; name: string; commit_id: string; rule_version_id: string;
  head_event_id: string | null; superseded_by: string | null; created_at: string;
};
type DbEvent = {
  id: string; branch_id: string; seq: number; kind: DecisionKind; prev_event_id: string | null;
  at: string; actor: string; summary: string; refs_json: string; payload_json: string;
  dependency_snapshot_json: string;
};
type DbCandidate = Record<string, unknown>;
type DbLock = {
  id: string; branch_id: string; candidate_id: string; event_id: string;
  for_reconstruction_ref: string; revoked: number; locked_at: string;
};
type DbConflict = {
  id: string; branch_id: string; at: string; expected_head_event_id: string;
  submitted_summary: string; actual_head_event_id: string; incoming_digest: string;
  base_digest: string; head_digest: string; actor_a: string; actor_b: string;
  resolved: number; resolution_event_id: string | null;
};
type DbDiag = { entity_id: string; code: string; message: string; at_field: string };

function rowToCommit(r: DbCommit): IngestCommit {
  return {
    id: r.id,
    indexOrder: r.seq,
    materialVersion: r.material_version,
    parentCommitId: r.parent_commit_id,
    rationale: r.rationale,
    importedAt: r.imported_at,
    entityIds: JSON.parse(r.entity_ids_json),
  };
}
function rowToBranch(r: DbBranch): InterpretationBranch {
  return {
    id: r.id,
    name: r.name,
    commitId: r.commit_id,
    ruleVersionId: r.rule_version_id,
    headEventId: r.head_event_id,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
  };
}
function rowToEvent(r: DbEvent): DecisionEvent {
  return {
    id: r.id,
    branchId: r.branch_id,
    seq: r.seq,
    kind: r.kind,
    prevEventId: r.prev_event_id,
    at: r.at,
    actor: r.actor,
    summary: r.summary,
    refs: JSON.parse(r.refs_json),
    payload: JSON.parse(r.payload_json),
    dependencySnapshot: JSON.parse(r.dependency_snapshot_json),
  };
}
function rowToCandidate(r: DbCandidate): RegistrationCandidate {
  return {
    id: String(r.id),
    branchId: String(r.branch_id),
    ruleVersionId: String(r.rule_version_id),
    label: String(r.label),
    model: String(r.model) as RegistrationCandidate["model"],
    validFrameIds: JSON.parse(String(r.valid_frame_ids_json)),
    pointSetDigest: String(r.point_set_digest),
    identityMap: JSON.parse(String(r.identity_map_json)),
    perFrame: JSON.parse(String(r.per_frame_json)),
    rmsPx: Number(r.rms_px),
    maxPx: Number(r.max_px),
    cvRmsPx: r.cv_rms_px === null ? null : Number(r.cv_rms_px),
    complexityPenalty: Number(r.complexity_penalty),
    score: Number(r.score),
    diagnostics: JSON.parse(String(r.diagnostics_json)),
    comparisonGroup: String(r.comparison_group),
  };
}
function rowToConflict(r: DbConflict): ConflictRecord {
  return {
    id: r.id,
    branchId: r.branch_id,
    at: r.at,
    expectedHeadEventId: r.expected_head_event_id,
    submittedSummary: r.submitted_summary,
    actualHeadEventId: r.actual_head_event_id,
    incomingDigest: r.incoming_digest,
    baseDigest: r.base_digest,
    headDigest: r.head_digest,
    actors: [r.actor_a, r.actor_b],
    resolved: Boolean(r.resolved),
    resolutionEventId: r.resolution_event_id,
  };
}

function kindToPrefix(kind: string): string {
  const map: Record<string, string> = {
    RawFrame: "frame",
    TiltAngle: "tilt",
    PixelScale: "pxscale",
    FrameDose: "dose",
    FiducialObservation: "fid",
    TrackGap: "gap",
    ManualFrameExclusion: "excl",
  };
  return map[kind] ?? "obj";
}

function summarize(kind: string, content: Record<string, unknown>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(content)) {
    if (["string", "number", "boolean"].includes(typeof v) || v === null) out[k] = (v as string | number | null) ?? null;
    else if (k === "angle" || k === "scale" || k === "dose") {
      const q = v as { value: number | null; unit: string; raw: string };
      out[`${k}.raw`] = q.raw;
      out[`${k}.unit`] = q.unit;
      out[`${k}.value`] = q.value;
    }
  }
  out._kind = kind;
  return out;
}

function collectRefs(content: Record<string, unknown>): Record<string, string | string[]> {
  const refs: Record<string, string | string[]> = {};
  if (typeof content.frameId === "string") refs.frameId = content.frameId;
  if (Array.isArray(content.missingFrameIds)) refs.missingFrameIds = content.missingFrameIds as string[];
  return refs;
}
