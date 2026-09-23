// 开发入口：单进程内嵌 Vite 中间件 + API，解析 --host/--port/--strictPort
import { createServer as createViteServer } from 'vite';
import { createApp } from './app.js';
import { join } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const host = arg('host') ?? '127.0.0.1';
const port = Number(arg('port') ?? 5349);
const strictPort = process.argv.includes('--strictPort');
const dbPath = process.env.TILT_DB ?? join(process.cwd(), '.dev-data', 'tilt-review.sqlite');
const packDir = process.env.CASEPACK_DIR ?? join(process.cwd(), 'casepack');

const { app } = createApp(dbPath, packDir);
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'custom',
  root: join(process.cwd(), 'web'),
});
app.use(vite.middlewares);
app.use('*', async (_req, res) => {
  res.status(404).send('not found');
});

const server = app.listen(port, host, () => {
  console.log(`tilt-align-review listening on http://${host}:${port} (db: ${dbPath})`);
});
server.on('error', (e: any) => {
  if (strictPort && e.code === 'EADDRINUSE') {
    console.error(`port ${port} is already in use (strictPort)`);
    process.exit(1);
  }
  throw e;
});
