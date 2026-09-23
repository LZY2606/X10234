import type { DatabaseSync } from 'node:sqlite';
import type { EventRecord } from '../domain/types.js';
import { canonicalJSON, digestOf } from '../domain/ids.js';
import { Store } from './store.js';

/**
 * 导出/导入档案：包含全部不可变字节 + 全部分支事件（稳定事件身份）+ 分支血缘。
 * 删除本地数据库再导入后，身份、顺序与来源关系保持（断言覆盖）。
 */

export interface TransferBundle {
  format: 'tilt-review-archive/1';
  exportedAt: string;
  seriesIds: string[];
  branches: {
    branchId: string;
    seriesId: string;
    parentBranchId: string | null;
    name: string;
  }[];
  events: EventRecord[];
  blobs: { contentId: string; mediaType: string; bytesBase64: string; sha256: string }[];
  manifestDigest: string;
}

export function exportArchive(db: DatabaseSync, seriesIds: string[]): TransferBundle {
  const store = new Store(db);
  const branches: TransferBundle['branches'] = [];
  const events: EventRecord[] = [];
  const blobIds = new Set<string>();

  for (const sid of seriesIds) {
    for (const b of store.listBranches(sid)) {
      branches.push({ branchId: b.branchId, seriesId: sid, parentBranchId: b.parentBranchId, name: b.name });
      for (const e of store.listEvents(b.branchId)) {
        events.push(e);
        collectBlobIds(e.payload, blobIds);
      }
    }
  }
  // 稳定排序：按 series、branch、ordinal，保证字节确定
  events.sort((a, b) =>
    a.seriesId.localeCompare(b.seriesId) ||
    a.branchId.localeCompare(b.branchId) ||
    a.ordinal - b.ordinal,
  );

  const blobs: TransferBundle['blobs'] = [];
  for (const contentId of [...blobIds].sort()) {
    const row = store.getBlob(contentId);
    if (!row) continue;
    blobs.push({
      contentId: row.content_id,
      mediaType: row.media_type,
      bytesBase64: Buffer.from(row.bytes).toString('base64'),
      sha256: row.sha256,
    });
  }

  const exportedAt = new Date(0).toISOString();
  const partial: Omit<TransferBundle, 'manifestDigest'> = { format: 'tilt-review-archive/1', exportedAt, seriesIds, branches, events, blobs };
  return { ...partial, manifestDigest: digestOf(partial) };
}

function collectBlobIds(value: unknown, acc: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectBlobIds(v, acc);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'blobRef' && typeof v === 'string' && v.startsWith('blob-')) acc.add(v);
    else collectBlobIds(v, acc);
  }
}

/** 导入档案：逐分支、按 ordinal 复原；身份冲突/缺字节则整体回滚。 */
export function importArchive(db: DatabaseSync, bundle: TransferBundle): { imported: number } {
  const store = new Store(db);
  db.exec('BEGIN');
  try {
    // 先放字节
    for (const b of bundle.blobs) {
      store.putBlob(new Uint8Array(Buffer.from(b.bytesBase64, 'base64')), b.mediaType);
    }
    // 按血缘建分支（父先于子）
    const created = new Set<string>();
    const pending = [...bundle.branches];
    let guard = pending.length + 1;
    while (pending.length && guard-- > 0) {
      const b = pending.shift()!;
      if (store.getBranch(b.branchId)) {
        created.add(b.branchId);
        continue;
      }
      if (b.parentBranchId && !created.has(b.parentBranchId)) {
        pending.push(b);
        continue;
      }
      store.createBranch(b.branchId, b.seriesId, b.name, b.parentBranchId);
      created.add(b.branchId);
    }

    let imported = 0;
    for (const e of bundle.events) {
      const branch = store.getBranch(e.branchId);
      if (!branch) throw new Error(`archive-corrupt: missing branch ${e.branchId}`);
      // 幂等：已存在同身份事件则跳过
      if (store.getEvent(e.id)) {
        imported++;
        continue;
      }
      // 顺序校验：ordinal 必须正好是 head+1
      if (e.ordinal !== branch.head_version + 1) {
        throw new Error(`archive-corrupt: ordinal gap on ${e.branchId} (${e.ordinal} != ${branch.head_version + 1})`);
      }
      const stored = store.appendEvent({
        seriesId: e.seriesId,
        branchId: e.branchId,
        type: e.type,
        payload: e.payload,
        rationale: e.rationale,
        parentIds: e.parentIds,
      });
      if (stored.id !== e.id) {
        throw new Error(`archive-corrupt: unstable event id ${stored.id} != ${e.id}`);
      }
      imported++;
    }
    db.exec('COMMIT');
    return { imported };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function bundleCanonicalDigest(bundle: TransferBundle): string {
  return digestOf({ ...bundle, manifestDigest: null }) || canonicalJSON(bundle).slice(0, 8);
}
