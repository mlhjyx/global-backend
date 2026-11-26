BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.discovery_company_job
  VALIDATE CONSTRAINT dcj_contact_enrichment_claim_check,
  VALIDATE CONSTRAINT dcj_streaming_l2_contacts_nonnegative;

COMMIT;
