-- Read-only authority/account attestation for post-admission workers. It keeps
-- time, revocation, scope and account checks without incrementing ref_count.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION attest_authorized_tool_budget_v1(
  p_scope_key TEXT,
  p_authority_id UUID,
  p_account_key TEXT
)
RETURNS TABLE(
  account_id UUID,
  generation INTEGER,
  authority_id UUID,
  authorized_cap_microusd BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  time_state TEXT;
BEGIN
  IF p_scope_key IS NOT DISTINCT FROM 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  END IF;

  IF p_authority_id IS NULL
    OR char_length(p_scope_key) NOT BETWEEN 1 AND 200
    OR char_length(p_account_key) NOT BETWEEN 1 AND 200
    OR (
      p_scope_key IS DISTINCT FROM 'platform'
      AND p_scope_key IS DISTINCT FROM current_workspace_id()::text
    )
    OR (
      p_scope_key IS DISTINCT FROM 'platform'
      AND EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles granted ON granted.oid = membership.roleid
        JOIN pg_roles member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = session_user
          AND granted.rolname = 'execution_budget_platform_writer'
      )
    )
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO authority
  FROM "execution_budget_authority"
  WHERE "scope_key" = p_scope_key AND "id" = p_authority_id;
  IF authority."id" IS NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  IF authority."revoked_at" IS NOT NULL OR EXISTS (
    SELECT 1
    FROM "execution_budget_authority_revocation" revocation
    WHERE revocation."scope_key" = authority."scope_key"
      AND revocation."authority_id" = authority."id"
  ) THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_REVOKED'
      USING ERRCODE = 'P0001';
  END IF;

  time_state := execution_budget_authority_time_state(
    authority."issued_at",
    authority."not_before",
    authority."expires_at",
    statement_timestamp()
  );
  IF time_state IN ('INVALID', 'NOT_YET_VALID') THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF time_state = 'EXPIRED' THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_EXPIRED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "scope_key" = p_scope_key AND "account_key" = p_account_key;
  IF account."id" IS NULL
    OR account."authority_id" IS DISTINCT FROM authority."id"
    OR account."authorized_cap_microusd" IS NULL
    OR account."authorized_cap_microusd" < 1
    OR account."cap_cents" IS DISTINCT FROM 0
    OR account."reserved_cents" IS DISTINCT FROM 0
    OR account."charged_cents" IS DISTINCT FROM 0
    OR account."ref_count" IS DISTINCT FROM 1
    OR account."closed_at" IS NOT NULL
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;
  IF account."exhausted" THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT
    account."id", account."generation", account."authority_id",
    account."authorized_cap_microusd";
END
$$;

REVOKE ALL ON FUNCTION
  attest_authorized_tool_budget_v1(TEXT, UUID, TEXT)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  attest_authorized_tool_budget_v1(TEXT, UUID, TEXT)
TO app_user, execution_budget_platform_writer;

COMMIT;
