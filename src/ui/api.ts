export interface BranchInfo {
  branchId: string;
  parentBranchId: string | null;
  headBranchSeq: number;
}

export interface EntityDto {
  entityId: string;
  kind: string;
  version: number;
  contentId: string;
  eventSeq: number;
  summary: string | null;
  body: any;
}

export interface StateDto {
  branchId: string;
  headSeq: number;
  atSeq: number;
  annotations: Array<{ seq: number; scenario: string; title: string; narrative: string }>;
  materialSets: any[];
  ruleOutcomes: any[];
  locks: Array<{ handle: string; ref: any }>;
  events: Array<{
    eventId: string;
    seq: number;
    type: string;
    author: string;
    createdAt: string;
    payload: any;
  }>;
  entities: EntityDto[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? `HTTP ${response.status}`) as Error & {
      status?: number;
      data?: any;
    };
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data as T;
}

export const api = {
  branches: () => request<{ branches: BranchInfo[] }>('/api/branches'),
  state: (branchId: string, atSeq?: number) =>
    request<StateDto>(
      `/api/state?branch=${encodeURIComponent(branchId)}${
        atSeq !== undefined ? `&atSeq=${atSeq}` : ''
      }`
    ),
  entity: (branchId: string, entityId: string) =>
    request<any>(
      `/api/entity?branch=${encodeURIComponent(branchId)}&entityId=${encodeURIComponent(entityId)}`
    ),
  decide: (payload: {
    branchId: string;
    candidateId: string;
    accepted: boolean;
    reason: string;
    expectedHeadSeq: number;
  }) => request<any>('/api/decision', { method: 'POST', body: JSON.stringify(payload) }),
  undo: (payload: { branchId: string; candidateId: string; expectedHeadSeq: number }) =>
    request<any>('/api/undo', { method: 'POST', body: JSON.stringify(payload) }),
  lock: (payload: { branchId: string; candidateId: string; expectedHeadSeq: number }) =>
    request<any>('/api/lock', { method: 'POST', body: JSON.stringify(payload) }),
  invalidate: (payload: {
    branchId: string;
    changedContentIds: string[];
    note: string;
    expectedHeadSeq: number;
  }) => request<any>('/api/invalidate', { method: 'POST', body: JSON.stringify(payload) }),
  exportArchive: () => request<any>('/api/archive/export'),
  importArchive: (bundle: any) =>
    request<any>('/api/archive/import', {
      method: 'POST',
      body: JSON.stringify(bundle)
    }),
  reset: () => request<any>('/api/reset', { method: 'POST' }),
  recon: (branchId: string, handle: string) =>
    request<any>(`/api/recon?branch=${encodeURIComponent(branchId)}&handle=${encodeURIComponent(handle)}`)
};

export function frameImageUrl(blobContentId: string): string {
  return `/api/frame?blob=${encodeURIComponent(blobContentId)}`;
}
