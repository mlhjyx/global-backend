-- A quality-loop refurbish run (Temporal patch site-builder-m1f-quality-loop-v1, which every new
-- run takes) publishes only after reading its build budget under a row lock, so a concurrent
-- settlement cannot change the budget's state or reason between the check and the publication
-- (apps/api/src/temporal/site-builder.activities.ts, finalizeRefurbish). The step runs as
-- app_user, and since 20260816220000_production_parity_budget_runtime app_user holds only SELECT
-- on site_build_budget: every row lock needs UPDATE privilege, so the statement was refused with
-- "permission denied for table site_build_budget" whether or not a row matched, and no
-- quality-loop run could finish.
--
-- Budget rows change only through owner routines that check the workspace and then lock the row
-- (reserve_site_build_spend, settle_site_build_spend, ...). This adds one more of the same kind:
-- it checks the caller's workspace, takes the same FOR UPDATE lock as the owner and returns the
-- two fields the publication check reads. A row lock lasts until the end of the transaction, so
-- the caller's publication is serialized with settlement as the statement was designed to be.
-- app_user's table privileges do not change. Forward-only; no data is touched.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.lock_site_build_budget_for_publication(
  p_workspace_id UUID,
  p_build_run_id UUID
)
RETURNS TABLE(paid_calls_enabled BOOLEAN, disabled_reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  RETURN QUERY
  SELECT budget."paid_calls_enabled", budget."disabled_reason"
  FROM public."site_build_budget" budget
  WHERE budget."build_run_id" = p_build_run_id
    AND budget."workspace_id" = p_workspace_id
  FOR UPDATE;
END
$$;

REVOKE ALL ON FUNCTION public.lock_site_build_budget_for_publication(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_site_build_budget_for_publication(UUID, UUID) TO app_user;

COMMIT;
