-- Streaming L2 claims remain scoped to the existing RLS-protected run/company job.
-- Existing jobs keep NULL fields, and run/workspace erasure retains its existing cascades.
ALTER TABLE "discovery_company_job"
  ADD COLUMN "contact_enrichment_operation_ref" VARCHAR(64),
  ADD COLUMN "contact_enrichment_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "contact_enrichment_status" VARCHAR(16),
  ADD CONSTRAINT "dcj_contact_enrichment_claim_check" CHECK (
    ("contact_enrichment_operation_ref" IS NULL AND "contact_enrichment_started_at" IS NULL
      AND "contact_enrichment_status" IS NULL)
    OR
    ("contact_enrichment_operation_ref" IS NOT NULL AND "contact_enrichment_operation_ref" ~ '^[0-9a-f]{64}$'
      AND "contact_enrichment_started_at" IS NOT NULL AND "contact_enrichment_status" IS NOT NULL
      AND "contact_enrichment_status" IN ('APPLY_PENDING', 'COMPLETED', 'RATE_LIMITED'))
  );

CREATE UNIQUE INDEX "dcj_contact_enrichment_operation_ref_key"
  ON "discovery_company_job" ("workspace_id", "contact_enrichment_operation_ref");

CREATE INDEX "dcj_contact_enrichment_list_idx"
  ON "discovery_company_job" ("workspace_id", "canonical_company_id", "contact_enrichment_started_at", "id");
