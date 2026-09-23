/**
 * “反例档案”导出格式（.trarc = tilt-room archive）。
 * 来源与解释分开保存；多个输入共享的原始片段只存一份不可变内容。
 */
export interface ArchiveBlobEntry {
  contentId: string;
  /** 导出内相对路径，例如 blobs/blob_<hash>.pgm */
  path: string;
  sha256: string;
  byteLength: number;
  contentType: string;
}

export interface ArchiveEntityEnvelope {
  eventId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
  author: string;
}

export interface ArchiveBranch {
  branchId: string;
  parentBranchId?: string;
  createdAt: string;
  events: ArchiveEntityEnvelope[];
}

export interface ArchiveManifest {
  format: 'tilt-room-archive';
  formatVersion: 1;
  caseId: string;
  title: string;
  domain: 'electron-tomography-tilt-series-registration';
  exportedAt: string;
  mainBranchId: string;
  branches: ArchiveBranch[];
  blobs: ArchiveBlobEntry[];
  /** 内容摘要：每个被引用 contentId 的身份信息。 */
  contentSummaries: Array<{
    contentId: string;
    kind: string;
    sha256: string;
    byteLength: number;
  }>;
}

export class CorruptionError extends Error {
  constructor(
    public code:
      | 'MISSING_REFERENCE'
      | 'CONTENT_MISMATCH'
      | 'BLOB_HASH_MISMATCH'
      | 'UNKNOWN_FORMAT'
      | 'NON_MONOTONIC_SEQ',
    message: string,
    public detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CorruptionError';
  }
}
