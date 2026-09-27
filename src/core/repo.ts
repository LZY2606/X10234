import type { SqlDatabase } from './sqlite';
import { sha256Hex, stableStringify } from './hash';
import { CorruptionError, ConflictError, ImportRollbackError } from './errors';
import type {
  EntityBody,
  EntityKind,
  Ref,
  Series
} from '../domain/types';
import { ENTITY_KINDS } from '../domain/types';

export interface EventRecord {
  eventId: string;
  seriesId: string;
  branchId: string;
  ordinalInBranch: number;
  kind: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  parentEventId: string | null;
  actor: string;
  note: string;
  createdAt: string;
  ruleId: string | null;
  refs: Ref[];
}

interface EventRow {
  event_id: string;
  series_id: string;
  branch_id: string;
  ordinal_in_branch: number;
  kind: string;
  payload_json: string;
  payload_digest: string;
  parent_event_id: string | null;
  actor: string;
  note: string;
  created_at: string;
  rule_id: string | null;
  refs_json: string;
}

interface VersionRow {
  kind: string;
  id: string;
  version: number;
  digest: string;
  body_json: string;
  summary: string;
  created_at: string;
  branch_id: string | null;
}

const REF_KEY = '__refs';

export interface NewEntity {
  kind: EntityKind;
  id: string;
  body: EntityBody | Series;
  summary: string;
  branchId?: string;
  createdAt?: string;
}

export class Repo {
  constructor(readonly db: SqlDatabase) {}

  private static stmt(db: SqlDatabase, sql: string) {
    return db.prepare(sql);
  }

  async putBlob(bytes: Uint8Array, mediaType: string, createdAt: string): Promise<Ref> {
    const digest = await sha256Hex(bytes);
    const existing = this.db.exec('SELECT 1 FROM blobs WHERE digest = ?', [digest]);
    if (existing.length === 0) {
      this.db.run(
        'INSERT INTO blobs (digest, bytes, media_type, byte_length, created_at) VALUES (?, ?, ?, ?, ?)',
        [digest, bytes, mediaType, bytes.length, createdAt]
      );
    }
    return {
      kind: 'blob',
      id: digest,
      version: 1,
      digest,
      summary: `${mediaType}, ${bytes.length} bytes`
    };
  }

  getBlob(digest: string): { bytes: Uint8Array; mediaType: string } {
    const rows = this.db.exec(
      'SELECT bytes, media_type FROM blobs WHERE digest = ?',
      [digest]
    );
    if (rows.length === 0) {
      throw new CorruptionError(`缺少 blob 引用: ${digest.slice(0, 12)}…`, { digest });
    }
    const value = rows[0]!.values[0]![0];
    const mediaType = rows[0]!.values[0]![1] as string;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as number[]);
    return { bytes, mediaType };
  }

  listBlobs(): { digest: string; mediaType: string; byteLength: number }[] {
    const result = this.db.exec('SELECT digest, media_type, byte_length FROM blobs ORDER BY digest');
    if (result.length === 0) return [];
    return result[0]!.values.map((row) => ({
      digest: row[0] as string,
      mediaType: row[1] as string,
      byteLength: row[2] as number
    }));
  }

  async nextVersion(kind: EntityKind, id: string): Promise<number> {
    const rows = this.db.exec(
      'SELECT COALESCE(MAX(version), 0) FROM entity_versions WHERE kind = ? AND id = ?',
      [kind, id]
    );
    return Number(rows[0]!.values[0]![0]) + 1;
  }

  async addEntity(
    input: NewEntity,
    refs: Ref[] = [],
    createdAt: string = new Date().toISOString()
  ): Promise<Ref> {
    if (!ENTITY_KINDS.includes(input.kind) && input.kind !== ('series' as EntityKind)) {
      throw new Error(`未知实体类型: ${input.kind}`);
    }
    const version = await this.nextVersion(input.kind, input.id);
    const bodyWithRefs = { ...(input.body as object), [REF_KEY]: refs };
    const bodyJson = JSON.stringify(bodyWithRefs);
    const digest = await sha256Hex(bodyJson);
    this.db.run(
      `INSERT INTO entity_versions (kind, id, version, digest, body_json, summary, created_at, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.kind,
        input.id,
        version,
        digest,
        bodyJson,
        input.summary,
        input.createdAt ?? createdAt,
        input.branchId ?? null
      ]
    );
    for (const ref of refs) {
      this.assertRefExists(ref);
    }
    return {
      kind: input.kind,
      id: input.id,
      version,
      digest,
      summary: input.summary
    };
  }

  assertRefExists(ref: Ref): void {
    if (ref.kind === 'blob') {
      this.getBlob(ref.digest);
      return;
    }
    const rows = this.db.exec(
      'SELECT digest, summary FROM entity_versions WHERE kind = ? AND id = ? AND version = ?',
      [ref.kind, ref.id, ref.version]
    );
    if (rows.length === 0) {
      throw new CorruptionError(
        `缺少引用 ${ref.kind}/${ref.id}@v${ref.version}；拒绝回退到最新版`,
        ref
      );
    }
    const digest = rows[0]!.values[0]![0] as string;
    if (digest !== ref.digest) {
      throw new CorruptionError(
        `引用摘要不匹配 ${ref.kind}/${ref.id}@v${ref.version}：期望 ${ref.digest.slice(0, 10)}…，实际 ${digest.slice(0, 10)}…`,
        ref
      );
    }
  }

  getRef(ref: Ref): { body: EntityBody | Series; refs: Ref[]; createdAt: string } {
    const rows = this.db.exec(
      'SELECT body_json, created_at FROM entity_versions WHERE kind = ? AND id = ? AND version = ?',
      [ref.kind, ref.id, ref.version]
    );
    if (rows.length === 0) {
      throw new CorruptionError(
        `实体引用缺失 ${ref.kind}/${ref.id}@v${ref.version}；不允许退回当前最新版`,
        ref
      );
    }
    const bodyJson = rows[0]!.values[0]![0] as string;
    const createdAt = rows[0]!.values[0]![1] as string;
    const parsed = JSON.parse(bodyJson) as Record<string, unknown>;
    const digestMatches = sha256HexSyncPlaceholder(bodyJson) === null;
    void digestMatches;
    const storedDigestRows = this.db.exec(
      'SELECT digest FROM entity_versions WHERE kind = ? AND id = ? AND version = ?',
      [ref.kind, ref.id, ref.version]
    );
    const storedDigest = storedDigestRows[0]!.values[0]![0] as string;
    if (storedDigest !== ref.digest) {
      throw new CorruptionError(
        `实体摘要校验失败 ${ref.kind}/${ref.id}@v${ref.version}`,
        ref
      );
    }
    const refs = (parsed[REF_KEY] as Ref[] | undefined) ?? [];
    for (const inner of refs) this.assertRefExists(inner);
    delete parsed[REF_KEY];
    return { body: parsed as unknown as EntityBody | Series, refs, createdAt };
  }
