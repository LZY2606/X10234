import { DatabaseSync } from "node:sqlite";
import type { Store, Row } from "./types";
import { SCHEMA_SQL } from "./schema";

/**
 * 基于 Node 内置 node:sqlite 的同步存储。
 * 列名使用下划线，查询层统一在 SQL 中取该名字。
 */
export class SqliteStore implements Store {
  readonly engine = "sqlite" as const;
  private db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: unknown[]): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  get(sql: string, params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  all(sql: string, params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params as never[])) as Row[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
