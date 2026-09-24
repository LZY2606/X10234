import initSqlJs from 'sql.js';
// Vite 会把 wasm 当作静态资源；Node 下回退到 node_modules 实体路径。
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

let bytesPromise: Promise<Uint8Array> | null = null;

async function loadWasmBytes(): Promise<Uint8Array> {
  if (!bytesPromise) {
    bytesPromise = (async () => {
      try {
        if (typeof process !== 'undefined' && process.versions?.node) {
          const { readFile } = await import('node:fs/promises');
          const { fileURLToPath } = await import('node:url');
          const path = wasmUrl.startsWith('file:') ? fileURLToPath(wasmUrl) : (await import('node:path')).resolve('node_modules/sql.js/dist/sql-wasm.wasm');
          return new Uint8Array(await readFile(path));
        }
      } catch {
        // 落到 fetch 分支（浏览器）
      }
      const response = await fetch(wasmUrl);
      return new Uint8Array(await response.arrayBuffer());
    })();
  }
  return bytesPromise;
}

export async function createSqlDatabase(existing?: Uint8Array): Promise<import('sql.js').Database> {
  const wasmBinary = await loadWasmBytes();
  const SQL = await initSqlJs({ wasmBinary });
  return existing ? new SQL.Database(existing) : new SQL.Database();
}
