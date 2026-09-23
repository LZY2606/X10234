import type { Connect } from 'vite';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { ReviewService, VersionConflictError } from './service.js';
import { exportArchive, importArchive, type TransferBundle } from './transfer.js';
import { generateCaseBundle } from '../case/generate.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

async function readBody(req: Connect.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function createApiHandler(db: DatabaseSync) {
  const svc = new ReviewService(db);
  const ensure = (): { seriesId: string } => {
    const snap = svc.snapshot(generateCaseBundle().manifest.branches[0].branchId);
    return { seriesId: snap.seriesId as string };
  };

  return async (req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) return next();
    try {
      const p = url.pathname;
      if (p === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true });
      }

      if (p === '/api/case/bundle' && req.method === 'GET') {
        return json(res, 200, { bundle: generateCaseBundle() });
      }

      if (p === '/api/demo/load' && req.method === 'POST') {
        svc.resetDatabase();
        const r = svc.importCase(generateCaseBundle());
        return json(res, 200, r);
      }

      if (p === '/api/reset' && req.method === 'POST') {
        svc.resetDatabase();
        return json(res, 200, { reset: true });
      }

      if (p === '/api/state' && req.method === 'GET') {
        const branch = url.searchParams.get('branch') ?? generateCaseBundle().manifest.branches[0].branchId;
        const at = url.searchParams.get('at');
        try {
          const snap = at ? svc.atEvent(branch, Number(at)) : svc.snapshot(branch);
          return json(res, 200, snap);
        } catch (e) {
          return json(res, 404, { error: (e as Error).message });
        }
      }

      if (p === '/api/branches' && req.method === 'GET') {
        const { seriesId } = ensure();
        return json(res, 200, { branches: svc.store.listBranches(seriesId) });
      }

      if (p === '/api/blob' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        const row = id ? svc.blob(id) : undefined;
        if (!row) return json(res, 404, { error: 'not-found' });
        res.writeHead(200, { 'content-type': row.media_type, 'cache-control': 'immutable' });
        return res.end(row.bytes);
      }

      if (p === '/api/events' && req.method === 'GET') {
        const branch = url.searchParams.get('branch')!;
        return json(res, 200, { events: svc.events(branch) });
      }

      if (p === '/api/entity' && req.method === 'GET') {
        const branch = url.searchParams.get('branch')!;
        const id = url.searchParams.get('id')!;
        const at = url.searchParams.get('at');
        const result = svc.lookup(branch, id, at ? Number(at) : undefined);
        return json(res, result.corrupted ? 409 : 200, result);
      }

      if (p === '/api/adjudicate' && req.method === 'POST') {
        const b = await readBody(req);
        try {
          const r = svc.adjudicate(b.branchId, b.decision, b.candidateId, b.comment ?? '', b.decidedBy ?? 'reviewer', b.expectedHead);
          return json(res, 200, r);
        } catch (e) {
          if (e instanceof VersionConflictError) {
            return json(res, 409, {
              error: 'version-conflict',
              expectedHead: e.expectedHead,
              actualHead: e.actualHead,
              serverEvents: e.serverEvents.map((x) => ({ id: x.id, type: x.type, ordinal: x.ordinal, payload: x.payload })),
            });
          }
          throw e;
        }
      }

      if (p === '/api/undo' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { event: svc.undoDecision(b.branchId, b.adjudicationId, b.expectedHead ?? null) });
      }

      if (p === '/api/lock' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { lock: svc.lockForReconstruction(b.branchId, b.candidateId, b.lockedBy ?? 'reviewer', b.expectedHead) });
      }

      if (p === '/api/axis' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, svc.reviseAxis(b.branchId, b.originX, b.originY, b.angleDeg, b.expectedHead ?? null));
      }

      if (p === '/api/source' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, svc.reviseSourceValue(b.branchId, b.entityType, b.entityId, b.newValueRaw, b.expectedHead ?? null));
      }

      if (p === '/api/fork' && req.method === 'POST') {
        const b = await readBody(req);
        svc.fork(b.newBranchId, b.seriesId, b.name, b.parentBranchId);
        return json(res, 200, { forked: b.newBranchId });
      }

      if (p === '/api/export' && req.method === 'GET') {
        const { seriesId } = ensure();
        return json(res, 200, exportArchive(db, [seriesId]));
      }

      if (p === '/api/import-archive' && req.method === 'POST') {
        const bundle = (await readBody(req)) as TransferBundle;
        return json(res, 200, importArchive(db, bundle));
      }

      if (p === '/api/engine-input' && req.method === 'GET') {
        const branch = url.searchParams.get('branch')!;
        return json(res, 200, svc.buildEngineInput(branch));
      }

      return json(res, 404, { error: 'unknown-endpoint', path: p });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  };
}
