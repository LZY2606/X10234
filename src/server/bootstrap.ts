import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TiltStore } from './store';
import { TiltService } from './service-read';
import { installBaseline, loadCaseMaterials } from './service-case';
import { buildScenarioBranch } from './service-scenarios';
import { contentId } from '../domain/hash';
import type {
  PixelScale,
  RegistrationCandidate,
  ScenarioKey
} from '../domain/types';
import { invalidateDependents } from './service-decisions';

export const MAIN_BRANCH = 'main';
export const SCENARIO_KEYS: ScenarioKey[] = [
  'axis_offset',
  'identity_swap',
  'missing_high_tilt',
  'bad_frames',
  'warp_overfit',
  'ambiguity',
  'concurrent_freeze',
  'combined'
];

export interface Application {
  store: TiltStore;
  service: TiltService;
  caseRoot: string;
}

export async function createApplication(
  dbPath: string,
  caseRoot?: string
): Promise<Application> {
  const store = new TiltStore(dbPath);
  const service = new TiltService(store);
  const root =
    caseRoot ??
    join(
      dirnameFromImport(),
      '..',
      '..',
      'fixtures',
      'cases',
      'tilt-room-case'
    );
  return { store, service, caseRoot: root };
}

function dirnameFromImport(): string {
  try {
    return fileURLToPath(new URL('.', import.meta.url));
  } catch {
    return __dirname;
  }
}

/** 安装基线 + 全部反例分支（幂等）。 */
export async function ensureCaseInstalled(app: Application): Promise<void> {
  if (
    app.store.branchExists(MAIN_BRANCH) &&
    app.store.isCaseInstalled('tilt-room-case', MAIN_BRANCH)
  ) {
    return;
  }
  const { materials, blobBytes } = await loadCaseMaterials(app.caseRoot);
  installBaseline(app.service, MAIN_BRANCH, materials, blobBytes);
  for (const key of SCENARIO_KEYS) {
    buildScenarioBranch(app.service, MAIN_BRANCH, materials, key);
  }
}

/**
 * 参数修订（v2）：只改像素尺度这一条“直接来源”。
 * 依赖范围由引用图计算，受影响候选标 invalidated；旧版本保留可读。
 */
export function revisePixelScale(
  app: Application,
  materials: ReturnType<typeof JSON.parse> extends never ? never : any,
  branchId: string,
  newValue: number
): { newContentId: string; invalidated: string[] } {
  const state = app.service.state(branchId);
  const entityId = 'pixel_scale_series';
  const version = state.headVersionByEntity.get(entityId);
  if (version === undefined) throw new Error('缺少像素尺度基线');
  const record = state.entities.get(entityId)!.get(version)!;
  const previous = record.body as PixelScale;
  const updated: PixelScale = {
    ...previous,
    scale: {
      ...previous.scale,
      value: newValue,
      rawRepresentation: `${newValue} nm/pixel (revised)`
    }
  };
  const newContentId = contentId('pixel_scale', updated);
  const append = app.store.append(
    branchId,
    'entity_recorded',
    {
      entityId,
      kind: 'pixel_scale',
      version: version + 1,
      contentId: newContentId,
      body: updated,
      refs: []
    },
    { expectedHeadSeq: app.store.getBranch(branchId).headBranchSeq, author: 'em-group' }
  );
  app.store.append(
    branchId,
    'material_set_committed',
    {
      revision: {
        materialSetId: `material_set_${branchId}`,
        version: version + 1,
        sourceContentIds: [newContentId],
        note: '参数修订：像素尺度更新（只改一个直接来源）'
      }
    },
    { expectedHeadSeq: append.newHeadSeq, author: 'em-group' }
  );
  const outcome = invalidateDependents(
    app.service,
    branchId,
    [record.contentId],
    '像素尺度参数修订：按依赖关系计算失效范围，不全局替换旧结论',
    app.store.getBranch(branchId).headBranchSeq
  );
  return { newContentId, invalidated: outcome.invalidatedCandidateIds };
}

export function candidateSummary(
  app: Application,
  branchId: string
): RegistrationCandidate[] {
  const state = app.service.state(branchId);
  return [...state.headVersionByEntity.entries()]
    .filter(([id]) => id.startsWith('cand_'))
    .map(([id, version]) => state.entities.get(id)!.get(version)!.body as RegistrationCandidate)
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}
