-- Additive execution-budget authority, revocation and Tool budget binding.
-- Historical accounts remain unbound and retain the legacy cents lifecycle.
-- Authority-bound accounts use cap_cents=0 and stay mechanically non-spendable
-- until the separately reviewed microusd lifecycle cutover.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

-- Platform authority is written only by deployment-provisioned LOGIN
-- principals that are exclusive members of this fixed NOLOGIN group role.
DO $$
DECLARE
  can_create_role BOOLEAN;
  platform_role pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO platform_role
  FROM pg_roles
  WHERE rolname = 'execution_budget_platform_writer';

  IF platform_role.oid IS NULL THEN
    SELECT rolsuper OR rolcreaterole INTO can_create_role
    FROM pg_roles
    WHERE rolname = current_user;
    IF NOT COALESCE(can_create_role, false) THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_MIGRATION_REQUIRES_CREATEROLE';
    END IF;
    CREATE ROLE execution_budget_platform_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF platform_role.rolcanlogin
    OR platform_role.rolsuper
    OR platform_role.rolbypassrls
    OR platform_role.rolcreaterole
    OR platform_role.rolcreatedb
    OR platform_role.rolreplication
    OR EXISTS (
      SELECT 1
      FROM pg_auth_members membership
      WHERE membership.member = platform_role.oid
    )
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_PLATFORM_WRITER_ROLE_INVALID';
  END IF;

  IF pg_has_role('app_user', 'execution_budget_platform_writer', 'member') THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_APP_ROLE_PLATFORM_MEMBERSHIP_INVALID';
  END IF;
END $$;

CREATE TYPE "execution_budget_authority_kind" AS ENUM (
  'WORKSPACE_GRANT',
  'PLATFORM_GRANT'
);

CREATE TYPE "execution_budget_purpose" AS ENUM (
  'icp.design',
  'icp.query_plan',
  'understanding.run',
  'discovery.run',
  'contact.verify',
  'platform.acquisition',
  'platform.intent_watch',
  'platform.sanctions'
);

CREATE TABLE "execution_budget_authority" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "scope_key" VARCHAR(200) NOT NULL,
  "authority_kind" "execution_budget_authority_kind" NOT NULL,
  "workspace_id" UUID,
  "issuer" VARCHAR(512) NOT NULL,
  "audience" VARCHAR(191) NOT NULL,
  "jti" UUID NOT NULL,
  "token_sha256" VARCHAR(64) NOT NULL,
  "schema_version" VARCHAR(80) NOT NULL,
  "purpose" "execution_budget_purpose" NOT NULL,
  "subject_type" VARCHAR(191) NOT NULL,
  "subject_id" VARCHAR(191) NOT NULL,
  "request_sha256" VARCHAR(64),
  "schedule_id" VARCHAR(191),
  "currency" VARCHAR(3) NOT NULL,
  "unit" VARCHAR(16) NOT NULL,
  "cap_microusd" BIGINT,
  "cap_per_run_microusd" BIGINT,
  "campaign_cap_microusd" BIGINT,
  "max_runs" BIGINT,
  "runs_consumed" BIGINT NOT NULL DEFAULT 0,
  "issued_at" TIMESTAMPTZ(3) NOT NULL,
  "not_before" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "execution_budget_authority_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "execution_budget_authority_issuer_jti_key"
    UNIQUE ("issuer", "jti"),
  CONSTRAINT "execution_budget_authority_scope_id_key"
    UNIQUE ("scope_key", "id"),
  CONSTRAINT "execution_budget_authority_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "execution_budget_authority_common_shape_check" CHECK (
    "audience" = 'global-backend:execution-budget'
    AND "schema_version" = 'execution-budget-grant/v1'
    AND "currency" = 'USD'
    AND "unit" = 'microusd'
    AND "token_sha256" ~ '^[0-9a-f]{64}$'
    AND char_length(btrim("issuer")) BETWEEN 1 AND 512
    AND char_length(btrim("subject_type")) BETWEEN 1 AND 191
    AND char_length(btrim("subject_id")) BETWEEN 1 AND 191
    AND "runs_consumed" >= 0
    AND "issued_at" <= "not_before"
    AND "not_before" < "expires_at"
    AND "expires_at" - "issued_at" <= INTERVAL '5 minutes'
    AND ("revoked_at" IS NULL OR "revoked_at" >= "issued_at")
  ),
  CONSTRAINT "execution_budget_authority_kind_shape_check" CHECK (
    (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND "workspace_id" IS NOT NULL
      AND "scope_key" = "workspace_id"::text
      AND "purpose" IN (
        'icp.design', 'icp.query_plan', 'understanding.run',
        'discovery.run', 'contact.verify'
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
      )
      AND "request_sha256" IS NOT NULL
      AND "request_sha256" ~ '^[0-9a-f]{64}$'
      AND "schedule_id" IS NULL
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
  )
);

CREATE INDEX "execution_budget_authority_workspace_purpose_expiry_idx"
  ON "execution_budget_authority"("workspace_id", "purpose", "expires_at");
CREATE INDEX "execution_budget_authority_schedule_purpose_expiry_idx"
  ON "execution_budget_authority"("schedule_id", "purpose", "expires_at");

CREATE TABLE "execution_budget_authority_revocation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "scope_key" VARCHAR(200) NOT NULL,
  "authority_id" UUID NOT NULL,
  "reason" VARCHAR(80) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "execution_budget_authority_revocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "execution_budget_authority_revocation_authority_key"
    UNIQUE ("authority_id"),
  CONSTRAINT "execution_budget_authority_revocation_scope_fkey"
    FOREIGN KEY ("scope_key", "authority_id")
    REFERENCES "execution_budget_authority"("scope_key", "id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "execution_budget_authority_revocation_reason_check" CHECK (
    char_length(btrim("reason")) BETWEEN 1 AND 80
  )
);

CREATE INDEX "execution_budget_authority_revocation_scope_time_idx"
  ON "execution_budget_authority_revocation"("scope_key", "revoked_at");

ALTER TABLE "tool_budget_account"
  ADD COLUMN "authority_id" UUID,
  ADD COLUMN "authorized_cap_microusd" BIGINT,
  ADD CONSTRAINT "tool_budget_account_authority_fkey"
    FOREIGN KEY ("authority_id") REFERENCES "execution_budget_authority"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "tool_budget_account_authority_shape_check" CHECK (
    ("authority_id" IS NULL AND "authorized_cap_microusd" IS NULL)
    OR (
      "authority_id" IS NOT NULL
      AND "authorized_cap_microusd" IS NOT NULL
      AND "authorized_cap_microusd" > 0
      AND "cap_cents" = 0
    )
  );

CREATE INDEX "tool_budget_account_authority_idx"
  ON "tool_budget_account"("authority_id");

ALTER TABLE "execution_budget_authority" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_budget_authority" FORCE ROW LEVEL SECURITY;
CREATE POLICY "execution_budget_authority_scope_isolation"
  ON "execution_budget_authority"
  USING (
    (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND NOT pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
      AND "scope_key" = current_workspace_id()::text
    )
    OR
    (
      "authority_kind" = 'PLATFORM_GRANT'
      AND "scope_key" = 'platform'
      AND pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
    )
  )
  WITH CHECK (
    (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND NOT pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
      AND "scope_key" = current_workspace_id()::text
    )
    OR
    (
      "authority_kind" = 'PLATFORM_GRANT'
      AND "scope_key" = 'platform'
      AND pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
    )
  );

ALTER TABLE "execution_budget_authority_revocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_budget_authority_revocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "execution_budget_authority_revocation_scope_isolation"
  ON "execution_budget_authority_revocation"
  USING (
    (
      NOT pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
      AND "scope_key" = current_workspace_id()::text
    )
    OR (
      "scope_key" = 'platform'
      AND pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
    )
  )
  WITH CHECK (
    (
      NOT pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
      AND "scope_key" = current_workspace_id()::text
    )
    OR (
      "scope_key" = 'platform'
      AND pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
    )
  );

-- SECURITY DEFINER changes current_user to the function owner, so the caller's
-- no-SET-ROLE invariant is established from the session role setting while
-- session_user remains the authenticated LOGIN identity. Exact direct
-- membership plus a non-nested safe group prevents inherited/owner fallback.
CREATE FUNCTION assert_execution_budget_platform_writer_principal()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  principal pg_roles%ROWTYPE;
  platform_group pg_roles%ROWTYPE;
  memberships TEXT[];
BEGIN
  SELECT * INTO principal
  FROM pg_roles
  WHERE rolname = session_user;
  SELECT * INTO platform_group
  FROM pg_roles
  WHERE rolname = 'execution_budget_platform_writer';
  SELECT COALESCE(array_agg(granted.rolname::text ORDER BY granted.rolname), ARRAY[]::text[])
  INTO memberships
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  WHERE membership.member = principal.oid;

  IF principal.oid IS NULL
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR NOT principal.rolcanlogin
    OR NOT principal.rolinherit
    OR principal.rolsuper
    OR principal.rolbypassrls
    OR principal.rolcreatedb
    OR principal.rolcreaterole
    OR principal.rolreplication
    OR memberships IS DISTINCT FROM ARRAY['execution_budget_platform_writer']::text[]
    OR platform_group.oid IS NULL
    OR platform_group.rolcanlogin
    OR platform_group.rolsuper
    OR platform_group.rolbypassrls
    OR platform_group.rolcreatedb
    OR platform_group.rolcreaterole
    OR platform_group.rolreplication
    OR EXISTS (
      -- The fixed group may not inherit another role.
      SELECT 1
      FROM pg_auth_members membership
      WHERE membership.member = platform_group.oid
    )
    OR EXISTS (
      -- A NOLOGIN role inside the group would create nested membership.
      SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE membership.roleid = platform_group.oid
        AND NOT member_role.rolcanlogin
    )
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

CREATE FUNCTION execution_budget_authority_time_state(
  p_issued_at TIMESTAMPTZ,
  p_not_before TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ,
  p_verification_time TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_issued_at::timestamptz(3) > p_verification_time::timestamptz(3)
      + INTERVAL '60 seconds'
      THEN 'INVALID'
    WHEN p_not_before::timestamptz(3) > p_verification_time::timestamptz(3)
      + INTERVAL '60 seconds'
      THEN 'NOT_YET_VALID'
    WHEN p_expires_at::timestamptz(3) < p_verification_time::timestamptz(3)
      - INTERVAL '60 seconds'
      THEN 'EXPIRED'
    ELSE 'ACTIVE'
  END
$$;

CREATE FUNCTION execution_budget_authority_campaign_remaining_microusd(
  p_campaign_cap_microusd BIGINT,
  p_runs_consumed BIGINT,
  p_cap_per_run_microusd BIGINT
)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT p_campaign_cap_microusd::numeric
    - p_runs_consumed::numeric * p_cap_per_run_microusd::numeric
$$;

CREATE FUNCTION mark_execution_budget_authority_revoked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
BEGIN
  IF (
    NEW."scope_key" = 'platform'
    AND NOT pg_has_role(
      session_user,
      'execution_budget_platform_writer',
      'member'
    )
  ) OR (
    NEW."scope_key" <> 'platform'
    AND NEW."scope_key" IS DISTINCT FROM current_workspace_id()::text
  ) THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO authority
  FROM "execution_budget_authority"
  WHERE "scope_key" = NEW."scope_key"
    AND "id" = NEW."authority_id"
  FOR UPDATE;
  IF authority."id" IS NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW."revoked_at" < authority."issued_at" THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE "execution_budget_authority"
  SET "revoked_at" = NEW."revoked_at"
  WHERE "id" = authority."id" AND "revoked_at" IS NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER "execution_budget_authority_revocation_mark"
  AFTER INSERT ON "execution_budget_authority_revocation"
  FOR EACH ROW EXECUTE FUNCTION mark_execution_budget_authority_revoked();

CREATE FUNCTION consume_workspace_execution_authority(
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  time_state TEXT;
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

  INSERT INTO "execution_budget_authority"(
    "scope_key", "authority_kind", "workspace_id", "issuer", "audience",
    "jti", "token_sha256", "schema_version", "purpose", "subject_type",
    "subject_id", "request_sha256", "currency", "unit", "cap_microusd",
    "issued_at", "not_before", "expires_at", "consumed_at"
  ) VALUES (
    p_workspace_id::text, 'WORKSPACE_GRANT', p_workspace_id, p_issuer,
    p_audience, p_jti, p_token_sha256, p_schema_version, p_purpose,
    p_subject_type, p_subject_id, p_request_sha256, p_currency, p_unit,
    p_cap_microusd, p_issued_at, p_not_before, p_expires_at, clock_timestamp()
  ) RETURNING * INTO authority;

  RETURN QUERY SELECT authority."id", false;
END
$$;

CREATE FUNCTION ingest_platform_execution_authority(
  p_issuer TEXT,
  p_audience TEXT,
  p_jti UUID,
  p_token_sha256 TEXT,
  p_schema_version TEXT,
  p_purpose "execution_budget_purpose",
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_schedule_id TEXT,
  p_currency TEXT,
  p_unit TEXT,
  p_cap_per_run_microusd BIGINT,
  p_campaign_cap_microusd BIGINT,
  p_max_runs BIGINT,
  p_issued_at TIMESTAMPTZ,
  p_not_before TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE(authority_id UUID, replay BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
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
    OR NOT COALESCE(char_length(btrim(p_subject_id)) BETWEEN 1 AND 191, false)
    OR NOT COALESCE(char_length(btrim(p_schedule_id)) BETWEEN 1 AND 191, false)
    OR p_subject_id IS DISTINCT FROM p_schedule_id
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
      OR authority."currency" IS DISTINCT FROM p_currency
      OR authority."unit" IS DISTINCT FROM p_unit
      OR authority."cap_microusd" IS NOT NULL
      OR authority."cap_per_run_microusd" IS DISTINCT FROM p_cap_per_run_microusd
      OR authority."campaign_cap_microusd" IS DISTINCT FROM p_campaign_cap_microusd
      OR authority."max_runs" IS DISTINCT FROM p_max_runs
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

  INSERT INTO "execution_budget_authority"(
    "scope_key", "authority_kind", "issuer", "audience", "jti",
    "token_sha256", "schema_version", "purpose", "subject_type",
    "subject_id", "schedule_id", "currency", "unit",
    "cap_per_run_microusd", "campaign_cap_microusd", "max_runs",
    "issued_at", "not_before", "expires_at"
  ) VALUES (
    'platform', 'PLATFORM_GRANT', p_issuer, p_audience, p_jti,
    p_token_sha256, p_schema_version, p_purpose, p_subject_type,
    p_subject_id, p_schedule_id, p_currency, p_unit,
    p_cap_per_run_microusd, p_campaign_cap_microusd, p_max_runs,
    p_issued_at, p_not_before, p_expires_at
  ) RETURNING * INTO authority;

  RETURN QUERY SELECT authority."id", false;
END
$$;

CREATE FUNCTION open_authorized_tool_budget_v1(
  p_scope_key TEXT,
  p_authority_id UUID,
  p_account_key TEXT,
  p_replay_scope BOOLEAN DEFAULT false
)
RETURNS TABLE(
  account_id UUID,
  generation INTEGER,
  authority_id UUID,
  authorized_cap_microusd BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  authorized_cap BIGINT;
  campaign_remaining NUMERIC;
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
  WHERE "scope_key" = p_scope_key AND "id" = p_authority_id
  FOR UPDATE;
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

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'authorized-tool-budget:' || p_scope_key || ':' || p_account_key,
      0
    )
  );
  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "scope_key" = p_scope_key AND "account_key" = p_account_key
  FOR UPDATE;

  IF account."id" IS NOT NULL THEN
    IF account."authority_id" IS NULL
      OR account."authority_id" IS DISTINCT FROM authority."id"
      OR account."authorized_cap_microusd" IS NULL
      OR account."cap_cents" IS DISTINCT FROM 0
      OR account."reserved_cents" IS DISTINCT FROM 0
      OR account."charged_cents" IS DISTINCT FROM 0
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;

    IF account."ref_count" > 0 THEN
      UPDATE "tool_budget_account" target
      SET "ref_count" = target."ref_count" + 1,
          "updated_at" = clock_timestamp()
      WHERE target."id" = account."id"
      RETURNING target.* INTO account;
      RETURN QUERY SELECT
        account."id", account."generation", account."authority_id",
        account."authorized_cap_microusd";
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "tool_budget_operation" operation
      WHERE operation."account_id" = account."id"
        AND operation."generation" = account."generation"
        AND operation."status" = 'RESERVED'
    ) THEN
      RAISE EXCEPTION 'TOOL_BUDGET_UNSETTLED_OPERATIONS'
        USING ERRCODE = 'P0001';
    END IF;

    IF p_replay_scope THEN
      UPDATE "tool_budget_account" target
      SET "ref_count" = 1,
          "closed_at" = NULL,
          "updated_at" = clock_timestamp()
      WHERE target."id" = account."id"
      RETURNING target.* INTO account;
      RETURN QUERY SELECT
        account."id", account."generation", account."authority_id",
        account."authorized_cap_microusd";
      RETURN;
    END IF;

    IF authority."authority_kind" = 'WORKSPACE_GRANT' THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF authority."authority_kind" = 'WORKSPACE_GRANT' THEN
    IF authority."runs_consumed" >= 1 THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED'
        USING ERRCODE = 'P0001';
    END IF;
    authorized_cap := authority."cap_microusd";
  ELSE
    IF authority."runs_consumed" >= authority."max_runs" THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED'
        USING ERRCODE = 'P0001';
    END IF;
    campaign_remaining := execution_budget_authority_campaign_remaining_microusd(
      authority."campaign_cap_microusd",
      authority."runs_consumed",
      authority."cap_per_run_microusd"
    );
    IF campaign_remaining <= 0 THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED'
        USING ERRCODE = 'P0001';
    END IF;
    authorized_cap := LEAST(
      authority."cap_per_run_microusd"::numeric,
      campaign_remaining
    )::bigint;
  END IF;

  IF account."id" IS NULL THEN
    INSERT INTO "tool_budget_account"(
      "scope_key", "account_key", "cap_cents", "authority_id",
      "authorized_cap_microusd"
    ) VALUES (
      p_scope_key, p_account_key, 0, authority."id", authorized_cap
    ) RETURNING * INTO account;
  ELSE
    UPDATE "tool_budget_account" target
    SET "generation" = target."generation" + 1,
        "cap_cents" = 0,
        "reserved_cents" = 0,
        "charged_cents" = 0,
        "exhausted" = false,
        "ref_count" = 1,
        "authority_id" = authority."id",
        "authorized_cap_microusd" = authorized_cap,
        "closed_at" = NULL,
        "updated_at" = clock_timestamp()
    WHERE target."id" = account."id"
    RETURNING target.* INTO account;
  END IF;

  UPDATE "execution_budget_authority" target
  SET "runs_consumed" = target."runs_consumed" + 1,
      "consumed_at" = COALESCE(target."consumed_at", clock_timestamp())
  WHERE target."id" = authority."id"
  RETURNING target.* INTO authority;

  RETURN QUERY SELECT
    account."id", account."generation", account."authority_id",
    account."authorized_cap_microusd";
END
$$;

CREATE FUNCTION revoke_platform_execution_authority_v1(
  p_authority_id UUID,
  p_reason TEXT,
  p_revoked_at TIMESTAMPTZ DEFAULT statement_timestamp()
)
RETURNS TABLE(revocation_id UUID, replay BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  existing "execution_budget_authority_revocation"%ROWTYPE;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_authority_id IS NULL
    OR NOT COALESCE(char_length(btrim(p_reason)) BETWEEN 1 AND 80, false)
    OR p_revoked_at IS NULL
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO authority
  FROM "execution_budget_authority"
  WHERE "scope_key" = 'platform'
    AND "authority_kind" = 'PLATFORM_GRANT'
    AND "id" = p_authority_id
  FOR UPDATE;
  IF authority."id" IS NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_revoked_at < authority."issued_at" THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO existing
  FROM "execution_budget_authority_revocation"
  WHERE "scope_key" = 'platform'
    AND "authority_id" = authority."id"
  FOR UPDATE;
  IF existing."id" IS NOT NULL THEN
    IF existing."reason" IS DISTINCT FROM p_reason
      OR existing."revoked_at" IS DISTINCT FROM p_revoked_at
    THEN
      RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_REUSED'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT existing."id", true;
    RETURN;
  END IF;

  INSERT INTO "execution_budget_authority_revocation"(
    "scope_key", "authority_id", "reason", "revoked_at"
  ) VALUES (
    'platform', authority."id", p_reason, p_revoked_at
  ) RETURNING * INTO existing;
  RETURN QUERY SELECT existing."id", false;
END
$$;

CREATE FUNCTION inspect_platform_execution_authority_freshness_v1(
  p_verification_time TIMESTAMPTZ
)
RETURNS TABLE(purpose TEXT, state TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_verification_time IS NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  WITH required(required_purpose) AS (
    VALUES
      ('platform.acquisition'::"execution_budget_purpose"),
      ('platform.intent_watch'::"execution_budget_purpose"),
      ('platform.sanctions'::"execution_budget_purpose")
  ), observations AS (
    SELECT
      required.required_purpose,
      count(authority."id") AS authority_count,
      bool_or(
        authority."id" IS NOT NULL
        AND authority."revoked_at" IS NULL
        AND revocation."authority_id" IS NULL
        AND evaluation.time_state = 'ACTIVE'
        AND authority."runs_consumed" < authority."max_runs"
        AND evaluation.campaign_remaining > 0
      ) AS active,
      bool_or(
        authority."id" IS NOT NULL
        AND authority."revoked_at" IS NULL
        AND revocation."authority_id" IS NULL
        AND (
          authority."runs_consumed" >= authority."max_runs"
          OR evaluation.campaign_remaining <= 0
        )
      ) AS exhausted,
      bool_or(
        authority."id" IS NOT NULL
        AND authority."revoked_at" IS NULL
        AND revocation."authority_id" IS NULL
        AND evaluation.time_state = 'NOT_YET_VALID'
        AND authority."runs_consumed" < authority."max_runs"
        AND evaluation.campaign_remaining > 0
      ) AS not_yet_valid,
      bool_or(
        authority."id" IS NOT NULL
        AND authority."revoked_at" IS NULL
        AND revocation."authority_id" IS NULL
        AND evaluation.time_state = 'EXPIRED'
      ) AS expired,
      bool_or(
        authority."id" IS NOT NULL
        AND (
          authority."revoked_at" IS NOT NULL
          OR revocation."authority_id" IS NOT NULL
        )
      ) AS revoked,
      bool_or(
        authority."id" IS NOT NULL
        AND authority."revoked_at" IS NULL
        AND revocation."authority_id" IS NULL
        AND evaluation.time_state = 'INVALID'
      ) AS invalid
    FROM required
    LEFT JOIN "execution_budget_authority" authority
      ON authority."scope_key" = 'platform'
     AND authority."authority_kind" = 'PLATFORM_GRANT'
     AND authority."purpose" = required.required_purpose
    LEFT JOIN "execution_budget_authority_revocation" revocation
      ON revocation."scope_key" = 'platform'
     AND revocation."authority_id" = authority."id"
    LEFT JOIN LATERAL (
      SELECT
        execution_budget_authority_time_state(
          authority."issued_at",
          authority."not_before",
          authority."expires_at",
          p_verification_time
        ) AS time_state,
        execution_budget_authority_campaign_remaining_microusd(
          authority."campaign_cap_microusd",
          authority."runs_consumed",
          authority."cap_per_run_microusd"
        ) AS campaign_remaining
    ) evaluation ON authority."id" IS NOT NULL
    GROUP BY required.required_purpose
  )
  SELECT
    observations.required_purpose::text,
    CASE
      WHEN observations.active THEN 'active'
      WHEN observations.authority_count = 0 THEN 'missing'
      WHEN observations.exhausted THEN 'exhausted'
      WHEN observations.not_yet_valid THEN 'not_yet_valid'
      WHEN observations.expired THEN 'expired'
      WHEN observations.revoked THEN 'revoked'
      WHEN observations.invalid THEN 'invalid'
      ELSE 'invalid'
    END
  FROM observations
  ORDER BY array_position(
    ARRAY[
      'platform.acquisition',
      'platform.intent_watch',
      'platform.sanctions'
    ]::text[],
    observations.required_purpose::text
  );
END
$$;

-- Authority-bound accounts deliberately cannot enter the legacy cents
-- lifecycle. These replacements preserve the exact unbound behavior and
-- signatures from the earlier retained migration while adding one mechanical
-- pre-mutation fence.
CREATE OR REPLACE FUNCTION open_tool_budget(
  p_scope_key TEXT,
  p_account_key TEXT,
  p_cap_cents BIGINT,
  p_replay_scope BOOLEAN DEFAULT false
)
RETURNS TABLE(account_id UUID, generation INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v "tool_budget_account"%ROWTYPE;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) OR char_length(p_account_key) NOT BETWEEN 1 AND 200 OR p_cap_cents < 0 THEN
    RAISE EXCEPTION 'invalid tool budget account';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tool-budget-' || p_scope_key || '-' || p_account_key));
  SELECT * INTO v FROM "tool_budget_account" WHERE "scope_key"=p_scope_key AND "account_key"=p_account_key FOR UPDATE;
  IF v."id" IS NOT NULL AND v."authority_id" IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;
  IF v."id" IS NULL THEN
    INSERT INTO "tool_budget_account"("scope_key","account_key","cap_cents") VALUES(p_scope_key,p_account_key,p_cap_cents) RETURNING * INTO v;
  ELSIF v."ref_count" = 0 THEN
    IF EXISTS (
      SELECT 1 FROM "tool_budget_operation" AS operation
      WHERE operation."account_id"=v."id"
        AND operation."generation"=v."generation"
        AND operation."status"='RESERVED'
    ) THEN
      RAISE EXCEPTION 'TOOL_BUDGET_UNSETTLED_OPERATIONS';
    END IF;
    IF p_replay_scope THEN
      UPDATE "tool_budget_account" AS target
      SET "ref_count"=1,"closed_at"=NULL,"updated_at"=clock_timestamp()
      WHERE target."id"=v."id" RETURNING target.* INTO v;
    ELSE
      UPDATE "tool_budget_account" AS target
      SET "generation"=target."generation"+1,"cap_cents"=p_cap_cents,
          "reserved_cents"=0,"charged_cents"=0,"exhausted"=false,
          "ref_count"=1,"closed_at"=NULL,"updated_at"=clock_timestamp()
      WHERE target."id"=v."id" RETURNING target.* INTO v;
    END IF;
  ELSIF v."cap_cents" <> p_cap_cents THEN
    RAISE EXCEPTION 'TOOL_BUDGET_CAP_MISMATCH';
  ELSE
    UPDATE "tool_budget_account" SET "ref_count"="ref_count"+1,"updated_at"=clock_timestamp() WHERE "id"=v."id" RETURNING * INTO v;
  END IF;
  RETURN QUERY SELECT v."id",v."generation";
END $$;

CREATE OR REPLACE FUNCTION reserve_tool_budget(
  p_scope_key TEXT,
  p_account_key TEXT,
  p_operation_key TEXT,
  p_reservation_cents BIGINT
)
RETURNS TABLE(kind TEXT, operation_id UUID, reserved_cents BIGINT, remaining_cents BIGINT, status TEXT, result_json JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a "tool_budget_account"%ROWTYPE; o "tool_budget_operation"%ROWTYPE;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) OR char_length(p_operation_key) NOT BETWEEN 1 AND 200 OR p_reservation_cents < 0 THEN RAISE EXCEPTION 'invalid tool budget reservation'; END IF;
  SELECT * INTO a FROM "tool_budget_account" WHERE "scope_key"=p_scope_key AND "account_key"=p_account_key FOR UPDATE;
  IF a."id" IS NULL OR a."ref_count"=0 THEN RAISE EXCEPTION 'TOOL_BUDGET_ACCOUNT_UNAVAILABLE'; END IF;
  IF a."authority_id" IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM "tool_budget_operation" WHERE "account_id"=a."id" AND "generation"=a."generation" AND "operation_key"=p_operation_key FOR UPDATE;
  IF o."id" IS NOT NULL THEN RETURN QUERY SELECT 'REPLAY',o."id",o."reserved_cents",a."cap_cents"-a."reserved_cents"-a."charged_cents",o."status"::text,o."result_json"; RETURN; END IF;
  IF a."exhausted" THEN
    RETURN QUERY SELECT 'DENIED',NULL::UUID,0::BIGINT,a."cap_cents"-a."reserved_cents"-a."charged_cents",'EXHAUSTED',NULL::JSONB; RETURN;
  END IF;
  IF p_reservation_cents > a."cap_cents"-a."reserved_cents"-a."charged_cents" THEN
    UPDATE "tool_budget_account" SET "exhausted"=true,"updated_at"=clock_timestamp() WHERE "id"=a."id";
    RETURN QUERY SELECT 'DENIED',NULL::UUID,0::BIGINT,a."cap_cents"-a."reserved_cents"-a."charged_cents",'EXHAUSTED',NULL::JSONB; RETURN;
  END IF;
  INSERT INTO "tool_budget_operation"("scope_key","account_id","generation","operation_key","reserved_cents") VALUES(p_scope_key,a."id",a."generation",p_operation_key,p_reservation_cents) RETURNING * INTO o;
  UPDATE "tool_budget_account" AS target
  SET "reserved_cents"=target."reserved_cents"+p_reservation_cents,
      "updated_at"=clock_timestamp()
  WHERE target."id"=a."id" RETURNING target.* INTO a;
  RETURN QUERY SELECT 'EXECUTE',o."id",o."reserved_cents",a."cap_cents"-a."reserved_cents"-a."charged_cents",o."status"::text,NULL::JSONB;
END $$;

CREATE OR REPLACE FUNCTION settle_tool_budget(
  p_scope_key TEXT, p_operation_id UUID, p_observed_cents BIGINT,
  p_result_schema_version TEXT, p_result_schema TEXT, p_result_digest TEXT,
  p_result_json JSONB
)
RETURNS TABLE(charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN, status TEXT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a "tool_budget_account"%ROWTYPE; o "tool_budget_operation"%ROWTYPE; charge BIGINT;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) OR p_observed_cents < 0 THEN RAISE EXCEPTION 'invalid tool budget settlement'; END IF;
  IF EXISTS (
    SELECT 1
    FROM "tool_budget_operation" operation
    JOIN "tool_budget_account" account ON account."id"=operation."account_id"
    WHERE operation."id"=p_operation_id
      AND operation."scope_key"=p_scope_key
      AND account."authority_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT (
    (p_result_json IS NULL AND p_result_schema_version IS NULL AND p_result_schema IS NULL AND p_result_digest IS NULL)
    OR
    (p_result_json IS NOT NULL AND p_result_schema_version IS NOT NULL AND p_result_schema IS NOT NULL AND p_result_digest IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_PROJECTION_INVALID';
  END IF;
  IF p_result_json IS NOT NULL THEN
    IF jsonb_typeof(p_result_json) <> 'object' THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_PROJECTION_INVALID';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_result_json)) <> 5
      OR p_result_schema_version IS DISTINCT FROM 'generic-operation-projection/v1'
      OR COALESCE(p_result_schema !~ '^[a-z][a-z0-9_-]{1,63}/v[1-9][0-9]{0,3}$', true)
      OR COALESCE(p_result_digest !~ '^[0-9a-f]{64}$', true)
      OR p_result_json->>'schemaVersion' IS DISTINCT FROM p_result_schema_version
      OR p_result_json->>'schema' IS DISTINCT FROM p_result_schema
      OR p_result_json->>'digest' IS DISTINCT FROM p_result_digest
      OR COALESCE(p_result_json->>'kind' NOT IN ('model', 'tool'), true)
      OR NOT (p_result_json ? 'data')
      OR p_result_digest IS DISTINCT FROM generic_operation_projection_digest(p_result_json)
      OR jsonb_path_exists(
        p_result_json,
        '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(authorization|headers|prompt|rawresponse|token)$" flag "i")'
      )
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_PROJECTION_INVALID';
    END IF;
  END IF;
  SELECT * INTO o FROM "tool_budget_operation" WHERE "id"=p_operation_id AND "scope_key"=p_scope_key FOR UPDATE;
  IF o."id" IS NULL THEN RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE'; END IF;
  SELECT * INTO a FROM "tool_budget_account" WHERE "id"=o."account_id" AND "scope_key"=p_scope_key FOR UPDATE;
  IF o."status" <> 'RESERVED' THEN
    IF o."status" <> 'SETTLED'
      OR o."observed_cents" IS DISTINCT FROM p_observed_cents
      OR o."result_schema_version" IS DISTINCT FROM p_result_schema_version
      OR o."result_schema" IS DISTINCT FROM p_result_schema
      OR o."result_digest" IS DISTINCT FROM p_result_digest
      OR o."result_json" IS DISTINCT FROM p_result_json
    THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_SETTLEMENT_CONFLICT';
    END IF;
    RETURN QUERY SELECT o."charged_cents",o."observed_cents",o."observed_cents">o."reserved_cents",o."status"::text,true;
    RETURN;
  END IF;
  charge:=o."reserved_cents";
  UPDATE "tool_budget_operation" SET
    "observed_cents"=p_observed_cents,"charged_cents"=charge,"status"='SETTLED',
    "result_schema_version"=p_result_schema_version,"result_schema"=p_result_schema,
    "result_digest"=p_result_digest,"result_json"=p_result_json,
    "settled_at"=clock_timestamp()
  WHERE "id"=o."id" RETURNING * INTO o;
  UPDATE "tool_budget_account" AS target
  SET "reserved_cents"=target."reserved_cents"-o."reserved_cents",
      "charged_cents"=target."charged_cents"+charge,
      "exhausted"=(target."exhausted" OR p_observed_cents>o."reserved_cents"),
      "updated_at"=clock_timestamp()
  WHERE target."id"=a."id";
  RETURN QUERY SELECT charge,p_observed_cents,p_observed_cents>o."reserved_cents",o."status"::text,false;
END $$;

CREATE OR REPLACE FUNCTION release_tool_budget(p_scope_key TEXT, p_operation_id UUID)
RETURNS TABLE(charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN, status TEXT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a "tool_budget_account"%ROWTYPE; o "tool_budget_operation"%ROWTYPE;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) THEN RAISE EXCEPTION 'workspace scope mismatch'; END IF;
  IF EXISTS (
    SELECT 1
    FROM "tool_budget_operation" operation
    JOIN "tool_budget_account" account ON account."id"=operation."account_id"
    WHERE operation."id"=p_operation_id
      AND operation."scope_key"=p_scope_key
      AND account."authority_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM "tool_budget_operation" WHERE "id"=p_operation_id AND "scope_key"=p_scope_key FOR UPDATE;
  IF o."id" IS NULL THEN RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE'; END IF;
  SELECT * INTO a FROM "tool_budget_account" WHERE "id"=o."account_id" AND "scope_key"=p_scope_key FOR UPDATE;
  IF o."status"='RESERVED' THEN
    UPDATE "tool_budget_operation" SET "observed_cents"=0,"charged_cents"=0,"status"='RELEASED',"settled_at"=clock_timestamp() WHERE "id"=o."id" RETURNING * INTO o;
    UPDATE "tool_budget_account" AS target
    SET "reserved_cents"=target."reserved_cents"-o."reserved_cents",
        "updated_at"=clock_timestamp()
    WHERE target."id"=a."id";
    RETURN QUERY SELECT o."charged_cents",o."observed_cents",false,o."status"::text,false;
    RETURN;
  END IF;
  RETURN QUERY SELECT o."charged_cents",o."observed_cents",false,o."status"::text,true;
END $$;

CREATE OR REPLACE FUNCTION tool_budget_status(p_scope_key TEXT, p_account_key TEXT)
RETURNS TABLE(remaining_cents BIGINT, exhausted BOOLEAN, ref_count INTEGER, generation INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE account "tool_budget_account"%ROWTYPE;
BEGIN
  SELECT * INTO account
  FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key
    AND target."account_key"=p_account_key
    AND ((p_scope_key = 'platform' AND session_user <> 'app_user') OR p_scope_key=current_workspace_id()::text)
  FOR SHARE;
  IF account."id" IS NULL THEN RETURN; END IF;
  IF account."authority_id" IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT
    account."cap_cents"-account."reserved_cents"-account."charged_cents",
    account."exhausted", account."ref_count", account."generation";
END $$;

CREATE OR REPLACE FUNCTION close_tool_budget(p_scope_key TEXT, p_account_key TEXT, p_force BOOLEAN DEFAULT false)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE account "tool_budget_account"%ROWTYPE;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) THEN RAISE EXCEPTION 'workspace scope mismatch'; END IF;
  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "scope_key"=p_scope_key AND "account_key"=p_account_key
  FOR UPDATE;
  IF account."id" IS NULL THEN RETURN; END IF;
  IF account."authority_id" IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE "tool_budget_account" SET "ref_count"=CASE WHEN p_force THEN 0 ELSE GREATEST(0,"ref_count"-1) END,"closed_at"=CASE WHEN p_force OR "ref_count"<=1 THEN clock_timestamp() ELSE NULL END,"updated_at"=clock_timestamp()
  WHERE "id"=account."id";
END $$;

REVOKE ALL ON TABLE
  "execution_budget_authority",
  "execution_budget_authority_revocation"
FROM PUBLIC;
REVOKE ALL ON TABLE
  "execution_budget_authority",
  "execution_budget_authority_revocation"
FROM app_user;
REVOKE ALL ON TABLE
  "execution_budget_authority",
  "execution_budget_authority_revocation"
FROM execution_budget_platform_writer;

GRANT SELECT ON TABLE "execution_budget_authority" TO app_user;
GRANT SELECT, INSERT ON TABLE "execution_budget_authority_revocation" TO app_user;
GRANT SELECT ON TABLE
  "execution_budget_authority",
  "execution_budget_authority_revocation"
TO execution_budget_platform_writer;
GRANT USAGE ON SCHEMA public TO execution_budget_platform_writer;

REVOKE ALL ON FUNCTION
  assert_execution_budget_platform_writer_principal(),
  execution_budget_authority_time_state(
    TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
  ),
  execution_budget_authority_campaign_remaining_microusd(
    BIGINT, BIGINT, BIGINT
  ),
  mark_execution_budget_authority_revoked(),
  consume_workspace_execution_authority(
    TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", UUID, TEXT,
    TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
  ),
  ingest_platform_execution_authority(
    TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
    TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ,
    TIMESTAMPTZ
  ),
  open_authorized_tool_budget_v1(TEXT, UUID, TEXT, BOOLEAN),
  revoke_platform_execution_authority_v1(UUID, TEXT, TIMESTAMPTZ),
  inspect_platform_execution_authority_freshness_v1(TIMESTAMPTZ)
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  assert_execution_budget_platform_writer_principal(),
  execution_budget_authority_time_state(
    TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
  ),
  execution_budget_authority_campaign_remaining_microusd(
    BIGINT, BIGINT, BIGINT
  ),
  mark_execution_budget_authority_revoked(),
  ingest_platform_execution_authority(
    TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
    TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ,
    TIMESTAMPTZ
  ),
  revoke_platform_execution_authority_v1(UUID, TEXT, TIMESTAMPTZ),
  inspect_platform_execution_authority_freshness_v1(TIMESTAMPTZ)
FROM app_user;
REVOKE EXECUTE ON FUNCTION
  assert_execution_budget_platform_writer_principal(),
  execution_budget_authority_time_state(
    TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
  ),
  execution_budget_authority_campaign_remaining_microusd(
    BIGINT, BIGINT, BIGINT
  ),
  mark_execution_budget_authority_revoked(),
  consume_workspace_execution_authority(
    TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", UUID, TEXT,
    TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
  )
FROM execution_budget_platform_writer;

GRANT EXECUTE ON FUNCTION
  consume_workspace_execution_authority(
    TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", UUID, TEXT,
    TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
  ),
  open_authorized_tool_budget_v1(TEXT, UUID, TEXT, BOOLEAN)
TO app_user;
GRANT EXECUTE ON FUNCTION
  ingest_platform_execution_authority(
    TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
    TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ,
    TIMESTAMPTZ
  ),
  open_authorized_tool_budget_v1(TEXT, UUID, TEXT, BOOLEAN),
  revoke_platform_execution_authority_v1(UUID, TEXT, TIMESTAMPTZ),
  inspect_platform_execution_authority_freshness_v1(TIMESTAMPTZ)
TO execution_budget_platform_writer;

COMMIT;
