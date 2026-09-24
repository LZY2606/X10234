// 依赖图：参数/参考版本变化后，只计算受影响的派生实体（闭包），不允许全局静默替换。
export interface DependencyEdge {
  fromStableId: string; // 依赖方（候选/参数）
  toStableId: string;   // 被依赖方（帧/轴/轨迹）
  scope: 'geometry' | 'dose' | 'all';
}

export interface InvalidationInput {
  changedStableId: string;
  changedScope: 'geometry' | 'dose' | 'all';
  edges: DependencyEdge[];
}

// scope 命中规则：geometry 影响 geometry+all；dose 仅影响 dose+all
function scopeMatches(edgeScope: DependencyEdge['scope'], changed: InvalidationInput['changedScope']): boolean {
  if (changed === 'all') return true;
  if (edgeScope === 'all') return true;
  return edgeScope === changed;
}

export function computeInvalidationScope(input: InvalidationInput): Set<string> {
  const affected = new Set<string>([input.changedStableId]);
  const outgoing = new Map<string, DependencyEdge[]>();
  for (const edge of input.edges) {
    if (!outgoing.has(edge.toStableId)) outgoing.set(edge.toStableId, []);
    outgoing.get(edge.toStableId)!.push(edge);
  }
  const queue = [input.changedStableId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const edge of outgoing.get(cur) ?? []) {
      if (!scopeMatches(edge.scope, input.changedScope)) continue;
      if (!affected.has(edge.fromStableId)) {
        affected.add(edge.fromStableId);
        queue.push(edge.fromStableId);
      }
    }
  }
  return affected;
}
