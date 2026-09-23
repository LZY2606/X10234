import type {
  Adjudication,
  CandidateDiagnostic,
  EntityView,
  Lock,
  RegistrationCandidate,
  Branch
} from "../shared/types";
import type { Store } from "./store";
import { SERIES_ID } from "../shared/ids";

/** 组装审阅页所需的分支完整状态：当前实体、候选、事件、锁定、诊断。 */
export function buildSeriesView(
  store: Store,
  branch: string,
  asOfSeq?: number
): {
  seriesId: string;
  branchId: string;
  headSeq: number;
  branchHeadSeq: number;
  events: ReturnType<Store["visibleEvents"]>;
  branches: Branch[];
  entities: EntityView[];
  candidates: (RegistrationCandidate & { entityId: string; version: number; invalidated?: { reason: string; dependencyKey: string; atSeq: number }; adjudication?: { version: number; value: Adjudication } })[];
  activeLock?: Lock;
  diagnostics: CandidateDiagnostic[];
  integrity: { status: "ok" | "corrupted"; corrupted: EntityView[] };
} {
  const mat = store.branchState(branch, asOfSeq);
  const entities = Object.values(mat.current);
  const branchViews = store.listBranches();
  const branches = entities.filter((e) => e.kind === "branch").map((e) => e.doc as Branch);
  for (const b of branchViews) {
    if (!branches.some((x) => x.branchId === b.branchId)) {
      const v = store.latestVersion(`branch:${b.branchId.replace(/^branch:/, "")}`);
      if (v) {
        const view = store.getEntityVersion(`branch:${b.branchId.replace(/^branch:/, "")}`, v);
        if (view) branches.push(view.doc as Branch);
      }
    }
  }

  const candidates = entities
    .filter((e) => e.kind === "registrationCandidate")
    .map((e) => {
      const doc = e.doc as RegistrationCandidate;
      const adjView = entities.find((x) => x.kind === "adjudication" && (x.doc as Adjudication).candidateId === e.entityId);
      return {
        ...doc,
        entityId: e.entityId,
        version: e.version,
        invalidated: mat.invalidated.get(e.entityId),
        adjudication: adjView ? { version: adjView.version, value: adjView.doc as Adjudication } : undefined
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));

  const lockViews = entities.filter((e) => e.kind === "lock").map((e) => e.doc as Lock);
  const activeLock = [...lockViews].reverse().find((l) => l.active && l.branchId === branch);

  const diagnostics = candidates.flatMap((c) => c.diagnostics);
  const corrupted = entities.filter((e) => e.integrity === "corrupted");

  return {
    seriesId: SERIES_ID,
    branchId: branch,
    headSeq: store.headSeq(),
    branchHeadSeq: store.branchHeadSeq(branch),
    events: mat.events,
    branches,
    entities,
    candidates,
    activeLock,
    diagnostics,
    integrity: { status: corrupted.length ? "corrupted" : "ok", corrupted }
  };
}
