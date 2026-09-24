import { openDatabase, runMigrations, currentSchemaVersion } from './db';
import { Store, type StoreError } from './store';
import { buildCandidates, buildDemoWorld } from './service';
import { baselineCase, compositeCase, minimalCases } from './cases';
import { pointSetFingerprint } from '../shared/identity';
import { observationsFromCase, DEFAULT_PARAMS } from './engine';
import type { CaseSpec } from './case-types';
import type { CandidateMethod, DiagnosisCode, RegistrationCandidate, TiltAxisModel } from '../shared/model';
import { resolve } from 'node:path';

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
export interface ApiResponse {
  status: number;
  data: unknown;
}
export interface ServerApi {
  handle(req: ApiRequest): Promise<ApiResponse>;
  store: Store;
  resetForTesting(filename?: string): void;
}

const DB_FILE = process.env.TILT_DB_FILE ?? resolve(process.cwd(), 'data/tilt-review.sqlite');

export function createServerApi(dbFile: string = DB_FILE): ServerApi {
  let db = openDatabase(dbFile);
  runMigrations(db);
  let store = new Store(db);
  if (store.isEmpty()) buildDemoWorld(store);

  const json = (data: unknown, status = 200): ApiResponse => ({ status, data });
  const fail = (code: string, message: string, details?: unknown, status = 409): ApiResponse => ({
    status,
    data: { error: true, code, message, details },
  });

  const specByBranchName = (): { spec: CaseSpec; key: string }[] => {
    const mins = minimalCases().map((m) => ({ spec: m.spec, key: m.key }));
    return [
      { spec: baselineCase(), key: 'BASELINE' },
      { spec: compositeCase(), key: 'COMPOSITE' },
      ...mins,
    ];
  };

  function specForBranch(branchId: string): { spec: CaseSpec; key: string } {
    const br = store.getBranch(branchId);
    const table = specByBranchName();
    const hit = table.find((t) => br?.name.includes(t.key));
    if (hit) return hit;
    return { spec: baselineCase(), key: 'BASELINE' };
  }

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const { path } = req;
    const b = (req.body ?? {}) as Record<string, unknown>;

    switch (true) {
      case path === '/api/state' && req.method === 'GET':
        return json(serializeState(store, currentSchemaVersion(db)));

      case path === '/api/reset' && req.method === 'POST':
        reset(b.dbFile as string | undefined);
        return json({ ok: true });

      case path === '/api/branch' && req.method === 'POST':
        return json(store.createBranch((b.name as string) ?? '新分支', b.parentBranchId as string | undefined));

      case path === '/api/recompute' && req.method === 'POST': {
        const branchId = b.branchId as string;
        const { spec } = specForBranch(branchId);
        const params = { ...DEFAULT_PARAMS, ...((b.params as object) ?? {}) };
        return json(buildCandidates(store, spec, branchId, params));
      }

      case path === '/api/params/revise' && req.method === 'POST': {
        const rulesVersion = (b.rulesVersion as string) ?? 'rules@v2';
        const out = store.reviseParameter(
          b.branchId as string,
          (b.key as string) ?? 'engine-params',
          b.value ?? {},
          rulesVersion,
          (b.reviewer as string) ?? 'reviewer',
          (b.note as string) ?? ''
        );
        return json(out);
      }

      case path === '/api/source/revise' && req.method === 'POST': {
        const out = store.reviseSourceVersion({
          branchId: b.branchId as string,
          entityId: b.entityId as string,
          kind: b.kind as never,
          quantity: b.quantity as never,
          createdBy: (b.reviewer as string) ?? 'reviewer',
          note: (b.note as string) ?? '局部源数据改动',
        });
        return json(out);
      }

      case path === '/api/decide' && req.method === 'POST':
        try {
          return json(
            store.decide({
              branchId: b.branchId as string,
              candidateId: b.candidateId as string,
              action: b.action as 'accept' | 'reject' | 'parameter_adjust',
              note: (b.note as string) ?? '',
              reviewer: (b.reviewer as string) ?? 'reviewer',
              expectedRevision: Number(b.expectedRevision),
            })
          );
        } catch (e) {
          const se = e as StoreError;
          if (se.code === 'BRANCH_REVISION_CONFLICT') return fail(se.code, se.message, se.details, 409);
          throw e;
        }

      case path === '/api/undo' && req.method === 'POST':
        return json(store.undoDecision(b.decisionId as string, (b.reviewer as string) ?? 'reviewer'));

      case path === '/api/lock' && req.method === 'POST':
        try {
          return json(
            store.lockRegistration({
              branchId: b.branchId as string,
              candidateId: b.candidateId as string,
              reviewer: (b.reviewer as string) ?? 'reviewer',
              expectedRevision: Number(b.expectedRevision),
            })
          );
        } catch (e) {
          const se = e as StoreError;
          if (se.code === 'BRANCH_REVISION_CONFLICT') return fail(se.code, se.message, se.details, 409);
          return fail(se.code, se.message, se.details, 400);
        }

      case path === '/api/compare' && req.method === 'POST':
        return json(store.compareCandidates(b.candidateIds as string[]));

      case path === '/api/gambit' && req.method === 'POST':
        return json(createIllegalGambit(b.branchId as string));

      case path === '/api/entity' && req.method === 'GET': {
        const id = req.query.get('id') ?? '';
        try {
          return json(store.entityRefQuery(id));
        } catch (e) {
          const se = e as StoreError;
          if (se.code === 'CORRUPTED_REFERENCE') return fail(se.code, se.message, se.details, 422);
          if (se.code === 'NOT_FOUND') return fail(se.code, se.message, undefined, 404);
          throw e;
        }
      }

      case path === '/api/history' && req.method === 'GET': {
        const branchId = req.query.get('branchId') ?? '';
        const at = req.query.get('atSeq');
        return json({ events: store.branchViewAt(branchId, at ? Number(atSeq(at)) : undefined) });
      }

      case path === '/api/blob' && req.method === 'GET': {
        const id = req.query.get('id') ?? '';
        const bytes = store.getBlob(id);
        if (!bytes) return fail('NOT_FOUND', `blob 不存在：${id}`, undefined, 404);
        return json({ blobId: id, bytesB64: bytes.toString('base64'), mediaType: 'image/x-portable-graymap' });
      }

      case path === '/api/export' && req.method === 'GET':
        return json(store.exportArchive(currentSchemaVersion(db)));

      case path === '/api/import' && req.method === 'POST': {
        // 删除本地库后再导入：在全新内存库校验，再整体替换活动库；任何失败都不替换。
        try {
          // 先在全新库中完整恢复，校验通过后才替换活动库；失败则活动库不变。
          const probeDb = openDatabase(':memory:');
          runMigrations(probeDb);
          new Store(probeDb).importArchive(b.body as never);
          db = openDatabase(':memory:');
          runMigrations(db);
          store = new Store(db);
          const out = store.importArchive(b.body as never);
          return json({ ok: true, ...out });
        } catch (e) {
          const se = e as StoreError;
          return fail(se.code ?? 'IMPORT_FAILED', se.message, undefined, 400);
        }
      }

      case path === '/api/corruption/probe' && req.method === 'POST':
        return json(probeCorruption());

      case path === '/api/corruption' && req.method === 'GET':
        return json(store.listCorruption());

      default:
        return fail('NOT_FOUND', `未知接口：${path}`, undefined, 404);
    }
  }

  function atSeq(v: string): number {
    return Number(v);
  }

  function createIllegalGambit(branchId: string) {
    const { spec } = specForBranch(branchId);
    const obs = observationsFromCase(spec).filter((o) => !o.missing && !o.excluded);
    const frameIds = [...new Set(obs.map((o) => o.frameId))];
    // 非法：未经任何手工排除，自行丢掉偶数帧，再声称残差极低。
    const kept = frameIds.filter((_, i) => i % 2 === 1);
    const rigid = store.listCandidates(branchId).find((c) => c.method === 'rigid');
    const key = pointSetFingerprint(obs.filter((o) => kept.includes(o.frameId)).map((o) => `${o.trackId}@${o.frameId}`));
    const axis: TiltAxisModel = rigid?.axis ?? {
      axisAngleDeg: 0,
      offsetPx: 0,
      centerRef: 'image_origin_top_left@frame0',
      fixedAtCenter: false,
    };
    const illegal: RegistrationCandidate = {
      id: `cand_illegal_gambit_${branchId.slice(-10)}`,
      branchId,
      method: 'rigid_excluded_frames',
      basisRuleVersion: rigid?.basisRuleVersion ?? 'rules@v1',
      axis,
      frameTransforms: {},
      perFrame: rigid?.perFrame.filter((p) => kept.includes(p.frameId)) ?? [],
      effectiveFrameIds: kept,
      effectivePointKey: key,
      rmsePx: 0.18,
      dof: rigid?.dof ?? 6,
      diagnoses: ['FEW_FRAMES_RESIDUAL_GAMBIT'] as DiagnosisCode[],
      status: 'valid',
      createdAt: new Date().toISOString(),
    };
    const saved = store.savePreparedCandidate(illegal, [
      { refKind: 'rule', refId: 'registration-rules', refVersion: rigid?.basisRuleVersion ?? 'rules@v1' },
    ]);
    const compare = store.compareCandidates(
      [rigid?.id, saved.id].filter(Boolean) as string[]
    );
    return { candidate: saved, compare, rule: 'candidates_compared_on_identical_effective_point_set' };
  }

  function probeCorruption() {
    const c = store.listCandidates()[0];
    if (!c) return { detected: false };
    store.addDependency(c.id, {
      refKind: 'source_version',
      refId: 'src_missing_demo',
      refVersion: 'src_missing_demo#v99',
    });
    try {
      store.entityRefQuery(c.id);
      return { detected: false };
    } catch (e) {
      return { detected: true, code: (e as StoreError).code, reports: store.listCorruption() };
    }
  }

  function reset(filename?: string) {
    db = openDatabase(filename ?? ':memory:');
    runMigrations(db);
    store = new Store(db);
    buildDemoWorld(store);
  }

  return {
    handle,
    get store() {
      return store;
    },
    resetForTesting(filename?: string) {
      reset(filename);
    },
  };
}


function serializeState(store: Store, schemaVersion: number) {
  return {
    schemaVersion,
    rulesVersion: store.currentRulesVersion(),
    branches: store.listBranches(),
    sources: store.listSourceEntities().map((e) => {
      let refs: unknown = null;
      try {
        refs = store.entityRefQuery(e.id);
      } catch {
        refs = { error: 'CORRUPTED_REFERENCE' };
      }
      return { ...e, refs };
    }),
    candidates: store.listCandidates().map((c) => ({
      id: c.id,
      branchId: c.branchId,
      method: c.method,
      axis: c.axis,
      rmsePx: c.rmsePx,
      holdoutRmsePx: c.holdoutRmsePx,
      dof: c.dof,
      status: c.status,
      diagnoses: c.diagnoses,
      effectiveFrameIds: c.effectiveFrameIds,
      effectivePointKey: c.effectivePointKey,
      perFrame: c.perFrame,
      ambiguityGroupId: c.ambiguityGroupId,
      basisRuleVersion: c.basisRuleVersion,
    })),
    decisions: store.listDecisions(),
    locks: store.listBranches().map((b) => ({ branchId: b.id, lock: store.getActiveLock(b.id) ?? null })),
    events: store.listEvents(),
    invalidations: store.listInvalidations(),
    archive: store.listArchiveCases(),
    counterexamples: store.listCounterexamples(),
    corruption: store.listCorruption(),
  };
}

export type { CandidateMethod };
