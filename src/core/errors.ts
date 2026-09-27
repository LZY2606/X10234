export class CorruptionError extends Error {
  constructor(
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'CorruptionError';
  }
}

export class ConflictError extends Error {
  constructor(
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ImportRollbackError extends Error {
  constructor(
    message: string,
    readonly causeDetail?: unknown
  ) {
    super(message);
    this.name = 'ImportRollbackError';
  }
}
