BEGIN;
SET LOCAL lock_timeout = '5s';

-- Build indexes after the transaction that adds columns has released its table lock.
CREATE UNIQUE INDEX dcj_contact_enrichment_operation_ref_key
  ON public.discovery_company_job (workspace_id, contact_enrichment_operation_ref);

CREATE INDEX dcj_contact_enrichment_list_idx
  ON public.discovery_company_job (workspace_id, canonical_company_id, contact_enrichment_started_at, id);

COMMIT;
