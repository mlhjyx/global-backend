-- A08 联系人补强安全链：app_user 对三张预算表只有 SELECT，6 处锁语句需要受控行锁。
-- execution / _step 已有列级 UPDATE，原生 SELECT ... FOR UPDATE 合法，不迁入 definer。
-- 本迁移只新增 authority / account / operation 三个“纯锁不消费”函数；不加表级写权限。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION lock_contact_enrichment_authority_v1(
  p_workspace_id UUID,
  p_authority_id UUID
) RETURNS TABLE(
  id UUID,
  scope_key TEXT,
  revoked_at TIMESTAMPTZ,
  usable BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_authority_id IS NULL
     OR current_workspace_id() IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
     OR session_user IS DISTINCT FROM 'app_user'
     OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a."id", a."scope_key"::text, a."revoked_at",
      (a."revoked_at" IS NULL
        AND a."not_before" <= statement_timestamp()
        AND COALESCE(a."admission_lease_expires_at", a."expires_at") > statement_timestamp()) AS usable
      FROM public."execution_budget_authority" a
     WHERE a."scope_key" = p_workspace_id::text
       AND a."id" = p_authority_id
       AND a."authority_kind" = 'WORKSPACE_GRANT'
       AND a."purpose" IN ('contact.enrich', 'discovery.run')
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_contact_enrichment_authority_v1(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_contact_enrichment_authority_v1(UUID, UUID) TO app_user;

CREATE FUNCTION lock_contact_enrichment_account_v1(
  p_workspace_id UUID,
  p_authority_id UUID,
  p_account_key TEXT
) RETURNS TABLE(
  account_id UUID,
  scope_key TEXT,
  account_key TEXT,
  authority_id UUID,
  generation INTEGER,
  authorized_cap_microusd BIGINT,
  closed_at TIMESTAMPTZ,
  ref_count INTEGER
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_authority_id IS NULL
     OR current_workspace_id() IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
     OR session_user IS DISTINCT FROM 'app_user'
     OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none'
     OR NOT COALESCE(char_length(btrim(p_account_key)) BETWEEN 1 AND 200, false)
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a."id", a."scope_key"::text, a."account_key"::text, a."authority_id",
      a."generation", a."authorized_cap_microusd", a."closed_at", a."ref_count"
      FROM public."tool_budget_account" a
     WHERE a."scope_key" = p_workspace_id::text
       AND a."account_key" = p_account_key
       AND a."authority_id" = p_authority_id
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_contact_enrichment_account_v1(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_contact_enrichment_account_v1(UUID, UUID, TEXT) TO app_user;

CREATE FUNCTION lock_contact_enrichment_operation_v1(
  p_workspace_id UUID,
  p_account_id UUID,
  p_generation INTEGER,
  p_operation_key TEXT
) RETURNS TABLE(
  operation_id UUID,
  scope_key TEXT,
  account_id UUID,
  generation INTEGER,
  operation_key TEXT,
  status TEXT,
  amount_unit TEXT,
  reserved_microusd BIGINT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_account_id IS NULL
     OR p_generation IS NULL
     OR p_generation < 1
     OR current_workspace_id() IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
     OR session_user IS DISTINCT FROM 'app_user'
     OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none'
     OR NOT COALESCE(char_length(btrim(p_operation_key)) BETWEEN 1 AND 200, false)
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT o."id", o."scope_key"::text, o."account_id", o."generation",
      o."operation_key"::text, o."status"::text, o."amount_unit"::text, o."reserved_microusd"
      FROM public."tool_budget_operation" o
     WHERE o."scope_key" = p_workspace_id::text
       AND o."account_id" = p_account_id
       AND o."generation" = p_generation
       AND o."operation_key" = p_operation_key
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_contact_enrichment_operation_v1(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_contact_enrichment_operation_v1(UUID, UUID, INTEGER, TEXT) TO app_user;

COMMIT;
