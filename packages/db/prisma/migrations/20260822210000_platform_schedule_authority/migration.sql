-- Atomic schedule admission. The authenticated platform writer either opens
-- one fresh run or read-only attests the already-admitted run after an ACK
-- loss. Retrying admission must never increment tool_budget_account.ref_count.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION admit_platform_execution_budget_run_v1(
  p_purpose "execution_budget_purpose",
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_schedule_id TEXT,
  p_request_sha256 TEXT,
  p_workflow_run_id TEXT,
  p_account_key TEXT
)
RETURNS TABLE(
  account_id UUID,
  generation INTEGER,
  authority_id UUID,
  authorized_cap_microusd BIGINT,
  campaign_cap_microusd BIGINT,
  max_runs BIGINT,
  replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  opened RECORD;
  time_state TEXT;
  campaign_remaining NUMERIC;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_purpose NOT IN (
      'platform.acquisition'::"execution_budget_purpose",
      'platform.intent_watch'::"execution_budget_purpose",
      'platform.sanctions'::"execution_budget_purpose"
    )
    OR p_subject_type IS DISTINCT FROM 'schedule'
    OR p_subject_id IS DISTINCT FROM p_schedule_id
    OR char_length(p_schedule_id) NOT BETWEEN 1 AND 191
    OR NOT COALESCE(p_request_sha256 ~ '^[0-9a-f]{64}$', false)
    OR char_length(p_workflow_run_id) NOT BETWEEN 1 AND 100
    OR p_workflow_run_id ~ '[[:cntrl:]]'
    OR p_account_key IS DISTINCT FROM
      'platform:' || p_request_sha256 || ':' || p_workflow_run_id
    OR char_length(p_account_key) NOT BETWEEN 1 AND 200
    OR NOT (
      (
        p_purpose = 'platform.acquisition'::"execution_budget_purpose"
        AND p_schedule_id = 'acq-sweep'
        AND p_request_sha256 =
          '5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e'
      )
      OR (
        p_purpose = 'platform.intent_watch'::"execution_budget_purpose"
        AND p_schedule_id = 'intent-sweep'
        AND p_request_sha256 =
          '9ef4afce408c36472e00db01a80b6e3a3e461a2b13af7f456d9ce31a7676c34a'
      )
      OR (
        p_purpose = 'platform.sanctions'::"execution_budget_purpose"
        AND p_schedule_id = 'sanctions-refresh'
        AND p_request_sha256 =
          '50b8dfae274bb16a825147c648f46789ea0eb291b3d32964c8bacf385340dffe'
      )
      OR (
        p_purpose = 'platform.acquisition'::"execution_budget_purpose"
        AND p_schedule_id = 'patents-cache-refresh'
        AND p_request_sha256 =
          '3fbcd9326937d66243f1395d3f0c4f098c6748977d00ae90017d0f8f04202db6'
      )
    )
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('platform-schedule-admission:' || p_account_key, 0)
  );

  -- A retry after the first transaction committed is a read-only attestation.
  -- The original authority remains authoritative even if a newer campaign was
  -- ingested; switching authority would consume the same workflow run twice.
  SELECT target.* INTO account
  FROM "tool_budget_account" target
  WHERE target."scope_key" = 'platform'
    AND target."account_key" = p_account_key
  FOR UPDATE;
  IF account."id" IS NOT NULL THEN
    SELECT target.* INTO authority
    FROM "execution_budget_authority" target
    WHERE target."scope_key" = 'platform'
      AND target."id" = account."authority_id";
    IF authority."id" IS NULL
      OR authority."authority_kind" IS DISTINCT FROM 'PLATFORM_GRANT'
      OR authority."purpose" IS DISTINCT FROM p_purpose
      OR authority."subject_type" IS DISTINCT FROM p_subject_type
      OR authority."subject_id" IS DISTINCT FROM p_subject_id
      OR authority."schedule_id" IS DISTINCT FROM p_schedule_id
      OR authority."campaign_cap_microusd" IS NULL
      OR authority."campaign_cap_microusd" < 1
      OR authority."max_runs" IS NULL
      OR authority."max_runs" < 1
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO opened
    FROM attest_authorized_tool_budget_v1(
      'platform', authority."id", p_account_key
    );
    RETURN QUERY SELECT
      opened.account_id,
      opened.generation,
      opened.authority_id,
      opened.authorized_cap_microusd,
      authority."campaign_cap_microusd",
      authority."max_runs",
      true;
    RETURN;
  END IF;

  -- Select the newest exact active campaign. The row lock makes selection and
  -- run-slot consumption one transaction under concurrent schedule starts.
  SELECT target.* INTO authority
  FROM "execution_budget_authority" target
  WHERE target."scope_key" = 'platform'
    AND target."authority_kind" = 'PLATFORM_GRANT'
    AND target."purpose" = p_purpose
    AND target."subject_type" = p_subject_type
    AND target."subject_id" = p_subject_id
    AND target."schedule_id" = p_schedule_id
    AND target."revoked_at" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "execution_budget_authority_revocation" revocation
      WHERE revocation."scope_key" = 'platform'
        AND revocation."authority_id" = target."id"
    )
    AND execution_budget_authority_time_state(
      target."issued_at", target."not_before", target."expires_at",
      statement_timestamp()
    ) = 'ACTIVE'
    AND target."runs_consumed" < target."max_runs"
    AND execution_budget_authority_campaign_remaining_microusd(
      target."campaign_cap_microusd", target."runs_consumed",
      target."cap_per_run_microusd"
    ) > 0
  ORDER BY target."issued_at" DESC, target."id" DESC
  LIMIT 1
  FOR UPDATE;

  IF authority."id" IS NULL THEN
    SELECT target.* INTO authority
    FROM "execution_budget_authority" target
    WHERE target."scope_key" = 'platform'
      AND target."authority_kind" = 'PLATFORM_GRANT'
      AND target."purpose" = p_purpose
      AND target."subject_type" = p_subject_type
      AND target."subject_id" = p_subject_id
      AND target."schedule_id" = p_schedule_id
    ORDER BY target."issued_at" DESC, target."id" DESC
    LIMIT 1;
    IF authority."id" IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'
        USING ERRCODE = 'P0001';
    END IF;
    IF authority."revoked_at" IS NOT NULL OR EXISTS (
      SELECT 1
      FROM "execution_budget_authority_revocation" revocation
      WHERE revocation."scope_key" = 'platform'
        AND revocation."authority_id" = authority."id"
    ) THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_REVOKED'
        USING ERRCODE = 'P0001';
    END IF;
    time_state := execution_budget_authority_time_state(
      authority."issued_at", authority."not_before", authority."expires_at",
      statement_timestamp()
    );
    IF time_state = 'EXPIRED' THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_EXPIRED'
        USING ERRCODE = 'P0001';
    END IF;
    IF time_state IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    campaign_remaining := execution_budget_authority_campaign_remaining_microusd(
      authority."campaign_cap_microusd", authority."runs_consumed",
      authority."cap_per_run_microusd"
    );
    IF authority."runs_consumed" >= authority."max_runs"
      OR campaign_remaining <= 0
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED'
        USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO opened
  FROM open_authorized_tool_budget_v1(
    'platform', authority."id", p_account_key, false
  );
  RETURN QUERY SELECT
    opened.account_id,
    opened.generation,
    opened.authority_id,
    opened.authorized_cap_microusd,
    authority."campaign_cap_microusd",
    authority."max_runs",
    false;
END
$$;

REVOKE ALL ON FUNCTION admit_platform_execution_budget_run_v1(
  "execution_budget_purpose", TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION admit_platform_execution_budget_run_v1(
  "execution_budget_purpose", TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO execution_budget_platform_writer;

COMMIT;
