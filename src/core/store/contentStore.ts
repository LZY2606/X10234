import { CorruptionError, type EntityRef } from '../../shared/domain';
import { canonicalJson, contentHash, entityId } from '../../shared/ids';
import type { Database } from '../db/database';

/**
 * 内容寻址存储：
 *  - blobs：不可变原始字节（共享片段只存一份）。
 *  - entities：版本化实体，身份 = 种类+内容哈希，导出/重导入后稳定。
 */
export class ContentStore {
  constructor(private readonly db: Database) {}

  putBlob(bytes: Uint8Array, mediaType: string): string {
    const hash = contentHash(bytes);
    this.db.run(
      'INSERT OR IGNORE INTO blobs(hash, media_type, bytes) VALUES (?, ?, ?)',
      hash,
      mediaType,
      Buffer.from(bytes),
    );
    return hash;
  }

  getBlob(hash: string): Uint8Array {
    const row = this.db.get<{ bytes: Uint8Array }>('SELECT bytes FROM blobs WHERE hash = ?', hash);
    if (!row) {
      throw new CorruptionError(`缺少 blob 引用: ${hash}`, [
        { entityKind: 'blob', entityId: hash, version: 0, contentHash: hash },
      ]);
    }
    return new Uint8Array(row.bytes);
  }

  hasBlob(hash: string): boolean {
    return !!this.db.get('SELECT hash FROM blobs WHERE hash = ?', hash);
  }

  /** 写入实体的一个新版本；相同内容返回既有版本（幂等，身份稳定）。 */
  putEntity<T>(kind: string, id: string, body: T): EntityRef {
    const json = canonicalJson(body);
    const hash = contentHash(json);
    const existing = this.db.get<{ version: number; content_hash: string }>(
      'SELECT version, content_hash FROM entities WHERE entity_kind = ? AND entity_id = ? ORDER BY version DESC LIMIT 1',
      kind,
      id,
    );
    if (existing && existing.content_hash === hash) {
      return { entityKind: kind, entityId: id, version: existing.version, contentHash: hash };
    }
    const version = existing ? existing.version + 1 : 1;
    this.db.run(
      'INSERT INTO entities(entity_kind, entity_id, version, content_hash, body) VALUES (?, ?, ?, ?, ?)',
      kind,
      id,
      version,
      hash,
      json,
    );
    return { entityKind: kind, entityId: id, version, contentHash: hash };
  }

  /** 读取实体；version 缺省取最新，显式版本绝不回退到“当前最新版”。 */
  getEntity<T>(kind: string, id: string, version?: number): { ref: EntityRef; body: T } {
    const row = version === undefined
      ? this.db.get<{ version: number; content_hash: string; body: string }>(
          'SELECT version, content_hash, body FROM entities WHERE entity_kind = ? AND entity_id = ? ORDER BY version DESC LIMIT 1',
          kind,
          id,
        )
      : this.db.get<{ version: number; content_hash: string; body: string }>(
          'SELECT version, content_hash, body FROM entities WHERE entity_kind = ? AND entity_id = ? AND version = ?',
          kind,
          id,
          version,
        );
    if (!row) {
      throw new CorruptionError(`缺少实体引用: ${kind}/${id}${version !== undefined ? `@v${version}` : ''}`, [
        { entityKind: kind, entityId: id, version: version ?? -1, contentHash: '' },
      ]);
    }
    return {
      ref: { entityKind: kind, entityId: id, version: row.version, contentHash: row.content_hash },
      body: JSON.parse(row.body) as T,
    };
  }

  hasEntity(kind: string, id: string): boolean {
    return !!this.db.get('SELECT 1 AS x FROM entities WHERE entity_kind = ? AND entity_id = ? LIMIT 1', kind, id);
  }

  listEntities(kind: string): Array<{ entityId: string; version: number; contentHash: string }> {
    return this.db.all<{ entity_id: string; version: number; content_hash: string }>(
      `SELECT e.entity_id, e.version, e.content_hash FROM entities e
       JOIN (SELECT entity_id, MAX(version) AS mv FROM entities WHERE entity_kind = ? GROUP BY entity_id) m
         ON e.entity_id = m.entity_id AND e.version = m.mv
       WHERE e.entity_kind = ? ORDER BY e.entity_id`,
      kind,
      kind,
    ).map((r) => ({ entityId: r.entity_id, version: r.version, contentHash: r.content_hash }));
  }

  allEntityRows(): Array<{ kind: string; id: string; version: number; hash: string; body: string }> {
    return this.db.all<{ entity_kind: string; entity_id: string; version: number; content_hash: string; body: string }>(
      'SELECT entity_kind, entity_id, version, content_hash, body FROM entities ORDER BY entity_kind, entity_id, version',
    ).map((r) => ({ kind: r.entity_kind, id: r.entity_id, version: r.version, hash: r.content_hash, body: r.body }));
  }
}

export { entityId, canonicalJson, contentHash };
