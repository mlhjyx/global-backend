-- Additive execution-budget authority, revocation and Tool budget binding.
-- Historical accounts remain unbound; legacy open_tool_budget remains callable
-- until the separately reviewed authority cutover.

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

  IF p_not_before > clock_timestamp() THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_expires_at <= clock_timestamp() THEN
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
BEGIN
  IF NOT pg_has_role(
      session_user,
      'execution_budget_platform_writer',
      'member'
    )
    OR NOT COALESCE(char_length(btrim(p_issuer)) BETWEEN 1 AND 512, false)
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
    OR NOT COALESCE(char_length(btrim(p_subject_type)) BETWEEN 1 AND 191, false)
    OR NOT COALESCE(char_length(btrim(p_subject_id)) BETWEEN 1 AND 191, false)
    OR NOT COALESCE(char_length(btrim(p_schedule_id)) BETWEEN 1 AND 191, false)
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

  IF p_not_before > clock_timestamp() THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_expires_at <= clock_timestamp() THEN
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
BEGIN
  IF p_authority_id IS NULL
    OR char_length(p_scope_key) NOT BETWEEN 1 AND 200
    OR char_length(p_account_key) NOT BETWEEN 1 AND 200
    OR (
      pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
      AND p_scope_key IS DISTINCT FROM 'platform'
    )
    OR (
      NOT pg_has_role(
        session_user,
        'execution_budget_platform_writer',
        'member'
      )
      AND (
        p_scope_key = 'platform'
        OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
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
  IF authority."not_before" > clock_timestamp() THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF authority."expires_at" <= clock_timestamp() THEN
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
    campaign_remaining := authority."campaign_cap_microusd"::numeric
      - authority."runs_consumed"::numeric
        * authority."cap_per_run_microusd"::numeric;
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
      p_scope_key, p_account_key, authorized_cap, authority."id", authorized_cap
    ) RETURNING * INTO account;
  ELSE
    UPDATE "tool_budget_account" target
    SET "generation" = target."generation" + 1,
        "cap_cents" = authorized_cap,
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
  open_authorized_tool_budget_v1(TEXT, UUID, TEXT, BOOLEAN)
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  mark_execution_budget_authority_revoked(),
  ingest_platform_execution_authority(
    TEXT, TEXT, UUID, TEXT, TEXT, "execution_budget_purpose", TEXT, TEXT,
    TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ,
    TIMESTAMPTZ
  )
FROM app_user;
REVOKE EXECUTE ON FUNCTION
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
  open_authorized_tool_budget_v1(TEXT, UUID, TEXT, BOOLEAN)
TO execution_budget_platform_writer;

COMMIT;
