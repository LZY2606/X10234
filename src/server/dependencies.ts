import type { DatabaseSync } from "node:sqlite";

export type DependencyRelation =
  | "candidate->source"
  | "candidate->ruleset"
  | "decision->candidate"
  | "lock->candidate"
  | "event->commit"
  | "view->candidate";

export class DependencyGraph {
  constructor(private db: DatabaseSync) {}

  add(
    from: { id: string; version: number },
    to: { id: string; version: number },
    relation: DependencyRelation,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO dependency_edges(from_entity_id, from_version, to_entity_id, to_version, relation)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(from.id, from.version, to.id, to.version, relation);
  }

  /**
   * 失效范围：某个来源 scope 产生新版本后，沿依赖边正向传播。
   * 参数/参考版本变化只失效直接+下游，不允许全局替换旧结论。
   */
  invalidationScope(changedScopes: { id: string; version: number }[]): {
    candidates: string[];
    decisions: string[];
    locks: string[];
    edges: { from: string; to: string; relation: string }[];
  } {
    const affectedCandidates = new Set<string>();
    const affectedDecisions = new Set<string>();
    const affectedLocks = new Set<string>();
    const edges: { from: string; to: string; relation: string }[] = [];

    const queue = changedScopes.map((s) => `${s.id}@v${s.version}`);
    const seen = new Set<string>(queue);

    while (queue.length) {
      const current = queue.shift()!;
      const [id, versionPart] = current.split("@v");
      const rows = this.db
        .prepare(
          `SELECT from_entity_id, from_version, relation FROM dependency_edges
           WHERE to_entity_id = ? AND to_version = ?`,
        )
        .all(id, Number(versionPart)) as { from_entity_id: string; from_version: number; relation: string }[];
      for (const row of rows) {
        edges.push({ from: `${row.from_entity_id}@v${row.from_version}`, to: current, relation: row.relation });
        if (row.relation.startsWith("candidate")) {
          affectedCandidates.add(`${row.from_entity_id}@v${row.from_version}`);
        } else if (row.relation === "decision->candidate") {
          affectedDecisions.add(`${row.from_entity_id}@v${row.from_version}`);
        } else if (row.relation === "lock->candidate") {
          affectedLocks.add(`${row.from_entity_id}@v${row.from_version}`);
        }
        const next = `${row.from_entity_id}@v${row.from_version}`;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return {
      candidates: [...affectedCandidates],
      decisions: [...affectedDecisions],
      locks: [...affectedLocks],
      edges,
    };
  }
}
