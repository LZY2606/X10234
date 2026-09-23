import { TiltStore } from './store';
import { project, ProjectedState, resolveRef } from '../domain/projector';
import { CorruptionError } from '../domain/archive';
import type { EntityBody, EntityKind, VersionRef } from '../domain/types';
import type { EventType, EventPayloads, RecordedEvent } from '../domain/events';
import { OptimisticLockError } from './store';

export interface EntityView {
  entityId: string;
  kind: EntityKind;
  version: number;
  contentId: string;
  body: EntityBody;
  eventSeq: number;
  refs: Array<VersionRef & {
    resolved: boolean;
    targetSummary: string | null;
    corruption: string | null;
  }>;
  corruption: string | null;
}

export class TiltService {
  constructor(public readonly store: TiltStore) {}

  state(branchId: string, atSeq?: number): ProjectedState {
    const events =
      atSeq === undefined
        ? this.store.events(branchId)
        : this.store.eventsUntil(branchId, atSeq);
    return project(events);
  }

  view(branchId: string, atSeq?: number) {
    const state = this.state(branchId, atSeq);
    return {
      branch: this.store.getBranch(branchId),
      branches: this.store.listBranches(),
      state,
      locks: this.store.listLocks()
    };
  }

  append<E extends EventType>(
    branchId: string,
    type: E,
    payload: EventPayloads[E],
    options?: { expectedHeadSeq?: number; author?: string }
  ) {
    return this.store.append(branchId, type, payload, options);
  }

  /**
   * 记录一个实体：内容去重 -> refs 索引 -> 追加事件。
   * 整个动作在单个事务内，失败回滚，不留半份记录。
   */
  recordEntity(
    branchId: string,
    entityId: string,
    kind: EntityKind,
    version: number,
    body: EntityBody,
    refs: VersionRef[],
    options?: { expectedHeadSeq?: number; author?: string }
  ): { event: RecordedEvent; contentId: string } {
    return this.store.transaction(() => {
      const content = this.store.putContent(kind, body);
      const { event } = this.store.append(
        branchId,
        'entity_recorded',
        {
          entityId,
          kind,
          version,
          contentId: content.contentId,
          body,
          refs
        },
        {
          expectedHeadSeq: options?.expectedHeadSeq,
          author: options?.author
        }
      );
      for (const ref of refs) {
        this.store.addRef(content.contentId, entityId, ref, event.seq);
      }
      return { event, contentId: content.contentId };
    });
  }

  /** 查询实体：返回引用版本号 + 内容摘要；缺少引用报损坏，不退回最新版。 */
  queryEntity(
    branchId: string,
    entityId: string,
    atSeq?: number
  ): EntityView {
    const state = this.state(branchId, atSeq);
    const record = (() => {
      const versions = state.entities.get(entityId);
      if (!versions) return null;
      if (atSeq === undefined) {
        const head = state.headVersionByEntity.get(entityId);
        return head === undefined ? null : versions.get(head)!;
      }
      const candidates = [...versions.values()]
        .filter((entry) => entry.eventSeq <= atSeq)
        .sort((a, b) => b.version - a.version);
      return candidates[0] ?? null;
    })();
    if (!record) {
      throw new CorruptionError(
        'MISSING_REFERENCE',
        `实体 '${entityId}' 在该版本点不存在`,
        { entityId, atSeq: atSeq ?? null }
      );
    }
    let corruption: string | null = null;
    const refs = record.refs.map((ref) => {
      try {
        const target = resolveRef(state, ref);
        const content = this.store.getContent(ref.contentId);
        return {
          ...ref,
          resolved: true,
          targetSummary: content
            ? `${target.kind}:${content.byteLength}B:${content.sha256.slice(0, 12)}`
            : null,
          corruption: null
        };
      } catch (error) {
        const message =
          error instanceof CorruptionError
            ? error.message
            : '引用解析失败';
        corruption = message;
        return {
          ...ref,
          resolved: false,
          targetSummary: null,
          corruption: message
        };
      }
    });
    return {
      entityId: record.entityId,
      kind: record.kind,
      version: record.version,
      contentId: record.contentId,
      body: record.body,
      eventSeq: record.eventSeq,
      refs,
      corruption
    };
  }

  resolveLock(handle: string, branchId: string) {
    const ref = this.store.getLock(handle);
    if (!ref) {
      throw new CorruptionError(
        'MISSING_REFERENCE',
        `重建引用句柄 '${handle}' 不存在`,
        { handle }
      );
    }
    const state = this.state(branchId);
    const record = resolveRef(state, ref);
    return { ref, record, lock: this.store.getLock(handle) };
  }
}

export { OptimisticLockError };
