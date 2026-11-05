-- P4 (platform.channel_crawl) second phase: teach the authority constraints,
-- the platform run binding and the platform-writer ingestion path the new
-- channel-crawl shape. The schedule branches are copied verbatim from their
-- latest definitions (20261028183000 for the kind CHECK, 20260905193000 for the
-- run binding) and keep every invariant byte-identical; channel_crawl adds a
-- separate branch bound to request_sha256 + crawl_run_id + policy revision.
-- No backfill: no row can carry the new purpose or column values yet.
--
-- Deploy in name order, in the same window as the image that carries this
-- migration. Rollback: a later migration that restores the previous
-- definitions (the enum value stays; PostgreSQL cannot drop a single value).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "execution_budget_authority"
  ADD COLUMN "crawl_run_id" VARCHAR(36);

ALTER TABLE "execution_budget_authority"
  DROP CONSTRAINT "execution_budget_authority_kind_shape_check",
  ADD CONSTRAINT "execution_budget_authority_kind_shape_check" CHECK
(
    (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND "workspace_id" IS NOT NULL
      AND "scope_key" = "workspace_id"::text
      AND "purpose" IN (
        'icp.design', 'icp.query_plan', 'understanding.run',
        'discovery.run', 'contact.verify', 'outreach.draft'
      )
      AND (
        ("purpose" = 'understanding.run' AND "subject_type" = 'company')
        OR ("purpose" = 'icp.design' AND "subject_type" = 'company')
        OR ("purpose" = 'icp.query_plan' AND "subject_type" = 'icp')
        OR (
          "purpose" = 'discovery.run'
          AND "subject_type" IN ('discovery_run', 'company')
        )
        OR ("purpose" = 'contact.verify' AND "subject_type" = 'contact_point')
        OR ("purpose" = 'outreach.draft' AND "subject_type" = 'lead')
      )
      AND "request_sha256" IS NOT NULL
      AND "request_sha256" ~ '^[0-9a-f]{64}$'
      AND "schedule_id" IS NULL
      AND "crawl_run_id" IS NULL
      AND "cap_microusd" IS NOT NULL
      AND "cap_microusd" > 0
      AND "cap_per_run_microusd" IS NULL
      AND "campaign_cap_microusd" IS NULL
      AND "max_runs" IS NULL
      AND "runs_consumed" BETWEEN 0 AND 1
      AND "consumed_at" IS NOT NULL
    )
    OR
    (
      "authority_kind" = 'PLATFORM_GRANT'
      AND "workspace_id" IS NULL
      AND "scope_key" = 'platform'
      AND "purpose" IN (
        'platform.acquisition', 'platform.intent_watch', 'platform.sanctions'
      )
      AND "request_sha256" IS NULL
      AND "crawl_run_id" IS NULL
      AND "schedule_id" IS NOT NULL
      AND char_length(btrim("schedule_id")) BETWEEN 1 AND 191
      AND "subject_type" IS NOT DISTINCT FROM 'schedule'
      AND "subject_id" IS NOT DISTINCT FROM "schedule_id"
      AND "cap_microusd" IS NULL
      AND "cap_per_run_microusd" IS NOT NULL
      AND "cap_per_run_microusd" > 0
      AND "campaign_cap_microusd" IS NOT NULL
      AND "campaign_cap_microusd" > 0
      AND "max_runs" IS NOT NULL
      AND "max_runs" > 0
      AND "runs_consumed" <= "max_runs"
      AND (
        ("runs_consumed" = 0 AND "consumed_at" IS NULL)
        OR ("runs_consumed" > 0 AND "consumed_at" IS NOT NULL)
      )
    )
    OR
    (
      "authority_kind" = 'PLATFORM_GRANT'
      AND "workspace_id" IS NULL
      AND "scope_key" = 'platform'
      AND "purpose" = 'platform.channel_crawl'
      AND "request_sha256" ~ '^[0-9a-f]{64}$'
      AND "subject_type" = 'source_channel'
      AND "subject_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "schedule_id" IS NULL
      AND "crawl_run_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "cap_microusd" IS NULL
      AND "cap_per_run_microusd" IS NOT NULL
      AND "cap_per_run_microusd" > 0
      AND "campaign_cap_microusd" IS NOT NULL
      AND "campaign_cap_microusd" > 0
      AND "max_runs" IS NOT NULL
      AND "max_runs" > 0
      AND "runs_consumed" <= "max_runs"
      AND (
        ("runs_consumed" = 0 AND "consumed_at" IS NULL)
        OR ("runs_consumed" > 0 AND "consumed_at" IS NOT NULL)
      )
    )
);

ALTER TABLE "execution_budget_authority"
  DROP CONSTRAINT "execution_budget_authority_platform_run_binding_check",
  ADD CONSTRAINT "execution_budget_authority_platform_run_binding_check"
  CHECK (
    (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND "crawl_run_id" IS NULL
      AND "schedule_request_sha256" IS NULL
      AND "workflow_id" IS NULL
      AND "workflow_run_id" IS NULL
      AND "technical_policy_revision" IS NULL
    )
    OR
    (
      "authority_kind" = 'PLATFORM_GRANT'
      AND (
        (
          -- Historical Platform rows remain truthful and unbound. No value is
          -- synthesized for a Schedule run that the old contract never signed.
          "crawl_run_id" IS NULL
          AND "schedule_request_sha256" IS NULL
          AND "workflow_id" IS NULL
          AND "workflow_run_id" IS NULL
          AND "technical_policy_revision" IS NULL
        )
        OR
        (
          "crawl_run_id" IS NULL
          AND "schedule_request_sha256" ~ '^[0-9a-f]{64}$'
          AND "workflow_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
          AND "workflow_run_id" ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND "technical_policy_revision" ~ '^[0-9a-f]{64}$'
          AND "max_runs" = 1
          AND "campaign_cap_microusd" = "cap_per_run_microusd"
        )
        OR
        (
          "crawl_run_id" ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND "technical_policy_revision" ~ '^[0-9a-f]{64}$'
          AND "schedule_request_sha256" IS NULL
          AND "workflow_id" IS NULL
          AND "workflow_run_id" IS NULL
          AND "max_runs" = 1
        )
      )
    )
  );

CREATE UNIQUE INDEX "execution_budget_authority_platform_crawl_run_key"
  ON "execution_budget_authority"("crawl_run_id")
  WHERE "authority_kind" = 'PLATFORM_GRANT'
    AND "crawl_run_id" IS NOT NULL;

-- Channel-crawl ingestion: one signed grant binds one channel-crawl run.
-- Mirrors ingest_and_admit_platform_execution_budget_run_v2 (authority-first
-- order, JTI replay fence, per-run uniqueness, platform account admission) but
-- carries request_sha256 + crawl_run_id + technical_policy_revision instead of
-- the schedule four-field invocation. The schedule function is untouched and
-- continues to reject every other purpose.
CREATE FUNCTION ingest_and_admit_platform_channel_crawl_run_v1(
  p_issuer TEXT,
  p_audience TEXT,
  p_jti UUID,
  p_token_sha256 TEXT,
  p_schema_version TEXT,
  p_purpose "execution_budget_purpose",
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_request_sha256 TEXT,
  p_crawl_run_id TEXT,
  p_technical_policy_revision TEXT,
  p_currency TEXT,
  p_unit TEXT,
  p_cap_per_run_microusd BIGINT,
  p_campaign_cap_microusd BIGINT,
  p_max_runs BIGINT,
  p_issued_at TIMESTAMPTZ,
  p_not_before TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ,
  p_expected_purpose "execution_budget_purpose",
  p_expected_subject_type TEXT,
  p_expected_subject_id TEXT,
  p_expected_request_sha256 TEXT,
  p_expected_crawl_run_id TEXT,
  p_expected_technical_policy_revision TEXT
)
RETURNS TABLE(
  account_id UUID,
  generation INTEGER,
  authority_id UUID,
  authorized_cap_microusd BIGINT,
  replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  opened RECORD;
  computed_account_key TEXT;
  time_state TEXT;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();

  IF NOT COALESCE(char_length(btrim(p_issuer)) BETWEEN 1 AND 512, false)
    OR p_audience IS DISTINCT FROM 'global-backend:execution-budget'
    OR p_jti IS NULL
    OR NOT COALESCE(p_token_sha256 ~ '^[0-9a-f]{64}$', false)
    OR p_schema_version IS DISTINCT FROM 'execution-budget-grant/v1'
    OR p_purpose IS DISTINCT FROM 'platform.channel_crawl'
    OR p_subject_type IS DISTINCT FROM 'source_channel'
    OR NOT COALESCE(
      p_subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      false
    )
    OR NOT COALESCE(p_request_sha256 ~ '^[0-9a-f]{64}$', false)
    OR NOT COALESCE(
      p_crawl_run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      false
    )
    OR NOT COALESCE(p_technical_policy_revision ~ '^[0-9a-f]{64}$', false)
    OR p_currency IS DISTINCT FROM 'USD'
    OR p_unit IS DISTINCT FROM 'microusd'
    OR NOT COALESCE(p_cap_per_run_microusd > 0, false)
    OR NOT COALESCE(p_campaign_cap_microusd > 0, false)
    OR p_max_runs IS DISTINCT FROM 1
    OR p_issued_at IS NULL
    OR p_not_before IS NULL
    OR p_expires_at IS NULL
    OR NOT COALESCE(p_issued_at <= p_not_before, false)
    OR NOT COALESCE(p_not_before < p_expires_at, false)
    OR NOT COALESCE(
      p_expires_at - p_issued_at <= INTERVAL '5 minutes',
      false
    )
    OR p_expected_purpose IS DISTINCT FROM 'platform.channel_crawl'
    OR p_expected_subject_type IS DISTINCT FROM 'source_channel'
    OR p_expected_subject_id IS DISTINCT FROM p_subject_id
    OR p_expected_request_sha256 IS DISTINCT FROM p_request_sha256
    OR p_expected_crawl_run_id IS DISTINCT FROM p_crawl_run_id
    OR p_expected_technical_policy_revision IS DISTINCT FROM
      p_technical_policy_revision
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  -- Authority-first order: JTI/authority, then the crawl run fence and the
  -- deterministic account identity. Advisory locks serialize the normal path;
  -- the partial unique index remains the final fence even when a REPEATABLE
  -- READ transaction holds a stale snapshot.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('execution-budget-jti:' || p_issuer || ':' || p_jti::text, 0)
  );
  SELECT target.* INTO authority
  FROM "execution_budget_authority" target
  WHERE target."issuer" = p_issuer AND target."jti" = p_jti
  FOR UPDATE;

  IF authority."id" IS NOT NULL THEN
    IF authority."authority_kind" IS DISTINCT FROM 'PLATFORM_GRANT'
      OR authority."scope_key" IS DISTINCT FROM 'platform'
      OR authority."audience" IS DISTINCT FROM p_audience
      OR authority."token_sha256" IS DISTINCT FROM p_token_sha256
      OR authority."schema_version" IS DISTINCT FROM p_schema_version
      OR authority."purpose" IS DISTINCT FROM p_purpose
      OR authority."workspace_id" IS NOT NULL
      OR authority."subject_type" IS DISTINCT FROM p_subject_type
      OR authority."subject_id" IS DISTINCT FROM p_subject_id
      OR authority."request_sha256" IS DISTINCT FROM p_request_sha256
      OR authority."schedule_id" IS NOT NULL
      OR authority."crawl_run_id" IS DISTINCT FROM p_crawl_run_id
      OR authority."schedule_request_sha256" IS NOT NULL
      OR authority."workflow_id" IS NOT NULL
      OR authority."workflow_run_id" IS NOT NULL
      OR authority."technical_policy_revision" IS DISTINCT FROM
        p_technical_policy_revision
      OR authority."currency" IS DISTINCT FROM p_currency
      OR authority."unit" IS DISTINCT FROM p_unit
      OR authority."cap_microusd" IS NOT NULL
      OR authority."cap_per_run_microusd" IS DISTINCT FROM
        p_cap_per_run_microusd
      OR authority."campaign_cap_microusd" IS DISTINCT FROM
        p_campaign_cap_microusd
      OR authority."max_runs" IS DISTINCT FROM p_max_runs
      OR authority."issued_at" IS DISTINCT FROM p_issued_at
      OR authority."not_before" IS DISTINCT FROM p_not_before
      OR authority."expires_at" IS DISTINCT FROM p_expires_at
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'platform-crawl-run:' || p_crawl_run_id,
        0
      )
    );
    IF EXISTS (
      SELECT 1
      FROM "execution_budget_authority" target
      WHERE target."scope_key" = 'platform'
        AND target."authority_kind" = 'PLATFORM_GRANT'
        AND target."crawl_run_id" = p_crawl_run_id
    ) THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;

    IF p_purpose IS DISTINCT FROM p_expected_purpose
      OR p_subject_type IS DISTINCT FROM p_expected_subject_type
      OR p_subject_id IS DISTINCT FROM p_expected_subject_id
      OR p_request_sha256 IS DISTINCT FROM p_expected_request_sha256
      OR p_crawl_run_id IS DISTINCT FROM p_expected_crawl_run_id
      OR p_technical_policy_revision IS DISTINCT FROM
        p_expected_technical_policy_revision
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
        USING ERRCODE = 'P0001';
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

    BEGIN
      INSERT INTO "execution_budget_authority"(
        "scope_key", "authority_kind", "issuer", "audience", "jti",
        "token_sha256", "schema_version", "purpose", "subject_type",
        "subject_id", "request_sha256", "crawl_run_id",
        "technical_policy_revision", "currency", "unit",
        "cap_per_run_microusd", "campaign_cap_microusd", "max_runs",
        "issued_at", "not_before", "expires_at"
      ) VALUES (
        'platform', 'PLATFORM_GRANT', p_issuer, p_audience, p_jti,
        p_token_sha256, p_schema_version, p_purpose, p_subject_type,
        p_subject_id, p_request_sha256, p_crawl_run_id,
        p_technical_policy_revision, p_currency, p_unit,
        p_cap_per_run_microusd, p_campaign_cap_microusd, p_max_runs,
        p_issued_at, p_not_before, p_expires_at
      ) RETURNING * INTO authority;
    EXCEPTION
      WHEN unique_violation THEN
        RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
          USING ERRCODE = 'P0001';
    END;
  END IF;

  -- The independently reconstructed runtime scope is compared even on exact
  -- JTI replay. This keeps scope mismatch distinct from altered signed claims.
  IF authority."purpose" IS DISTINCT FROM p_expected_purpose
    OR authority."subject_type" IS DISTINCT FROM p_expected_subject_type
    OR authority."subject_id" IS DISTINCT FROM p_expected_subject_id
    OR authority."request_sha256" IS DISTINCT FROM p_expected_request_sha256
    OR authority."crawl_run_id" IS DISTINCT FROM p_expected_crawl_run_id
    OR authority."technical_policy_revision" IS DISTINCT FROM
      p_expected_technical_policy_revision
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  computed_account_key :=
    'platform:' || authority."request_sha256" || ':' ||
    authority."crawl_run_id";
  IF char_length(computed_account_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'authorized-tool-budget:platform:' || computed_account_key,
      0
    )
  );
  SELECT target.* INTO account
  FROM "tool_budget_account" target
  WHERE target."scope_key" = 'platform'
    AND target."account_key" = computed_account_key
  FOR UPDATE;

  IF account."id" IS NOT NULL THEN
    IF account."authority_id" IS DISTINCT FROM authority."id"
      OR account."authorized_cap_microusd" IS DISTINCT FROM
        authority."cap_per_run_microusd"
      OR account."cap_cents" IS DISTINCT FROM 0
      OR account."reserved_cents" IS DISTINCT FROM 0
      OR account."charged_cents" IS DISTINCT FROM 0
      OR account."generation" < 1
      OR account."ref_count" IS DISTINCT FROM 1
      OR account."closed_at" IS NOT NULL
      OR authority."runs_consumed" IS DISTINCT FROM 1
      OR authority."consumed_at" IS NULL
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;

    -- Read-only liveness and identity readback after a lost response ACK; no
    -- UPDATE, so neither runs_consumed nor ref_count can grow here.
    SELECT * INTO opened
    FROM attest_authorized_tool_budget_v1(
      'platform', authority."id", computed_account_key
    );
    RETURN QUERY SELECT
      opened.account_id,
      opened.generation,
      opened.authority_id,
      opened.authorized_cap_microusd,
      true;
    RETURN;
  END IF;

  SELECT * INTO opened
  FROM open_authorized_tool_budget_v1(
    'platform', authority."id", computed_account_key, false
  );
  RETURN QUERY SELECT
    opened.account_id,
    opened.generation,
    opened.authority_id,
    opened.authorized_cap_microusd,
    false;
END
$$;

REVOKE ALL ON FUNCTION ingest_and_admit_platform_channel_crawl_run_v1(
  TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT,
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, "execution_budget_purpose",
  TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION ingest_and_admit_platform_channel_crawl_run_v1(
  TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT,
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, "execution_budget_purpose",
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO execution_budget_platform_writer;

COMMIT;
