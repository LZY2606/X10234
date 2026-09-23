export class CorruptionError extends Error {
  constructor(public ref: { id: string; version: number }, message: string) {
    super(`损坏：缺少引用 ${ref.id}@${ref.version} —— ${message}`);
    this.name = 'CorruptionError';
  }
}

export class ConflictError extends Error {
  constructor(public conflict: {
    entityType: string; entityId: string; baseVersion: number; currentVersion: number;
    theirs: unknown; yours: unknown;
  }) {
    super(`版本冲突：${conflict.entityType}/${conflict.entityId} 基线 v${conflict.baseVersion}，当前 v${conflict.currentVersion}`);
    this.name = 'ConflictError';
  }
}

export class RuleViolation extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'RuleViolation';
  }
}
