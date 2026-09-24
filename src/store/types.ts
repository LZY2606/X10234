export interface Row {
  [column: string]: unknown;
}

export interface Store {
  exec(sql: string): void;
  run(sql: string, params: unknown[]): void;
  get(sql: string, params: unknown[]): Row | undefined;
  all(sql: string, params: unknown[]): Row[];
  /** 在单个事务里执行；抛错则整体回滚（导入失败不留半份记录）。 */
  transaction<T>(fn: () => T): T;
  close(): void;
  /** 引擎标识，供测试区分。 */
  readonly engine: "sqlite" | "memory";
}

export interface ExportBundle {
  format: "tilt-room-archive/v1";
  exportedAt: string;
  seq: number;
  blobs: Array<{ blobId: string; bytesBase64: string; size: number; createdEventId: string | null }>;
  facts: Array<{
    stableId: string;
    version: number;
    kind: string;
    entityJson: string;
    contentDigest: string;
    createdEventId: string;
    supersedesVersion: number | null;
  }>;
  events: Array<{
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
  }>;
  refs: Array<{ branch: string; headEventId: string; headSeq: number; expectedParentEventId: string | null }>;
  dependencies: Array<{
    fromId: string;
    fromVersion: number;
    toId: string;
    toVersion: number;
    relation: string;
  }>;
}
