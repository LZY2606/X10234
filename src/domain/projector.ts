import type { EntityBody, EntityRecord, VersionRef } from './types';
import type { RecordedEvent } from './events';
import { CorruptionError } from './archive';

/**
 * 事件流 -> 实体读模型。
 * - 每个 entityId 保留全部版本；查询“当前”默认取该分支头部下最新，
 *   但任何实体引用都必须解析到其钉住的具体 (entityId, version)。
 * - 缺少被引用版本 -> CorruptionError，禁止回退最新版。
 */

export interface ProjectedState {
  /** entityId -> 版本号 -> 记录 */
  entities: Map<string, Map<number, EntityRecord>>;
  /** entityId -> 当前（最新）版本号 */
  headVersionByEntity: Map<string, number>;
  /** 内容身份 -> 实体记录（同一内容可能被重放到不同实体历史，但 body 一致） */
  byContentId: Map<string, EntityRecord>;
  materialSetRevisions: import('./types').MaterialSetRevision[];
  annotations: Array<{
    seq: number;
    scenario: string;
    title: string;
    narrative: string;
  }>;
  events: RecordedEvent[];
  locks: Array<{ handle: string; ref: VersionRef; atSeq: number }>;
}

export function project(events: RecordedEvent[]): ProjectedState {
  const state: ProjectedState = {
    entities: new Map(),
    headVersionByEntity: new Map(),
    byContentId: new Map(),
    materialSetRevisions: [],
    annotations: [],
    events,
    locks: []
  };

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'material_set_committed': {
        const revision = payload.revision as import('./types').MaterialSetRevision;
        state.materialSetRevisions.push(revision);
        break;
      }
      case 'entity_recorded': {
        const p = payload as {
          entityId: string;
          kind: EntityRecord['kind'];
          version: number;
          contentId: string;
          body: EntityBody;
          refs: VersionRef[];
        };
        const record: EntityRecord = {
          entityId: p.entityId,
          kind: p.kind,
          version: p.version,
          contentId: p.contentId,
          body: p.body,
          branchId: event.branchId,
          eventId: event.eventId,
          eventSeq: event.seq,
          refs: p.refs
        };
        let versions = state.entities.get(p.entityId);
        if (!versions) {
          versions = new Map();
          state.entities.set(p.entityId, versions);
        }
        versions.set(p.version, record);
        const current = state.headVersionByEntity.get(p.entityId) ?? 0;
        if (p.version >= current) state.headVersionByEntity.set(p.entityId, p.version);
        state.byContentId.set(p.contentId, record);
        break;
      }
      case 'locked_for_reconstruction': {
        const p = payload as {
          reconstructionHandle: string;
          candidateRef: VersionRef;
        };
        state.locks.push({
          handle: p.reconstructionHandle,
          ref: p.candidateRef,
          atSeq: event.seq
        });
        break;
      }
      case 'case_annotation': {
        const p = payload as {
          scenario: string;
          title: string;
          narrative: string;
        };
        state.annotations.push({
          seq: event.seq,
          scenario: p.scenario,
          title: p.title,
          narrative: p.narrative
        });
        break;
      }
      default:
        break;
    }
  }
  return state;
}

export function currentEntity(
  state: ProjectedState,
  entityId: string
): EntityRecord | null {
  const version = state.headVersionByEntity.get(entityId);
  if (version === undefined) return null;
  return state.entities.get(entityId)?.get(version) ?? null;
}

/**
 * 解析引用：必须精确命中被引用版本。
 * 缺少引用（实体不存在 / 版本不存在 / 内容身份不匹配）-> CorruptionError。
 * 绝不退回当前最新版。
 */
export function resolveRef(
  state: ProjectedState,
  ref: VersionRef
): EntityRecord {
  const versions = state.entities.get(ref.entityId);
  const record = versions?.get(ref.version);
  if (!record) {
    throw new CorruptionError(
      'MISSING_REFERENCE',
      `损坏：引用的 ${ref.kind} '${ref.entityId}' v${ref.version} 不存在`,
      { ref }
    );
  }
  if (record.contentId !== ref.contentId) {
    throw new CorruptionError(
      'CONTENT_MISMATCH',
      `损坏：${ref.kind} '${ref.entityId}' v${ref.version} 内容身份与引用不一致`,
      {
        expectedContentId: ref.contentId,
        actualContentId: record.contentId
      }
    );
  }
  return record;
}

/** 深度校验一个实体（含传递引用）。 */
export function validateEntityGraph(
  state: ProjectedState,
  record: EntityRecord,
  seen: Set<string> = new Set()
): void {
  const key = `${record.entityId}@${record.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  for (const ref of record.refs) {
    const target = resolveRef(state, ref);
    validateEntityGraph(state, target, seen);
  }
}

export function allCurrentEntities(state: ProjectedState): EntityRecord[] {
  const out: EntityRecord[] = [];
  for (const [entityId, version] of state.headVersionByEntity) {
    const record = state.entities.get(entityId)?.get(version);
    if (record) out.push(record);
  }
  return out.sort((a, b) => a.eventSeq - b.eventSeq);
}

export function entityHistory(
  state: ProjectedState,
  entityId: string
): EntityRecord[] {
  const versions = state.entities.get(entityId);
  if (!versions) return [];
  return [...versions.values()].sort((a, b) => a.version - b.version);
}
