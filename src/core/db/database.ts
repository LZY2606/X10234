import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_1_TO_2, SCHEMA_V2 } from './schema';

/** node:sqlite 的薄封装：事务、迁移、参数化查询。 */
export class Database {
  readonly inner: DatabaseSync;

  constructor(path: string) {
    this.inner = new DatabaseSync(path);
    this.inner.exec('PRAGMA journal_mode = WAL');
    this.inner.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const row = this.inner.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    const version = row ? Number(row.value) : 0;
    if (version === 0) {
      this.inner.exec(SCHEMA_V2);
    } else if (version === 1) {
      this.inner.exec(MIGRATION_1_TO_2);
    } else if (version !== 2) {
      throw new Error(`不支持的 schema 版本: ${version}`);
    }
  }

  /** 事务：导入失败只能回滚本次变更，不能留下半份记录。 */
  transaction<T>(fn: () => T): T {
    this.inner.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.inner.exec('COMMIT');
      return out;
    } catch (err) {
      this.inner.exec('ROLLBACK');
      throw err;
    }
  }

  run(sql: string, ...params: Array<string | number | Uint8Array | null>): void {
    this.inner.prepare(sql).run(...(params as never[]));
  }

  get<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    return this.inner.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.inner.prepare(sql).all(...(params as never[])) as T[];
  }

  close(): void {
    this.inner.close();
  }
}
