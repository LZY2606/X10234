declare module "node:sqlite" {
  export type SQLInputValue = string | number | bigint | Uint8Array | null;
  export class StatementSync {
    all(...params: SQLInputValue[]): unknown[];
    get(...params: SQLInputValue[]): unknown;
    run(...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint };
    setAllowBareNamedParameters(enabled: boolean): void;
  }
  export class DatabaseSync {
    constructor(location: string, options?: { readOnly?: boolean });
    open(location: string): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }
}
