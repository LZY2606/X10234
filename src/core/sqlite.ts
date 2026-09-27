import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

export type SqlDatabase = initSqlJs.Database;

let wasmLocation: string | undefined;

export function setWasmLocation(location: string): void {
  wasmLocation = location;
}

async function resolveLocateFile(): Promise<((file: string) => string | Uint8Array) | undefined> {
  if (wasmLocation) return (file: string) => (file.endsWith('.wasm') ? wasmLocation! : file);
  try {
    const require = createRequire(import.meta.url);
    const nodePath = require('node:path') as typeof import('node:path');
    const fs = require('node:fs/promises') as typeof import('node:fs/promises');
    const wasmPath = nodePath.join(require.resolve('sql.js'), '..', 'sql-wasm.wasm');
    const bytes = new Uint8Array(await fs.readFile(wasmPath));
    return (file: string) => (file.endsWith('.wasm') ? bytes : file);
  } catch {
    return undefined;
  }
}

let initPromise: Promise<initSqlJs.SqlJsStatic> | undefined;

export async function getSql(): Promise<initSqlJs.SqlJsStatic> {
  if (!initPromise) {
    const locateFile = await resolveLocateFile();
    initPromise = initSqlJs(locateFile ? { locateFile } : undefined);
  }
  return initPromise;
}

export async function openDatabase(bytes?: Uint8Array): Promise<SqlDatabase> {
  const SQL = await getSql();
  return bytes ? new SQL.Database(bytes) : new SQL.Database();
}
