import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TiltService } from './service-read';
import { buildImportPlan, type CaseMaterials } from '../domain/ingest';
import { RULE_LIBRARY, type RuleOutcome } from '../domain/events';
import type { EntityKind, VersionRef } from '../domain/types';

/**
 * 案例安装（基线导入）。
 * 整个导入在一个事务里；任何失败都回滚，不留半份记录。
 * 原始字节按内容寻址入库；共享 blob 只存一份不可变内容。
 */
export async function loadCaseMaterials(caseRoot: string): Promise<{
  materials: CaseMaterials;
  blobBytes: Map<string, Buffer>;
}> {
  const materials = JSON.parse(
    await readFile(join(caseRoot, 'materials.json'), 'utf8')
  ) as CaseMaterials;
  const blobBytes = new Map<string, Buffer>();
  for (const frame of materials.frames) {
    if (frame.blob) {
      blobBytes.set(frame.blob.path, await readFile(join(caseRoot, frame.blob.path)));
    }
  }
  return { materials, blobBytes };
}

export function installBaseline(
  service: TiltService,
  branchId: string,
  materials: CaseMaterials,
  blobBytes: Map<string, Buffer>
): { sourceRefs: Map<string, VersionRef>; headSeq: number } {
  const store = service.store;
  store.transaction(() => {
    if (!store.branchExists(branchId)) store.createBranch(branchId);
    const plan = buildImportPlan(materials, blobBytes);

    // blob 先入库（内容去重，blobContentId 由 sha256 决定）。
    for (const envelope of plan.envelopes) {
      if (envelope.blob) {
        store.putBlob(
          envelope.blob.contentId,
          envelope.blob.bytes,
          envelope.blob.contentType
        );
      }
    }

    let headSeq = store.getBranch(branchId).headBranchSeq;
    for (const envelope of plan.envelopes) {
      const { event } = store.append(
        branchId,
        'entity_recorded',
        {
          entityId: envelope.entityId,
          kind: envelope.kind,
          version: envelope.version,
          contentId: envelope.contentId,
          body: envelope.body,
          refs: envelope.refs
        },
        { expectedHeadSeq: headSeq, author: 'importer' }
      );
      headSeq = event.seq === 0 ? headSeq : store.getBranch(branchId).headBranchSeq;
    }

    store.append(
      branchId,
      'material_set_committed',
      {
        revision: {
          materialSetId: 'material_set_baseline',
          version: 1,
          sourceContentIds: plan.sourceContentIds,
          note: '基线：原始帧/倾角/像素尺度/剂量/标记点/跟踪缺口/手工排除原因全部版本化'
        }
      },
      { expectedHeadSeq: store.getBranch(branchId).headBranchSeq, author: 'importer' }
    );

    for (const assertion of RULE_LIBRARY) {
      store.append(
        branchId,
        'rule_asserted',
        { assertion },
        {
          expectedHeadSeq: store.getBranch(branchId).headBranchSeq,
          author: 'system'
        }
      );
    }

    store.append(
      branchId,
      'case_annotation',
      {
        scenario: 'baseline',
        title: '基线导入',
        narrative:
          '电镜小组导入倾转序列、曝光剂量和 fiducial 点轨迹；来源与解释分开保存，导入不做不可逆清洗。'
      },
      { expectedHeadSeq: store.getBranch(branchId).headBranchSeq, author: 'importer' }
    );

    store.markCaseInstalled(materials.caseId, branchId);
  });

  const sourceRefs = new Map<string, VersionRef>();
  const state = service.state(branchId);
  for (const [entityId, versions] of state.entities) {
    const version = state.headVersionByEntity.get(entityId)!;
    const record = versions.get(version)!;
    sourceRefs.set(entityId, {
      entityId,
      kind: record.kind as EntityKind,
      version,
      contentId: record.contentId
    });
  }
  return {
    sourceRefs,
    headSeq: store.getBranch(branchId).headBranchSeq
  };
}

export function emitRuleOutcome(
  service: TiltService,
  branchId: string,
  outcome: RuleOutcome,
  expectedHeadSeq?: number
) {
  return service.append(
    branchId,
    'rule_outcome_recorded',
    { outcome },
    { expectedHeadSeq, author: 'rules' }
  );
}
