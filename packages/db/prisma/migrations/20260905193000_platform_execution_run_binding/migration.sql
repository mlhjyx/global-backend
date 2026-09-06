-- Bind every new Platform Grant to one exact Temporal Schedule run and make
-- signed-authority ingestion plus account admission one atomic writer action.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "execution_budget_authority"
  ADD COLUMN "schedule_request_sha256" VARCHAR(64),
  ADD COLUMN "workflow_id" VARCHAR(200),
  ADD COLUMN "workflow_run_id" VARCHAR(36),
  ADD COLUMN "technical_policy_revision" VARCHAR(64),
  ADD CONSTRAINT "execution_budget_authority_platform_run_binding_check"
  CHECK (
    (
      "authority_kind" = 'WORKSPACE_GRANT'
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
          "schedule_request_sha256" IS NULL
          AND "workflow_id" IS NULL
          AND "workflow_run_id" IS NULL
          AND "technical_policy_revision" IS NULL
        )
        OR
        (
          "schedule_request_sha256" ~ '^[0-9a-f]{64}$'
          AND "workflow_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
          AND "workflow_run_id" ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND "technical_policy_revision" ~ '^[0-9a-f]{64}$'
          AND "max_runs" = 1
          AND "campaign_cap_microusd" = "cap_per_run_microusd"
        )
      )
    )
  );

CREATE UNIQUE INDEX "execution_budget_authority_platform_workflow_run_key"
  ON "execution_budget_authority"("workflow_run_id")
  WHERE "authority_kind" = 'PLATFORM_GRANT'
    AND "workflow_run_id" IS NOT NULL;

CREATE FUNCTION ingest_and_admit_platform_execution_budget_run_v2(
  p_issuer TEXT,
  p_audience TEXT,
  p_jti UUID,
  p_token_sha256 TEXT,
  p_schema_version TEXT,
  p_purpose "execution_budget_purpose",
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_schedule_id TEXT,
  p_schedule_request_sha256 TEXT,
  p_workflow_id TEXT,
  p_workflow_run_id TEXT,
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
  p_expected_schedule_id TEXT,
  p_expected_schedule_request_sha256 TEXT,
  p_expected_workflow_id TEXT,
  p_expected_workflow_run_id TEXT,
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
SET search_path = pg_catalog, public
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
    OR NOT COALESCE(
      p_purpose IN (
        'platform.acquisition', 'platform.intent_watch', 'platform.sanctions'
      ),
      false
    )
    OR p_subject_type IS DISTINCT FROM 'schedule'
    OR NOT COALESCE(char_length(p_subject_id) BETWEEN 1 AND 191, false)
    OR p_subject_id ~ '[[:cntrl:]]'
    OR p_subject_id IS DISTINCT FROM p_schedule_id
    OR NOT COALESCE(char_length(p_schedule_id) BETWEEN 1 AND 191, false)
    OR p_schedule_id ~ '[[:cntrl:]]'
    OR NOT COALESCE(p_schedule_request_sha256 ~ '^[0-9a-f]{64}$', false)
    OR NOT COALESCE(
      p_workflow_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$',
      false
    )
    OR NOT COALESCE(
      p_workflow_run_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      false
    )
    OR NOT COALESCE(p_technical_policy_revision ~ '^[0-9a-f]{64}$', false)
    OR p_currency IS DISTINCT FROM 'USD'
    OR p_unit IS DISTINCT FROM 'microusd'
    OR NOT COALESCE(p_cap_per_run_microusd > 0, false)
    OR NOT COALESCE(p_campaign_cap_microusd > 0, false)
    OR NOT COALESCE(p_max_runs > 0, false)
    OR p_issued_at IS NULL
    OR p_not_before IS NULL
    OR p_expires_at IS NULL
    OR NOT COALESCE(p_issued_at <= p_not_before, false)
    OR NOT COALESCE(p_not_before < p_expires_at, false)
    OR NOT COALESCE(
      p_expires_at - p_issued_at <= INTERVAL '5 minutes',
      false
    )
    OR NOT COALESCE(
      p_expected_purpose IN (
        'platform.acquisition', 'platform.intent_watch', 'platform.sanctions'
      ),
      false
    )
    OR p_expected_subject_type IS DISTINCT FROM 'schedule'
    OR NOT COALESCE(char_length(p_expected_subject_id) BETWEEN 1 AND 191, false)
    OR p_expected_subject_id ~ '[[:cntrl:]]'
    OR p_expected_subject_id IS DISTINCT FROM p_expected_schedule_id
    OR NOT COALESCE(char_length(p_expected_schedule_id) BETWEEN 1 AND 191, false)
    OR p_expected_schedule_id ~ '[[:cntrl:]]'
    OR NOT COALESCE(
      p_expected_schedule_request_sha256 ~ '^[0-9a-f]{64}$',
      false
    )
    OR NOT COALESCE(
      p_expected_workflow_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$',
      false
    )
    OR NOT COALESCE(
      p_expected_workflow_run_id ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      false
    )
    OR NOT COALESCE(
      p_expected_technical_policy_revision ~ '^[0-9a-f]{64}$',
      false
    )
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  -- Keep the established authority-first order: JTI/authority, then the
  -- workflow run and deterministic account identity. Advisory locks serialize
  -- the normal path; the partial unique index remains the final fence even
  -- when a REPEATABLE READ transaction holds a stale snapshot.
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
      OR authority."request_sha256" IS NOT NULL
      OR authority."schedule_id" IS DISTINCT FROM p_schedule_id
      OR authority."schedule_request_sha256" IS DISTINCT FROM
        p_schedule_request_sha256
      OR authority."workflow_id" IS DISTINCT FROM p_workflow_id
      OR authority."workflow_run_id" IS DISTINCT FROM p_workflow_run_id
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
        'platform-workflow-run:' || p_workflow_run_id,
        0
      )
    );
    IF EXISTS (
      SELECT 1
      FROM "execution_budget_authority" target
      WHERE target."scope_key" = 'platform'
        AND target."authority_kind" = 'PLATFORM_GRANT'
        AND target."workflow_run_id" = p_workflow_run_id
    ) THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;

    IF p_campaign_cap_microusd IS DISTINCT FROM p_cap_per_run_microusd
      OR p_max_runs IS DISTINCT FROM 1
      OR NOT (
        (
          p_purpose = 'platform.acquisition'
          AND p_schedule_id = 'acq-sweep'
          AND p_schedule_request_sha256 =
            '5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e'
        )
        OR (
          p_purpose = 'platform.acquisition'
          AND p_schedule_id = 'patents-cache-refresh'
          AND p_schedule_request_sha256 =
            '3fbcd9326937d66243f1395d3f0c4f098c6748977d00ae90017d0f8f04202db6'
        )
        OR (
          p_purpose = 'platform.intent_watch'
          AND p_schedule_id = 'intent-sweep'
          AND p_schedule_request_sha256 =
            '9ef4afce408c36472e00db01a80b6e3a3e461a2b13af7f456d9ce31a7676c34a'
        )
        OR (
          p_purpose = 'platform.sanctions'
          AND p_schedule_id = 'sanctions-refresh'
          AND p_schedule_request_sha256 =
            '50b8dfae274bb16a825147c648f46789ea0eb291b3d32964c8bacf385340dffe'
        )
      )
      OR p_purpose IS DISTINCT FROM p_expected_purpose
      OR p_subject_type IS DISTINCT FROM p_expected_subject_type
      OR p_subject_id IS DISTINCT FROM p_expected_subject_id
      OR p_schedule_id IS DISTINCT FROM p_expected_schedule_id
      OR p_schedule_request_sha256 IS DISTINCT FROM
        p_expected_schedule_request_sha256
      OR p_workflow_id IS DISTINCT FROM p_expected_workflow_id
      OR p_workflow_run_id IS DISTINCT FROM p_expected_workflow_run_id
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
        "subject_id", "schedule_id", "schedule_request_sha256",
        "workflow_id", "workflow_run_id", "technical_policy_revision",
        "currency", "unit", "cap_per_run_microusd",
        "campaign_cap_microusd", "max_runs", "issued_at", "not_before",
        "expires_at"
      ) VALUES (
        'platform', 'PLATFORM_GRANT', p_issuer, p_audience, p_jti,
        p_token_sha256, p_schema_version, p_purpose, p_subject_type,
        p_subject_id, p_schedule_id, p_schedule_request_sha256,
        p_workflow_id, p_workflow_run_id, p_technical_policy_revision,
        p_currency, p_unit, p_cap_per_run_microusd,
        p_campaign_cap_microusd, p_max_runs, p_issued_at, p_not_before,
        p_expires_at
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
    OR authority."schedule_id" IS DISTINCT FROM p_expected_schedule_id
    OR authority."schedule_request_sha256" IS DISTINCT FROM
      p_expected_schedule_request_sha256
    OR authority."workflow_id" IS DISTINCT FROM p_expected_workflow_id
    OR authority."workflow_run_id" IS DISTINCT FROM
      p_expected_workflow_run_id
    OR authority."technical_policy_revision" IS DISTINCT FROM
      p_expected_technical_policy_revision
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  computed_account_key :=
    'platform:' || authority."schedule_request_sha256" || ':' ||
    authority."workflow_run_id";
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

    -- This is a read-only liveness and identity readback after a committed
    -- response ACK was lost. The attestation performs no UPDATE and therefore
    -- cannot increase either runs_consumed or ref_count.
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

-- Old platform entry points cannot create a newly unbound authority or open a
-- platform account without the exact run/workflow/policy comparison above.
REVOKE EXECUTE ON FUNCTION ingest_platform_execution_authority(
  TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
  TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ,
  TIMESTAMPTZ
) FROM execution_budget_platform_writer;
REVOKE EXECUTE ON FUNCTION admit_platform_execution_budget_run_v1(
  "execution_budget_purpose", TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM execution_budget_platform_writer;
REVOKE EXECUTE ON FUNCTION open_authorized_tool_budget_v1(
  TEXT, UUID, TEXT, BOOLEAN
) FROM execution_budget_platform_writer;
REVOKE EXECUTE ON FUNCTION open_tool_budget(
  TEXT, UUID, TEXT, BOOLEAN
) FROM execution_budget_platform_writer;

REVOKE ALL ON FUNCTION ingest_and_admit_platform_execution_budget_run_v2(
  TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT,
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, "execution_budget_purpose",
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION ingest_and_admit_platform_execution_budget_run_v2(
  TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT,
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, "execution_budget_purpose",
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO execution_budget_platform_writer;

COMMIT;
