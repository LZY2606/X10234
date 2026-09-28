import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function openDatabase(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): { from: number; to: number; applied: number[] } {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const current = (
    db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }
  ).v;
  const dir = join(here, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: number[] = [];
  for (const file of files) {
    const version = Number(file.split("-")[0]);
    if (version <= current) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      applied.push(version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  const target = files.length ? Number(files[files.length - 1]!.split("-")[0]) : current;
  return { from: current, to: target, applied };
}

export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }).v;
}
