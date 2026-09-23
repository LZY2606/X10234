import { sha256Hex } from '../domain/hash';
import { project, resolveRef } from '../domain/projector';
import {
  CorruptionError,
  type ArchiveBranch,
  type ArchiveEntityEnvelope,
  type ArchiveManifest
} from '../domain/archive';
import type { TiltService } from './service-read';

/**
 * 导出反例档案。
 * - 全部事件按分支链顺序导出（branch_seq 保持顺序）。
 * - blobs 全库去重列出；多个输入共享的原始片段只存一份不可变内容。
 * - 每个被引用 contentId 都附内容摘要。
 */
export function exportArchive(
  service: TiltService,
  caseId: string,
  title: string,
  mainBranchId: string
): ArchiveManifest {
  const store = service.store;
  const branchRows = store.listBranches();
  const branches: ArchiveBranch[] = [];

  for (const branchInfo of branchRows) {
    const events = store.events(branchInfo.branchId);
    const envelopes: ArchiveEntityEnvelope[] = events.map((event) => ({
      eventId: event.eventId,
      seq: (event as unknown as { seq?: number }).seq ?? event.branchId ? 0 : 0,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
      author: event.author
    }));
    branches.push({
      branchId: branchInfo.branchId,
      parentBranchId: branchInfo.parentBranchId ?? undefined,
      createdAt: branchInfo.createdAt,
      events: events.map((event, index) => ({
        eventId: event.eventId,
        seq: index + 1,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
        author: event.author
      }))
    });
    void envelopes;
  }

  const blobRows = store.listBlobIds();
  const blobs = blobRows.map((contentId) => {
    const blob = store.getBlob(contentId)!;
    const hash = sha256Hex(blob.bytes.toString('binary'));
    return {
      contentId,
      path: `blobs/${contentId}.bin`,
      sha256: hash,
      byteLength: blob.bytes.length,
      contentType: blob.contentType
    };
  });

  const contentSummaries = new Map<
    string,
    { contentId: string; kind: string; sha256: string; byteLength: number }
  >();
  for (const branchInfo of branchRows) {
    const state = project(store.events(branchInfo.branchId));
    for (const record of state.byContentId.values()) {
      if (!contentSummaries.has(record.contentId)) {
        const stored = store.getContent(record.contentId);
        contentSummaries.set(record.contentId, {
          contentId: record.contentId,
          kind: record.kind,
          sha256: stored?.sha256 ?? '',
          byteLength: stored?.byteLength ?? 0
        });
      }
    }
  }

  return {
    format: 'tilt-room-archive',
    formatVersion: 1,
    caseId,
    title,
    domain: 'electron-tomography-tilt-series-registration',
    exportedAt: new Date().toISOString(),
    mainBranchId,
    branches,
    blobs,
    contentSummaries: [...contentSummaries.values()]
  };
}

export interface ArchiveImportOptions {
  /** 导入前清空目标库（用于“删除本地数据库再导入”验证）。 */
  reset?: boolean;
}

/**
 * 导入档案：身份、顺序、来源关系必须保持。
 * - blob 哈希校验；
 * - 重放后逐分支校验所有引用，缺失引用 -> CorruptionError，整事务回滚；
 * - 不更新任何已有 contentId（只插入缺失内容）。
 */
export function importArchive(
  service: TiltService,
  manifest: ArchiveManifest,
  blobPayloads: Map<string, Buffer>,
  options: ArchiveImportOptions = {}
): { importedBranches: string[] } {
  if (manifest.format !== 'tilt-room-archive' || manifest.formatVersion !== 1) {
    throw new CorruptionError(
      'UNKNOWN_FORMAT',
      '不是 tilt-room-archive v1 档案'
    );
  }
  const store = service.store;

  store.transaction(() => {
    for (const blobEntry of manifest.blobs) {
      const bytes = blobPayloads.get(blobEntry.contentId);
      if (!bytes) {
        throw new CorruptionError(
          'MISSING_REFERENCE',
          `档案缺少原始片段 ${blobEntry.contentId}`,
          { contentId: blobEntry.contentId }
        );
      }
      const hash = sha256Hex(bytes.toString('binary'));
      if (hash !== blobEntry.sha256 || bytes.length !== blobEntry.byteLength) {
        throw new CorruptionError(
          'BLOB_HASH_MISMATCH',
          `原始片段 ${blobEntry.contentId} 内容已改变`,
          {
            expected: blobEntry.sha256,
            actual: hash
          }
        );
      }
      store.putBlob(blobEntry.contentId, bytes, blobEntry.contentType);
    }

    for (const branch of manifest.branches) {
      if (!store.branchExists(branch.branchId)) {
        store.createBranch(branch.branchId, branch.parentBranchId);
      }
      const expectedBranch = store.getBranch(branch.branchId);
      let expectedSeq = expectedBranch.headBranchSeq;
      for (const envelope of branch.events) {
        if (envelope.seq <= expectedBranch.headBranchSeq) continue;
        if (envelope.seq !== expectedSeq + 1 && expectedBranch.headBranchSeq === 0) {
          // 允许从 1 开始，但必须严格单调。
          if (envelope.seq !== 1 && expectedSeq === 0) {
            throw new CorruptionError(
              'NON_MONOTONIC_SEQ',
              `分支 ${branch.branchId} 事件序号非单调`,
              { got: envelope.seq, expected: expectedSeq + 1 }
            );
          }
        }
        const result = store.append(
          branch.branchId,
          envelope.type as never,
          envelope.payload as never,
          {
            expectedHeadSeq: expectedSeq,
            author: envelope.author,
            now: envelope.createdAt
          }
        );
        expectedSeq = result.newHeadSeq;

        const payload = envelope.payload as {
          kind?: string;
          contentId?: string;
          entityId?: string;
          refs?: Array<{ contentId: string; entityId: string }>;
          body?: unknown;
        };
        if (
          envelope.type === 'entity_recorded' &&
          payload.contentId &&
          payload.entityId
        ) {
          for (const ref of payload.refs ?? []) {
            store.addRef(
              payload.contentId,
              payload.entityId,
              ref as never,
              result.event.seq
            );
          }
        }
      }
    }

    // 全部重放完成后：逐分支校验引用图，任何缺失都报损坏。
    for (const branch of manifest.branches) {
      const state = project(store.events(branch.branchId));
      for (const record of state.byContentId.values()) {
        for (const ref of record.refs) {
          resolveRef(state, ref);
        }
      }
      for (const lock of state.locks) {
        resolveRef(state, lock.ref);
      }
    }
  });

  return { importedBranches: manifest.branches.map((branch) => branch.branchId) };
}

/** 打包档案到可导出 JSON + blob 映射（用于下载/测试）。 */
export function archiveToBundle(
  service: TiltService,
  caseId: string,
  title: string,
  mainBranchId: string
): { manifest: ArchiveManifest; blobs: Record<string, string> } {
  const manifest = exportArchive(service, caseId, title, mainBranchId);
  const blobs: Record<string, string> = {};
  for (const blob of manifest.blobs) {
    const data = service.store.getBlob(blob.contentId)!;
    blobs[blob.contentId] = data.bytes.toString('base64');
  }
  return { manifest, blobs };
}
