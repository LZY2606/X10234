/** 引用缺失/损坏：必须报错，禁止静默回退到“当前最新版”。 */
export class CorruptArchiveError extends Error {
  constructor(
    public readonly missingRef: string,
    public readonly fromEntity: string,
  ) {
    super(`档案损坏：${fromEntity} 引用的版本 ${missingRef} 不存在（禁止回退到最新版）`);
    this.name = "CorruptArchiveError";
  }
}

/** 乐观并发冲突：后提交者看到版本冲突与双方差异。 */
export class ConcurrencyConflictError extends Error {
  constructor(
    public readonly expectedHead: string,
    public readonly actualHead: string,
    public readonly diff: unknown,
  ) {
    super(`版本冲突：期望头 ${expectedHead}，实际头 ${actualHead}`);
    this.name = "ConcurrencyConflictError";
  }
}

/** 导入失败：只能整体回滚，不能留半份记录。 */
export class ImportRejectedError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: string[],
  ) {
    super(message);
    this.name = "ImportRejectedError";
  }
}
