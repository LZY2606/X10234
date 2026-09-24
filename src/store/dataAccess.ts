import type { Store } from "./types";

/**
 * 数据访问层：把领域读写固定为具名操作，内存与 SQLite 两种引擎共享语义，
 * 这样浏览器无需 SQL 引擎，Node 验收使用真正的 SQLite。
 */

export interface BlobRec {
  blobId: string;
  bytes: Uint8Array;
  size: number;
  createdEventId: string | null;
}

export interface FactRec {
  stableId: string;
  version: number;
  kind: string;
  entityJson: string;
  contentDigest: string;
  createdEventId: string;
  supersedesVersion: number | null;
}

export interface EventRec {
  eventId: string;
  seq: number;
  parentEventId: string | null;
  branch: string;
  eventType: string;
  payloadJson: string;
  author: string;
  createdAt: string;
  baselineId: string | null;
  conflictStatus: string | null;
}

export interface RefRec {
  branch: string;
  headEventId: string;
  headSeq: number;
  expectedParentEventId: string | null;
}

export interface DepRec {
  fromId: string;
  fromVersion: number;
  toId: string;
  toVersion: number;
  relation: string;
}

export interface DataAccess {
  // meta
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // blobs
  getBlob(blobId: string): BlobRec | null;
  putBlob(rec: BlobRec): void;
  listBlobIds(): string[];

  // facts
  getFact(stableId: string, version: number): FactRec | null;
  latestFact(stableId: string): FactRec | null;
  putFact(rec: FactRec): void;
  listFacts(): FactRec[];
  factsByKind(kind: string): FactRec[];
  listVersions(stableId: string): number[];

  // events
  getEvent(eventId: string): EventRec | null;
  putEvent(rec: EventRec): void;
  listEvents(): EventRec[];
  eventsOnBranch(branch: string): EventRec[];
  maxSeq(): number;

  // refs
  getRef(branch: string): RefRec | null;
  putRef(rec: RefRec): void;
  listRefs(): RefRec[];

  // deps
  addDep(rec: DepRec): void;
  depsFrom(fromId: string, fromVersion: number): DepRec[];
  depsTo(toId: string, toVersion: number): DepRec[];
  listDeps(): DepRec[];

  transaction<T>(fn: () => T): T;
  close(): void;
  readonly engine: string;
  clearAll(): void;
}

/** 从任意 Store 构造需要在各自实现中完成（参数绑定差异），这里提供共用常量。 */
export const TABLES_READY = true;

export function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  throw new Error("无法识别的字节类型");
}

/** 让 SqliteStore 暴露 DataAccess 的适配器工厂由 ./sqliteData 提供。 */
export type { Store };
