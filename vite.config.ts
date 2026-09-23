import { defineConfig } from 'vite';

// 仅作为构建器使用；开发期由 src/server/main.ts 直接挂载中间件，
// 保证 `npm run dev` 一条命令同时提供 API 与静态页面。
export default defineConfig({
  root: '.',
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  build: { outDir: 'dist' },
});
