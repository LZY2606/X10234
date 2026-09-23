import type { Plugin } from 'vite';
import type { Application } from './bootstrap';
import { createApplication, ensureCaseInstalled, MAIN_BRANCH } from './bootstrap';
import { decideCandidate, undoDecision, lockForReconstruction, invalidateDependents } from './service-decisions';
import { OptimisticLockError } from './store';
import { CorruptionError } from '../domain/archive';
import { archiveToBundle, importArchive } from './archive-io';
import { loadCaseMaterials } from './service-case';
import { buildScenarioBranch } from './service-scenarios';
import { compareCandidates } from '../domain/rules';

let appPromise: Promise<Application> | null = null;

async function getApp(): Promise<Application> {
  if (!appPromise) {
    appPromise = createApplication('data/tilt-room.sqlite').then(async (app) => {
      await ensureCaseInstalled(app);
      return app;
    });
  }
  return appPromise;
}

function send(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readJson(request: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function tiltApiPlugin(): Plugin {
  return {
    name: 'tilt-room-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (!url.pathname.startsWith('/api/')) return next();
        try {
          const app = await getApp();
          const method = request.method ?? 'GET';
          const path = url.pathname;

          if (path === '/api/health' && method === 'GET') {
            return send(response, 200, { ok: true });
          }

          if (path === '/api/branches' && method === 'GET') {
            return send(response, 200, { branches: app.store.listBranches() });
          }

          if (path === '/api/state' && method === 'GET') {
            const branchId = url.searchParams.get('branch') ?? MAIN_BRANCH;
            const atSeqParam = url.searchParams.get('atSeq');
            const atSeq = atSeqParam ? Number(atSeqParam) : undefined;
            const state = app.service.state(branchId, atSeq);
            const headSeq = app.store.getBranch(branchId).headBranchSeq;
            const entities = [...state.headVersionByEntity.entries()]
              .map(([entityId, version]) => {
                const record = state.entities.get(entityId)!.get(version)!;
                const content = app.store.getContent(record.contentId);
                return {
                  entityId,
                  kind: record.kind,
                  version,
                  contentId: record.contentId,
                  eventSeq: record.eventSeq,
                  summary: content
                    ? `${record.kind} ${content.byteLength}B sha256:${content.sha256.slice(0, 16)}`
                    : null,
                  body: record.body
                };
              })
              .sort((a, b) => a.eventSeq - b.eventSeq);
            const ruleOutcomes = state.events
              .filter((event) => event.type === 'rule_outcome_recorded')
              .map((event) => (event.payload as { outcome: unknown }).outcome);
            return send(response, 200, {
              branchId,
              headSeq,
              atSeq: atSeq ?? headSeq,
              annotations: state.annotations,
              materialSets: state.materialSetRevisions,
              ruleOutcomes,
              locks: app.store.listLocks(),
              events: state.events.map((event) => ({
                eventId: event.eventId,
                seq: event.seq,
                type: event.type,
                author: event.author,
                createdAt: event.createdAt,
                payload: event.payload
              })),
              entities
            });
          }

          if (path === '/api/entity' && method === 'GET') {
            const branchId = url.searchParams.get('branch') ?? MAIN_BRANCH;
            const entityId = url.searchParams.get('entityId');
            if (!entityId) return send(response, 400, { error: '缺少 entityId' });
            const atSeqParam = url.searchParams.get('atSeq');
            const view = app.service.queryEntity(
              branchId,
              entityId,
              atSeqParam ? Number(atSeqParam) : undefined
            );
            return send(response, view.corruption ? 409 : 200, view);
          }

          if (path === '/api/frame' && method === 'GET') {
            const contentId = url.searchParams.get('blob');
            if (!contentId) return send(response, 400, { error: '缺少 blob' });
            const blob = app.store.getBlob(contentId);
            if (!blob) return send(response, 404, { error: '原始片段不存在' });
            response.statusCode = 200;
            response.setHeader('content-type', blob.contentType);
            return response.end(blob.bytes);
          }

          if (path === '/api/decision' && method === 'POST') {
            const body = await readJson(request);
            const result = decideCandidate(
              app.service,
              body.branchId ?? MAIN_BRANCH,
              body.candidateId,
              Boolean(body.accepted),
              String(body.reason ?? ''),
              Number(body.expectedHeadSeq)
            );
            return send(response, 200, result);
          }

          if (path === '/api/undo' && method === 'POST') {
            const body = await readJson(request);
            const result = undoDecision(
              app.service,
              body.branchId ?? MAIN_BRANCH,
              body.candidateId,
              Number(body.expectedHeadSeq)
            );
            return send(response, 200, result);
          }

          if (path === '/api/lock' && method === 'POST') {
            const body = await readJson(request);
            const result = lockForReconstruction(
              app.service,
              body.branchId ?? MAIN_BRANCH,
              body.candidateId,
              Number(body.expectedHeadSeq),
              body.handle
            );
            return send(response, 200, result);
          }

          if (path === '/api/recon' && method === 'GET') {
            const handle = url.searchParams.get('handle')!;
            const branchId = url.searchParams.get('branch') ?? MAIN_BRANCH;
            const resolved = app.service.resolveLock(handle, branchId);
            return send(response, 200, {
              handle,
              ref: resolved.ref,
              aggregateRmsPx: (resolved.record.body as { aggregateRmsPx: number })
                .aggregateRmsPx
            });
          }

          if (path === '/api/invalidate' && method === 'POST') {
            const body = await readJson(request);
            const result = invalidateDependents(
              app.service,
              body.branchId ?? MAIN_BRANCH,
              body.changedContentIds,
              String(body.note ?? ''),
              Number(body.expectedHeadSeq)
            );
            return send(response, 200, result);
          }

          if (path === '/api/compare' && method === 'POST') {
            const body = await readJson(request);
            const candidates = (body.candidateIds as string[]).map((candidateId) => {
              const state = app.service.state(body.branchId ?? MAIN_BRANCH);
              const version = state.headVersionByEntity.get(candidateId)!;
              return state.entities.get(candidateId)!.get(version)!.body as import('../domain/types').RegistrationCandidate;
            });
            return send(response, 200, compareCandidates(candidates));
          }

          if (path === '/api/archive/export' && method === 'GET') {
            const bundle = archiveToBundle(
              app.service,
              'tilt-room-case',
              '倾转帧拼合室反例档案',
              MAIN_BRANCH
            );
            return send(response, 200, bundle);
          }

          if (path === '/api/archive/import' && method === 'POST') {
            const body = await readJson(request);
            const blobs = new Map<string, Buffer>();
            for (const [contentId, base64] of Object.entries(
              body.blobs as Record<string, string>
            )) {
              blobs.set(contentId, Buffer.from(base64, 'base64'));
            }
            const result = importArchive(app.service, body.manifest, blobs);
            return send(response, 200, result);
          }

          if (path === '/api/reset' && method === 'POST') {
            // 删除本地数据库：关闭后由下一次请求重新安装。
            app.store.close();
            appPromise = null;
            await getApp();
            return send(response, 200, { reset: true });
          }

          if (path === '/api/scenario/rebuild' && method === 'POST') {
            const body = await readJson(request);
            const { materials } = await loadCaseMaterials(app.caseRoot);
            const result = buildScenarioBranch(
              app.service,
              MAIN_BRANCH,
              materials,
              body.scenario
            );
            return send(response, 200, {
              branchId: result.branchId,
              candidates: result.candidates.map((candidate) => ({
                candidateId: candidate.candidateId,
                status: candidate.status
              }))
            });
          }

          return send(response, 404, { error: `未知 API ${method} ${path}` });
        } catch (error) {
          if (error instanceof OptimisticLockError) {
            const app2 = await getApp();
            return send(response, 409, {
              error: error.message,
              type: 'VERSION_CONFLICT',
              branchId: error.branchId,
              expectedSeq: error.expectedSeq,
              actualSeq: error.actualSeq,
              serverEvents: app2.store
                .events(error.branchId)
                .slice(error.expectedSeq)
                .map((event) => ({
                  eventId: event.eventId,
                  type: event.type,
                  author: event.author,
                  payload: event.payload
                }))
            });
          }
          if (error instanceof CorruptionError) {
            return send(response, 422, {
              error: error.message,
              type: 'CORRUPTION',
              code: error.code,
              detail: error.detail
            });
          }
          console.error(error);
          return send(response, 500, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
  };
}
