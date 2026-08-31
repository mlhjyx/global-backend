BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION public.lock_execution_domain_ack_authority_first_v1(
  p_scope_key TEXT,
  p_authority_id UUID
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $authority_lock$
BEGIN
  PERFORM public.assert_execution_domain_ack_scope_v1(p_scope_key);
  IF p_authority_id IS NULL THEN
    RAISE EXCEPTION 'DOMAIN_ACK_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM 1 FROM public.execution_budget_authority authority
  WHERE authority.scope_key=p_scope_key AND authority.id=p_authority_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOMAIN_ACK_INVALID' USING ERRCODE='P0001';
  END IF;
END
$authority_lock$;

REVOKE ALL ON FUNCTION public.lock_execution_domain_ack_authority_first_v1(TEXT,UUID)
FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION public.lock_execution_domain_ack_authority_first_v1(TEXT,UUID)
TO app_user,execution_budget_platform_writer;
COMMIT;
