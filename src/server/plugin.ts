import type { Plugin } from 'vite';
import { createServerApi, type ServerApi } from './api';
import { SCHEMA_VERSION } from './schema';

export function createApiPlugin(): Plugin {
  let api: ServerApi | undefined;
  return {
    name: 'tilt-review-api',
    configureServer(server) {
      api = createServerApi();
      server.middlewares.use(async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (!url.pathname.startsWith('/api/')) return;
          const body = await readBody(req);
          const result = await api!.handle({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body });
          res.statusCode = result.status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(result.data));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      // 暴露便于测试
      (server as unknown as { tiltApi?: ServerApi }).tiltApi = api;
      void SCHEMA_VERSION;
    },
    configurePreviewServer(server) {
      const a = createServerApi();
      server.middlewares.use(async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (!url.pathname.startsWith('/api/')) return;
          const body = await readBody(req);
          const result = await a.handle({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body });
          res.statusCode = result.status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(result.data));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
    },
  };
}

function readBody(req: { method?: string; on: unknown }): Promise<unknown> {
  return new Promise((resolve) => {
    if ((req.method ?? 'GET') === 'GET') return resolve(undefined);
    const chunks: Buffer[] = [];
    (req as unknown as { on: (ev: string, cb: (c?: Buffer) => void) => void }).on('data', (c) => chunks.push(c as Buffer));
    (req as unknown as { on: (ev: string, cb: () => void) => void }).on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) : undefined);
    });
  });
}
