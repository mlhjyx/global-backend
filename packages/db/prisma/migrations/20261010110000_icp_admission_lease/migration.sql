-- ICP design and ICP query planning admission lease (product owner decision 2026-10-10:
-- 30 minutes, these two operations only).
--
-- On 2026-10-10 an ICP query plan failed with EXECUTION_BUDGET_GRANT_EXPIRED: one planning
-- model call of about 130 seconds and nine sequential taxonomy.normalize calls ran past the
-- Grant window (at most 5 minutes plus 60 seconds of tolerance), and the next reservation was
-- refused. ICP design is one model call of 130 to 185 seconds plus any repair call.
--
-- Admitting a WORKSPACE_GRANT for icp.design + company or icp.query_plan + icp now stamps
-- admission_lease_expires_at = consumed_at + 30 minutes. Discovery runs (discovery.run +
-- discovery_run) keep consumed_at + 3 hours (20261009170000); every other admission, and every
-- row admitted before this migration, keeps NULL and therefore its Grant window. attest already
-- judges expiry by COALESCE(admission_lease_expires_at, expires_at) with the same 60-second
-- tolerance and the same EXECUTION_BUDGET_GRANT_EXPIRED marker, so it is not redefined. The
-- Grant is still presented and admitted inside its window: consume and open keep checking it.
-- Revocation, scope, cap, exhaustion and single-holder checks are unchanged. No backfill.
--
-- The lease CHECK is replaced so each admitted pair is capped at its own duration; existing
-- rows are validated against it inside this transaction. consume is copied verbatim from
-- 20261009170000 apart from the two new CASE branches. CREATE OR REPLACE keeps its owner and
-- EXECUTE privileges but resets every other attribute, so LANGUAGE, SECURITY DEFINER and the
-- search_path are restated, with pg_temp last as every routine must list it since
-- 20261009160000_security_definer_search_path_pg_temp.
--
-- Deploy in name order, after 20261010090000 and 20261010100000, in the same window as the
-- image that carries this migration, with no discovery run or ICP request in flight.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "execution_budget_authority"
  DROP CONSTRAINT "execution_budget_authority_admission_lease_check",
  ADD CONSTRAINT "execution_budget_authority_admission_lease_check" CHECK (
    "admission_lease_expires_at" IS NULL
    OR (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND "consumed_at" IS NOT NULL
      AND "admission_lease_expires_at" > "expires_at"
      AND (
        (
          "purpose" = 'discovery.run'
          AND "subject_type" = 'discovery_run'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '3 hours'
        )
        OR (
          "purpose" = 'icp.design'
          AND "subject_type" = 'company'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
        )
        OR (
          "purpose" = 'icp.query_plan'
          AND "subject_type" = 'icp'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
        )
      )
    )
  );

COMMENT ON COLUMN "execution_budget_authority"."admission_lease_expires_at" IS
  'Post-admission validity of a WORKSPACE_GRANT: consumed_at + 3 hours for a discovery run (discovery.run, discovery_run), consumed_at + 30 minutes for ICP design (icp.design, company) and ICP query planning (icp.query_plan, icp). NULL keeps expires_at.';

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
      WHEN p_purpose = 'icp.design' AND p_subject_type = 'company'
        THEN admitted_at + INTERVAL '30 minutes'
      WHEN p_purpose = 'icp.query_plan' AND p_subject_type = 'icp'
        THEN admitted_at + INTERVAL '30 minutes'
    END
  ) RETURNING * INTO authority;

  RETURN QUERY SELECT authority."id", false;
END
$$;

COMMIT;
