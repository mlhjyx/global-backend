BEGIN;
SET LOCAL lock_timeout = '5s';

-- Existing jobs keep NULL fields. The new checks apply to writes immediately.
ALTER TABLE public.discovery_company_job
  ADD COLUMN contact_enrichment_operation_ref VARCHAR(64),
  ADD COLUMN contact_enrichment_started_at TIMESTAMPTZ(3),
  ADD COLUMN contact_enrichment_status VARCHAR(16),
  ADD COLUMN streaming_l2_contacts_created INTEGER,
  ADD CONSTRAINT dcj_contact_enrichment_claim_check CHECK (
    (contact_enrichment_operation_ref IS NULL AND contact_enrichment_started_at IS NULL
      AND contact_enrichment_status IS NULL)
    OR
    (contact_enrichment_operation_ref IS NOT NULL AND contact_enrichment_operation_ref ~ '^[0-9a-f]{64}$'
      AND contact_enrichment_started_at IS NOT NULL AND contact_enrichment_status IS NOT NULL
      AND contact_enrichment_status IN ('APPLY_PENDING', 'COMPLETED', 'RATE_LIMITED'))
  ) NOT VALID,
  ADD CONSTRAINT dcj_streaming_l2_contacts_nonnegative
    CHECK (streaming_l2_contacts_created >= 0) NOT VALID;

COMMIT;
