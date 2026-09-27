import initSqlJs from 'sql.js';

let cached: initSqlJs.SqlJsStatic | null = null;

async function loadWasmBytes(assetRef: string): Promise<Uint8Array | null> {
  try {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import('node:fs');
      const url = assetRef.startsWith('file:') ? new URL(assetRef) : null;
      const path = url ? decodeURIComponent(url.pathname) : assetRef;
          if (fs.existsSync(path)) return fs.readFileSync(path);
    } else if (typeof fetch === 'function') {
      const resp = await fetch(assetRef);
      if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
    }
  } catch {
    // fall through
  }
  return null;
}

export async function getSql(): Promise<initSqlJs.SqlJsStatic> {
  if (cached) return cached;
  const mod = await import('sql.js/dist/sql-wasm.wasm?url');
  const wasmUrl = (mod as { default: string }).default;
  const wasmBinary = (await loadWasmBytes(wasmUrl)) ?? undefined;
  cached = await initSqlJs({ wasmBinary: wasmBinary ? (wasmBinary as unknown as ArrayBuffer) : undefined });
  return cached;
}
