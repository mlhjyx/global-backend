-- A08 联系人补强安全链：app_user 对执行预算与安全切片表只有 SELECT/INSERT（部分列 UPDATE），
-- 13 处 SELECT ... FOR UPDATE 需要受控行锁。app_user 不获表级 UPDATE；锁由 SECURITY DEFINER
-- 窄函数完成：校验参数 workspace 等于 current_workspace_id()，只锁同 workspace 行并返回调用方所需列。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION lock_enrichment_authority_v1(
  p_workspace_id UUID,
  p_authority_id UUID
) RETURNS TABLE(
  id TEXT,
  scope_key TEXT,
  revoked_at TIMESTAMPTZ,
  usable BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_authority_id IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'ENRICHMENT_AUTHORITY_LOCK_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a."id"::text, a."scope_key"::text, a."revoked_at",
      (a."revoked_at" IS NULL
        AND a."not_before" <= statement_timestamp()
        AND COALESCE(a."admission_lease_expires_at", a."expires_at") > statement_timestamp()) AS usable
      FROM public."execution_budget_authority" a
     WHERE a."scope_key" = p_workspace_id::text
       AND a."id" = p_authority_id
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_enrichment_authority_v1(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_enrichment_authority_v1(UUID, UUID) TO app_user;

CREATE FUNCTION lock_enrichment_account_v1(
  p_workspace_id UUID,
  p_account_id UUID,
  p_account_key TEXT
) RETURNS TABLE(
  account_id TEXT,
  scope_key TEXT,
  account_key TEXT,
  authority_id TEXT,
  generation INTEGER,
  authorized_cap_microusd BIGINT,
  closed_at TIMESTAMPTZ,
  ref_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
     OR (p_account_id IS NULL) = (p_account_key IS NULL)
     OR NOT COALESCE(char_length(btrim(p_account_key)) BETWEEN 1 AND 200, true)
  THEN
    RAISE EXCEPTION 'ENRICHMENT_ACCOUNT_LOCK_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a."id"::text, a."scope_key"::text, a."account_key"::text,
      a."authority_id"::text, a."generation", a."authorized_cap_microusd",
      a."closed_at", a."ref_count"
      FROM public."tool_budget_account" a
     WHERE a."scope_key" = p_workspace_id::text
       AND ((p_account_id IS NOT NULL AND a."id" = p_account_id)
         OR (p_account_key IS NOT NULL AND a."account_key" = p_account_key))
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_enrichment_account_v1(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_enrichment_account_v1(UUID, UUID, TEXT) TO app_user;

CREATE FUNCTION lock_enrichment_operation_v1(
  p_workspace_id UUID,
  p_account_id UUID,
  p_generation INTEGER,
  p_operation_key TEXT
) RETURNS TABLE(
  operation_id TEXT,
  scope_key TEXT,
  account_id TEXT,
  generation INTEGER,
  operation_key TEXT,
  status TEXT,
  amount_unit TEXT,
  reserved_microusd BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_account_id IS NULL
     OR p_generation IS NULL
     OR NOT COALESCE(char_length(btrim(p_operation_key)) BETWEEN 1 AND 256, false)
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'ENRICHMENT_OPERATION_LOCK_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT o."id"::text, o."scope_key"::text, o."account_id"::text, o."generation",
      o."operation_key"::text, o."status"::text, o."amount_unit"::text, o."reserved_microusd"
      FROM public."tool_budget_operation" o
     WHERE o."scope_key" = p_workspace_id::text
       AND o."account_id" = p_account_id
       AND o."generation" = p_generation
       AND o."operation_key" = p_operation_key
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_enrichment_operation_v1(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_enrichment_operation_v1(UUID, UUID, INTEGER, TEXT) TO app_user;

CREATE FUNCTION lock_enrichment_execution_v1(
  p_workspace_id UUID,
  p_execution_id UUID,
  p_company_id UUID
) RETURNS TABLE(
  id TEXT,
  workspace_id TEXT,
  company_id TEXT,
  authority_id TEXT,
  account_id TEXT,
  generation INTEGER,
  entrypoint TEXT,
  business_run_id TEXT,
  status TEXT,
  frozen_limits JSONB,
  target_snapshot JSONB,
  result_snapshot JSONB,
  result_revision INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_execution_id IS NULL
     OR p_company_id IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'ENRICHMENT_EXECUTION_LOCK_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT e."id"::text, e."workspace_id"::text, e."company_id"::text,
      e."authority_id"::text, e."account_id"::text, e."generation", e."entrypoint"::text,
      e."business_run_id"::text, e."status"::text, e."frozen_limits",
      e."target_snapshot", e."result_snapshot", e."result_revision"
      FROM public."contact_enrichment_execution" e
     WHERE e."workspace_id" = p_workspace_id
       AND e."id" = p_execution_id
       AND e."company_id" = p_company_id
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_enrichment_execution_v1(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_enrichment_execution_v1(UUID, UUID, UUID) TO app_user;

CREATE FUNCTION lock_enrichment_execution_by_request_v1(
  p_workspace_id UUID,
  p_company_id UUID,
  p_request_sha256 TEXT,
  p_entrypoint TEXT,
  p_business_run_id UUID,
  p_authority_id UUID,
  p_account_id UUID,
  p_generation INTEGER
) RETURNS TABLE(
  id TEXT,
  workspace_id TEXT,
  company_id TEXT,
  authority_id TEXT,
  account_id TEXT,
  generation INTEGER,
  request_sha256 TEXT,
  admission_request_sha256 TEXT,
  operation_ref TEXT,
  plan_sha256 TEXT,
  status TEXT,
  entrypoint TEXT,
  business_run_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_company_id IS NULL
     OR NOT COALESCE(p_request_sha256 ~ '^[0-9a-f]{64}$', false)
     OR p_entrypoint IS NULL
     OR p_authority_id IS NULL
     OR p_account_id IS NULL
     OR p_generation IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'ENRICHMENT_EXECUTION_LOCK_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT e."id"::text, e."workspace_id"::text, e."company_id"::text,
      e."authority_id"::text, e."account_id"::text, e."generation",
      e."request_sha256"::text, e."admission_request_sha256"::text,
      e."operation_ref"::text, e."plan_sha256"::text, e."status"::text,
      e."entrypoint"::text, e."business_run_id"::text
      FROM public."contact_enrichment_execution" e
     WHERE e."workspace_id" = p_workspace_id
       AND e."company_id" = p_company_id
       AND e."request_sha256" = p_request_sha256
       AND e."entrypoint" = p_entrypoint
       AND e."business_run_id" IS NOT DISTINCT FROM p_business_run_id
       AND e."authority_id" = p_authority_id
       AND e."account_id" = p_account_id
       AND e."generation" = p_generation
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_enrichment_execution_by_request_v1(UUID, UUID, TEXT, TEXT, UUID, UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_enrichment_execution_by_request_v1(UUID, UUID, TEXT, TEXT, UUID, UUID, UUID, INTEGER) TO app_user;

CREATE FUNCTION lock_enrichment_step_v1(
  p_workspace_id UUID,
  p_execution_id UUID,
  p_step_id UUID,
  p_contact_id UUID
) RETURNS TABLE(
  id TEXT,
  contact_id TEXT,
  contact_ordinal INTEGER,
  slot_key TEXT,
  phase TEXT,
  provider TEXT,
  tool_id TEXT,
  tool_version TEXT,
  pricing_version TEXT,
  depends_on_slot_key TEXT,
  quote_microusd BIGINT,
  dispatch_phase TEXT,
  domain_state TEXT,
  budget_operation_id TEXT,
  input_fingerprint TEXT,
  operation_key TEXT,
  candidate_ref JSONB,
  revision INTEGER,
  result_digest TEXT,
  receipt JSONB,
  artifact_reference JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_execution_id IS NULL
     OR (p_step_id IS NULL) = (p_contact_id IS NULL)
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'ENRICHMENT_STEP_LOCK_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT s."id"::text, s."contact_id"::text, s."contact_ordinal", s."slot_key"::text,
      s."phase"::text, s."provider"::text, s."tool_id"::text, s."tool_version"::text,
      s."pricing_version"::text, s."depends_on_slot_key"::text, s."quote_microusd",
      s."dispatch_phase"::text, s."domain_state"::text, s."budget_operation_id"::text,
      s."input_fingerprint"::text, s."operation_key"::text, s."candidate_ref", s."revision",
      s."result_digest"::text, s."receipt", s."artifact_reference"
      FROM public."contact_enrichment_execution_step" s
     WHERE s."workspace_id" = p_workspace_id
       AND s."execution_id" = p_execution_id
       AND (p_step_id IS NULL OR s."id" = p_step_id)
       AND (p_contact_id IS NULL OR s."contact_id" = p_contact_id)
     FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION lock_enrichment_step_v1(UUID, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_enrichment_step_v1(UUID, UUID, UUID, UUID) TO app_user;

CREATE FUNCTION lock_enrichment_execution_step_anchor_v1(
  p_workspace_id UUID,
  p_company_id UUID,
  p_step_id UUID
) RETURNS TABLE(
  execution_id TEXT,
  step_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_workspace_id IS NULL
     OR p_company_id IS NULL
     OR p_step_id IS NULL
     OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'ENRICHMENT_ANCHOR_LOCK_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT e."id"::text AS execution_id, s."id"::text AS step_id
      FROM public."contact_enrichment_execution" e
      JOIN public."contact_enrichment_execution_step" s
        ON s."workspace_id" = e."workspace_id" AND s."execution_id" = e."id"
     WHERE e."workspace_id" = p_workspace_id
       AND e."company_id" = p_company_id
       AND s."id" = p_step_id
     FOR UPDATE OF e, s;
END;
$$;
REVOKE ALL ON FUNCTION lock_enrichment_execution_step_anchor_v1(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_enrichment_execution_step_anchor_v1(UUID, UUID, UUID) TO app_user;

COMMIT;
