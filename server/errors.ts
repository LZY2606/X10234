export class CorruptReferenceError extends Error {
  constructor(message: string, readonly missingRef: { entityId: string; version?: number }) {
    super(message);
    this.name = 'CorruptReferenceError';
  }
}

export class OptimisticLockError extends Error {
  constructor(message: string, readonly conflict: {
    entityId: string;
    baseVersion: number;
    currentVersion: number;
  }) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

export class ImportRollbackError extends Error {
  constructor(message: string, readonly diagnostics: unknown[]) {
    super(message);
    this.name = 'ImportRollbackError';
  }
}
