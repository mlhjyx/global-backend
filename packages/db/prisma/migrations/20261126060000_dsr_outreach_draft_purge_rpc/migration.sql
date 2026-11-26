-- Narrow SECURITY DEFINER RPC to purge lead_outreach_draft rows during
-- company-subject GDPR Art.17 DSR erasure while preserving app_user's
-- append-only (INSERT, SELECT) privilege manifest on public.lead_outreach_draft.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.purge_workspace_company_outreach_drafts_v1(
  p_workspace_id UUID,
  p_company_ids UUID[],
  p_deletion_request_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_req_ok INTEGER;
  v_deleted INTEGER;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_user IS NOT DISTINCT FROM session_user
     OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'DSR_OUTREACH_DRAFT_PURGE_DENIED'
      USING ERRCODE = '42501';
  END IF;

  IF p_workspace_id IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
     OR p_deletion_request_id IS NULL
  THEN
    RAISE EXCEPTION 'DSR_OUTREACH_DRAFT_PURGE_WORKSPACE_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  IF p_company_ids IS NULL
     OR COALESCE(array_length(p_company_ids, 1), 0) NOT BETWEEN 1 AND 100
  THEN
    RAISE EXCEPTION 'DSR_OUTREACH_DRAFT_PURGE_INVALID_SCOPE'
      USING ERRCODE = '22023';
  END IF;

  SELECT 1 INTO v_req_ok
  FROM public."deletion_request" dr
  WHERE dr."id" = p_deletion_request_id
    AND dr."workspace_id" = p_workspace_id
    AND dr."subject_type" = 'company'
    AND dr."status" IN ('FROZEN', 'ERASING')
    AND p_company_ids = ARRAY[dr."subject_id"];

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DSR_OUTREACH_DRAFT_PURGE_REQUEST_INVALID'
      USING ERRCODE = '42501';
  END IF;

  WITH deleted AS (
    DELETE FROM public."lead_outreach_draft" d
    USING public."lead" l
    WHERE d."workspace_id" = p_workspace_id
      AND l."workspace_id" = p_workspace_id
      AND d."lead_id" = l."id"
      AND l."canonical_company_id" = ANY(p_company_ids)
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_deleted FROM deleted;

  RETURN COALESCE(v_deleted, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.purge_workspace_company_outreach_drafts_v1(UUID, UUID[], UUID)
  FROM PUBLIC,
       app_user,
       execution_budget_platform_writer,
       runtime_api,
       runtime_worker,
       runtime_outbox_relay,
       runtime_platform_worker,
       runtime_outbox_relay_worker,
       runtime_memory_outbox_reader,
       runtime_customer_worker_ops;

GRANT EXECUTE ON FUNCTION public.purge_workspace_company_outreach_drafts_v1(UUID, UUID[], UUID)
  TO app_user;

COMMIT;
