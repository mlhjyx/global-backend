-- Enumerate workspaces containing stale pending_upload seller_document rows
-- via a narrow app_user-callable SECURITY DEFINER RPC. runtime_customer_worker_ops
-- remains explicitly forbidden from public.seller_document.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.list_stale_pending_seller_document_workspaces_v1(
  p_older_than_hours INTEGER,
  p_limit INTEGER,
  p_after_workspace_id UUID DEFAULT NULL
)
RETURNS TABLE(workspace_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_older_than_hours IS NULL
    OR p_older_than_hours NOT BETWEEN 1 AND 720
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'SELLER_DOCUMENT_PENDING_CLEANUP_LIST_DENIED'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT d."workspace_id"
  FROM public."seller_document" AS d
  WHERE d."status" = 'pending_upload'
    AND d."deleted_at" IS NULL
    AND d."created_at" <= statement_timestamp() - make_interval(hours => p_older_than_hours)
    AND (p_after_workspace_id IS NULL OR d."workspace_id" > p_after_workspace_id)
  ORDER BY d."workspace_id" ASC
  LIMIT p_limit;
END
$$;

REVOKE ALL ON FUNCTION
  public.list_stale_pending_seller_document_workspaces_v1(INTEGER, INTEGER, UUID)
FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_customer_worker_ops;

GRANT EXECUTE ON FUNCTION
  public.list_stale_pending_seller_document_workspaces_v1(INTEGER, INTEGER, UUID)
TO app_user;

COMMIT;
