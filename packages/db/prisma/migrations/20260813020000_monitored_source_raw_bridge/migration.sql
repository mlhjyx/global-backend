-- Monitoring snapshots are platform-owned and have no DiscoveryRun. Give each
-- tenant projection a first-class RawSourceRecord origin instead of storing a
-- SourceEntity id in identity_link.raw_record_id.
ALTER TABLE "raw_source_record"
  ADD CONSTRAINT "raw_source_record_exactly_one_origin_check"
  CHECK (
    ("run_id" IS NOT NULL AND "source_entity_id" IS NULL)
    OR
    ("run_id" IS NULL AND "source_entity_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "raw_source_record_workspace_source_entity_ingest_key"
  UNIQUE ("workspace_id", "source_entity_id", "ingest_key");
