-- L1 delivery loop (design 2026-10-10 §8): the page a field's fact came from.
--
-- The enrichment commit already holds provenance.sourceUrl in memory when it writes its
-- evidence rows, and materialized evidence can join raw_source_record; both used to drop the
-- URL. A nullable column keeps historical rows valid (they fall back to the raw-record join
-- when read). https only, bounded — the writers validate the same before writing.
--
-- Additive, no backfill. Deploy in name order, in the same window as the image that carries
-- this migration. Rollback: a later migration that drops the column (the CHECK goes with it).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "field_evidence" ADD COLUMN "source_url" TEXT;

-- NOT VALID: every row written from now on is checked, and the deploy window does not scan
-- (and lock) the existing table; the column was just added, so old rows are all NULL anyway.
ALTER TABLE "field_evidence" ADD CONSTRAINT "field_evidence_source_url_check" CHECK ("source_url" IS NULL OR ("source_url" LIKE 'https://%' AND char_length("source_url") <= 2048)) NOT VALID;

COMMIT;
