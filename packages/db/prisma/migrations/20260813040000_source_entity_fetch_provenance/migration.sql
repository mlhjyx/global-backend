-- Each source_entity observation must point to the exact fetch that saw it.
-- The column remains nullable because legacy rows without provable provenance
-- must fail closed at projection time rather than borrow a later fetch.
ALTER TABLE "source_entity"
  ADD COLUMN "last_seen_fetch_id" UUID;

ALTER TABLE "source_fetch"
  ADD CONSTRAINT "source_fetch_id_source_id_key" UNIQUE ("id", "source_id");

-- A legacy row is backfilled only when exactly one completed, parser-versioned
-- fetch from the same source has the exact application-assigned observation time.
WITH provable AS (
  SELECT se."id" AS entity_id, MIN(sf."id"::text)::uuid AS fetch_id
  FROM "source_entity" se
  JOIN "source_fetch" sf
    ON sf."source_id" = se."source_id"
   AND sf."finished_at" = se."last_seen_at"
   AND sf."status" IN ('DONE', 'PARTIAL')
   AND sf."parser_version" IS NOT NULL
  GROUP BY se."id"
  HAVING COUNT(*) = 1
)
UPDATE "source_entity" se
SET "last_seen_fetch_id" = provable.fetch_id
FROM provable
WHERE se."id" = provable.entity_id;

ALTER TABLE "source_entity"
  ADD CONSTRAINT "source_entity_last_seen_fetch_fkey"
  FOREIGN KEY ("last_seen_fetch_id", "source_id")
  REFERENCES "source_fetch"("id", "source_id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE INDEX "source_entity_last_seen_fetch_idx"
  ON "source_entity"("last_seen_fetch_id");

-- Replaying an already active identity link may need to repair missing
-- materialization. One Raw observation contributes at most one value per field
-- to the same canonical company. Existing duplicates are not silently deleted:
-- deployment fails closed for manual review if they exist.
ALTER TABLE "field_evidence"
  ADD CONSTRAINT "field_evidence_raw_field_unique"
  UNIQUE ("workspace_id", "entity_type", "entity_id", "field", "raw_record_id");
