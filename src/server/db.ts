import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

export type DB = Database.Database;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrationFiles(): { version: number; name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: parseInt(f.split('_')[0], 10),
      name: f,
      sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8'),
    }));
}

export function currentVersion(db: DB): number {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!exists) return 0;
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/** 迁移到指定版本（默认最新）。每个迁移在事务内执行，失败回滚本次迁移。 */
export function migrate(db: DB, target?: number): number[] {
  const files = migrationFiles();
  const latest = files[files.length - 1]?.version ?? 0;
  const goal = target ?? latest;
  const applied: number[] = [];
  const have = currentVersion(db);
  if (have === 0) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  }
  for (const f of files) {
    if (f.version <= have || f.version > goal) continue;
    const tx = db.transaction(() => {
      db.exec(f.sql);
      if (f.version === 2) backfillBranchHeads(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(f.version, new Date().toISOString());
    });
    tx();
    applied.push(f.version);
  }
  return applied;
}

/** 002 回填：从 interpretation_versions 推导每个分支的最新头。 */
function backfillBranchHeads(db: DB): void {
  const rows = db.prepare(`
    SELECT iv.branch_id, iv.id, iv.version, iv.created_at
    FROM interpretation_versions iv
    JOIN (
      SELECT branch_id, MAX(version) AS mv FROM interpretation_versions GROUP BY branch_id
    ) latest ON latest.branch_id = iv.branch_id AND latest.mv = iv.version
  `).all() as { branch_id: string; id: string; version: number; created_at: string }[];
  const ins = db.prepare(`
    INSERT OR REPLACE INTO branch_heads (branch_id, interpretation_id, interpretation_version, decision_seq, updated_at)
    VALUES (?, ?, ?, 0, ?)
  `);
  for (const r of rows) ins.run(r.branch_id, r.id, r.version, r.created_at);
}
