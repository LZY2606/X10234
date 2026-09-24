import type { DataAccess, BlobRec, FactRec, EventRec, RefRec, DepRec } from "./dataAccess";

type Undo = () => void;

/**
 * 纯内存 DataAccess：与 SqliteData 具名操作语义一致，供浏览器使用。
 * 事务用撤销日志实现：导入失败时按逆序撤销本次全部变更，不留半份记录。
 */
export class MemoryData implements DataAccess {
  readonly engine = "memory";
  private meta = new Map<string, string>();
  private blobs = new Map<string, BlobRec>();
  private facts = new Map<string, Map<number, FactRec>>();
  private events = new Map<string, EventRec>();
  private refs = new Map<string, RefRec>();
  private deps: DepRec[] = [];
  private depth = 0;
  private undoLog: Undo[] = [];

  private log(undo: Undo): void {
    if (this.depth > 0) this.undoLog.push(undo);
  }

  getMeta(key: string): string | null {
    return this.meta.has(key) ? (this.meta.get(key) as string) : null;
  }
  setMeta(key: string, value: string): void {
    const prev = this.meta.has(key) ? (this.meta.get(key) as string) : null;
    this.meta.set(key, value);
    this.log(() => {
      if (prev === null) this.meta.delete(key);
      else this.meta.set(key, prev);
    });
  }

  getBlob(blobId: string): BlobRec | null {
    return this.blobs.get(blobId) ?? null;
  }
  putBlob(rec: BlobRec): void {
    if (this.blobs.has(rec.blobId)) return;
    this.blobs.set(rec.blobId, rec);
    this.log(() => this.blobs.delete(rec.blobId));
  }
  listBlobIds(): string[] {
    return [...this.blobs.keys()].sort();
  }

  private factMap(stableId: string): Map<number, FactRec> {
    let m = this.facts.get(stableId);
    if (!m) {
      m = new Map();
      this.facts.set(stableId, m);
    }
    return m;
  }
  getFact(stableId: string, version: number): FactRec | null {
    return this.factMap(stableId).get(version) ?? null;
  }
  latestFact(stableId: string): FactRec | null {
    const m = this.factMap(stableId);
    if (m.size === 0) return null;
    return m.get(Math.max(...m.keys())) as FactRec;
  }
  putFact(rec: FactRec): void {
    const m = this.factMap(rec.stableId);
    const existed = m.has(rec.version);
    const prev = existed ? (m.get(rec.version) as FactRec) : null;
    m.set(rec.version, rec);
    this.log(() => {
      if (prev) m.set(rec.version, prev);
      else m.delete(rec.version);
    });
  }
  listFacts(): FactRec[] {
    const out: FactRec[] = [];
    for (const m of this.facts.values()) out.push(...m.values());
    out.sort((a, b) =>
      a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : a.version - b.version
    );
    return out;
  }
  factsByKind(kind: string): FactRec[] {
    return this.listFacts().filter((f) => f.kind === kind);
  }
  listVersions(stableId: string): number[] {
    return [...this.factMap(stableId).keys()].sort((a, b) => a - b);
  }

  getEvent(eventId: string): EventRec | null {
    return this.events.get(eventId) ?? null;
  }
  putEvent(rec: EventRec): void {
    this.events.set(rec.eventId, rec);
    this.log(() => this.events.delete(rec.eventId));
  }
  listEvents(): EventRec[] {
    return [...this.events.values()].sort((a, b) => a.seq - b.seq);
  }
  eventsOnBranch(branch: string): EventRec[] {
    return this.listEvents().filter((e) => e.branch === branch);
  }
  maxSeq(): number {
    return this.events.size === 0 ? 0 : Math.max(...[...this.events.values()].map((e) => e.seq));
  }

  getRef(branch: string): RefRec | null {
    return this.refs.get(branch) ?? null;
  }
  putRef(rec: RefRec): void {
    const prev = this.refs.get(rec.branch) ?? null;
    this.refs.set(rec.branch, rec);
    this.log(() => {
      if (prev) this.refs.set(rec.branch, prev);
      else this.refs.delete(rec.branch);
    });
  }
  listRefs(): RefRec[] {
    return [...this.refs.values()].sort((a, b) => (a.branch < b.branch ? -1 : 1));
  }

  addDep(rec: DepRec): void {
    const exists = this.deps.some(
      (d) =>
        d.fromId === rec.fromId &&
        d.fromVersion === rec.fromVersion &&
        d.toId === rec.toId &&
        d.toVersion === rec.toVersion
    );
    if (exists) return;
    this.deps.push({ ...rec });
    this.log(() => {
      const idx = this.deps.findIndex(
        (d) =>
          d.fromId === rec.fromId &&
          d.fromVersion === rec.fromVersion &&
          d.toId === rec.toId &&
          d.toVersion === rec.toVersion
      );
      if (idx >= 0) this.deps.splice(idx, 1);
    });
  }
  depsFrom(fromId: string, fromVersion: number): DepRec[] {
    return this.deps.filter((d) => d.fromId === fromId && d.fromVersion === fromVersion);
  }
  depsTo(toId: string, toVersion: number): DepRec[] {
    return this.deps.filter((d) => d.toId === toId && d.toVersion === toVersion);
  }
  listDeps(): DepRec[] {
    return [...this.deps].sort((a, b) =>
      a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : a.fromVersion - b.fromVersion
    );
  }

  transaction<T>(fn: () => T): T {
    const outer = this.depth === 0;
    if (outer) this.undoLog = [];
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (outer) this.undoLog = [];
      return result;
    } catch (err) {
      this.depth--;
      if (outer) {
        for (let i = this.undoLog.length - 1; i >= 0; i--) this.undoLog[i]();
        this.undoLog = [];
      }
      throw err;
    }
  }

  close(): void {}

  clearAll(): void {
    this.meta.clear();
    this.blobs.clear();
    this.facts.clear();
    this.events.clear();
    this.refs.clear();
    this.deps = [];
  }
}
