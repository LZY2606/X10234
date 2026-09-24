-- schema_version = 2：为实体版本增加 provenance 来源标记（迁移测试使用）
ALTER TABLE entity_versions ADD COLUMN origin_event_id TEXT;
