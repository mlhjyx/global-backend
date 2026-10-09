-- Discovery run admission lease (product owner decision 2026-10-09: 3 hours,
-- discovery runs only).
--
-- A Grant is still presented and admitted inside its window of at most 5
-- minutes; consume and open keep checking that window. Admitting a discovery
-- run (WORKSPACE_GRANT, purpose discovery.run, subject_type discovery_run) also
-- stamps admission_lease_expires_at = consumed_at + 3 hours, and post-admission
-- attest judges expiry by COALESCE(admission_lease_expires_at, expires_at) with
-- the same 60-second tolerance and the same EXECUTION_BUDGET_GRANT_EXPIRED
-- marker. Every other authority, and every row admitted before this migration,
-- keeps NULL and therefore its Grant window. Revocation, scope, cap, exhaustion
-- and single-holder checks are unchanged. No backfill.
--
-- CREATE OR REPLACE keeps each function's owner and EXECUTE privileges but
-- resets every other attribute, so LANGUAGE, STABLE (attest), SECURITY DEFINER
-- and search_path are restated. Both bodies are copied verbatim from
-- 20260821090000 (consume) and 20260822203000 (attest) apart from the lease
-- lines. search_path lists pg_temp last, as every SECURITY DEFINER routine must
-- since 20261009160000_security_definer_search_path_pg_temp: a session temporary
-- table can then never shadow a table these functions read, and restating the
-- old "pg_catalog, public" here would undo that hardening.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "execution_budget_authority"
  ADD COLUMN "admission_lease_expires_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "execution_budget_authority_admission_lease_check" CHECK (
    "admission_lease_expires_at" IS NULL
    OR (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND "purpose" = 'discovery.run'
      AND "subject_type" = 'discovery_run'
      AND "consumed_at" IS NOT NULL
      AND "admission_lease_expires_at" > "expires_at"
      AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '3 hours'
    )
  );

COMMENT ON COLUMN "execution_budget_authority"."admission_lease_expires_at" IS
  'Post-admission validity of a discovery run (WORKSPACE_GRANT, discovery.run, discovery_run): consumed_at + 3 hours. NULL keeps expires_at.';

CREATE OR REPLACE FUNCTION consume_workspace_execution_authority(
  p_issuer TEXT,
  p_audience TEXT,
  p_jti UUID,
  p_token_sha256 TEXT,
  p_schema_version TEXT,
  p_purpose "execution_budget_purpose",
  p_workspace_id UUID,
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_request_sha256 TEXT,
  p_currency TEXT,
  p_unit TEXT,
  p_cap_microusd BIGINT,
  p_issued_at TIMESTAMPTZ,
  p_not_before TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE(authority_id UUID, replay BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  time_state TEXT;
  admitted_at TIMESTAMPTZ;
BEGIN
  IF p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR NOT COALESCE(char_length(btrim(p_issuer)) BETWEEN 1 AND 512, false)
    OR p_audience IS DISTINCT FROM 'global-backend:execution-budget'
    OR p_jti IS NULL
    OR NOT COALESCE(p_token_sha256 ~ '^[0-9a-f]{64}$', false)
    OR p_schema_version IS DISTINCT FROM 'execution-budget-grant/v1'
    OR NOT COALESCE(char_length(btrim(p_subject_type)) BETWEEN 1 AND 191, false)
    OR NOT COALESCE(char_length(btrim(p_subject_id)) BETWEEN 1 AND 191, false)
    OR NOT COALESCE(p_request_sha256 ~ '^[0-9a-f]{64}$', false)
    OR p_currency IS DISTINCT FROM 'USD'
    OR p_unit IS DISTINCT FROM 'microusd'
    OR NOT COALESCE(p_cap_microusd > 0, false)
    OR p_issued_at IS NULL
    OR p_not_before IS NULL
    OR p_expires_at IS NULL
    OR NOT COALESCE(p_issued_at <= p_not_before, false)
    OR NOT COALESCE(p_not_before < p_expires_at, false)
    OR NOT COALESCE(
      p_expires_at - p_issued_at <= INTERVAL '5 minutes',
      false
    )
    OR NOT COALESCE((
      (p_purpose = 'understanding.run' AND p_subject_type = 'company')
      OR (p_purpose = 'icp.design' AND p_subject_type = 'company')
      OR (p_purpose = 'icp.query_plan' AND p_subject_type = 'icp')
      OR (
        p_purpose = 'discovery.run'
        AND p_subject_type IN ('discovery_run', 'company')
      )
      OR (p_purpose = 'contact.verify' AND p_subject_type = 'contact_point')
    ), false)
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('execution-budget-jti:' || p_issuer || ':' || p_jti::text, 0)
  );
  SELECT * INTO authority
  FROM "execution_budget_authority"
  WHERE "issuer" = p_issuer AND "jti" = p_jti
  FOR UPDATE;

  IF authority."id" IS NOT NULL THEN
    IF authority."authority_kind" IS DISTINCT FROM 'WORKSPACE_GRANT'
      OR authority."scope_key" IS DISTINCT FROM p_workspace_id::text
      OR authority."audience" IS DISTINCT FROM p_audience
      OR authority."token_sha256" IS DISTINCT FROM p_token_sha256
      OR authority."schema_version" IS DISTINCT FROM p_schema_version
      OR authority."purpose" IS DISTINCT FROM p_purpose
      OR authority."workspace_id" IS DISTINCT FROM p_workspace_id
      OR authority."subject_type" IS DISTINCT FROM p_subject_type
      OR authority."subject_id" IS DISTINCT FROM p_subject_id
      OR authority."request_sha256" IS DISTINCT FROM p_request_sha256
      OR authority."schedule_id" IS NOT NULL
      OR authority."currency" IS DISTINCT FROM p_currency
      OR authority."unit" IS DISTINCT FROM p_unit
      OR authority."cap_microusd" IS DISTINCT FROM p_cap_microusd
      OR authority."cap_per_run_microusd" IS NOT NULL
      OR authority."campaign_cap_microusd" IS NOT NULL
      OR authority."max_runs" IS NOT NULL
      OR authority."issued_at" IS DISTINCT FROM p_issued_at
      OR authority."not_before" IS DISTINCT FROM p_not_before
      OR authority."expires_at" IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT authority."id", true;
    RETURN;
  END IF;

  time_state := execution_budget_authority_time_state(
    p_issued_at,
    p_not_before,
    p_expires_at,
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

  admitted_at := clock_timestamp();
  INSERT INTO "execution_budget_authority"(
    "scope_key", "authority_kind", "workspace_id", "issuer", "audience",
    "jti", "token_sha256", "schema_version", "purpose", "subject_type",
    "subject_id", "request_sha256", "currency", "unit", "cap_microusd",
    "issued_at", "not_before", "expires_at", "consumed_at",
    "admission_lease_expires_at"
  ) VALUES (
    p_workspace_id::text, 'WORKSPACE_GRANT', p_workspace_id, p_issuer,
    p_audience, p_jti, p_token_sha256, p_schema_version, p_purpose,
    p_subject_type, p_subject_id, p_request_sha256, p_currency, p_unit,
    p_cap_microusd, p_issued_at, p_not_before, p_expires_at, admitted_at,
    CASE
      WHEN p_purpose = 'discovery.run' AND p_subject_type = 'discovery_run'
        THEN admitted_at + INTERVAL '3 hours'
    END
  ) RETURNING * INTO authority;

  RETURN QUERY SELECT authority."id", false;
END
$$;

CREATE OR REPLACE FUNCTION attest_authorized_tool_budget_v1(
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
SET search_path = pg_catalog, public, pg_temp
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
    COALESCE(authority."admission_lease_expires_at", authority."expires_at"),
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

COMMIT;
