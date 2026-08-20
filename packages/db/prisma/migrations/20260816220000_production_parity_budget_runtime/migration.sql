-- Production parity: immutable SaaS budget grants, append-only settlement
-- reconciliation, shared ToolBroker budgets, and managed process identity.
-- Additive and forward-only: historical BuildRuns are not assigned fabricated grants.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

-- Deployment precondition: the migrate principal needs CREATEROLE only while
-- one of the fixed runtime writer group roles is absent. Fail before creating
-- any schema object so a corrected principal can safely rerun the migration.
DO $$
DECLARE
  missing_runtime_role BOOLEAN;
  can_create_role BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM (VALUES
      ('runtime_api'), ('runtime_worker'), ('runtime_outbox_relay')
    ) AS required(role_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = required.role_name
    )
  ) INTO missing_runtime_role;
  SELECT rolsuper OR rolcreaterole INTO can_create_role
  FROM pg_roles WHERE rolname = current_user;
  IF missing_runtime_role AND NOT COALESCE(can_create_role, false) THEN
    RAISE EXCEPTION 'PRODUCTION_PARITY_MIGRATION_REQUIRES_CREATEROLE';
  END IF;
END $$;

CREATE TYPE "runtime_process_role" AS ENUM ('API', 'WORKER', 'OUTBOX_RELAY');
CREATE TYPE "runtime_process_state" AS ENUM ('STARTING', 'READY', 'DRAINING', 'STOPPED');
CREATE TYPE "site_build_spend_reconciliation_status" AS ENUM ('UNRESOLVED', 'RESOLVED', 'CONFLICT', 'EXPIRED');
CREATE TYPE "tool_budget_operation_status" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

-- Runtime writers use distinct login principals that are members of exactly
-- one fixed NOLOGIN role. The ordinary app_user can only read leases for
-- readiness and can never mint a READY Worker/Relay identity.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_api') THEN
    CREATE ROLE runtime_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_worker') THEN
    CREATE ROLE runtime_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_outbox_relay') THEN
    CREATE ROLE runtime_outbox_relay NOLOGIN;
  END IF;
END $$;

CREATE TABLE "runtime_process_lease" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "instance_id" UUID NOT NULL,
  "role" "runtime_process_role" NOT NULL,
  "state" "runtime_process_state" NOT NULL DEFAULT 'STARTING',
  "task_queue" VARCHAR(191),
  "build_sha" VARCHAR(40) NOT NULL,
  "image_digest" VARCHAR(71) NOT NULL,
  "artifact_digest" VARCHAR(71) NOT NULL,
  "migration_revision" VARCHAR(191) NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
  "stopped_at" TIMESTAMPTZ(3),
  CONSTRAINT "runtime_process_lease_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "runtime_process_lease_instance_id_key" UNIQUE ("instance_id"),
  CONSTRAINT "runtime_process_lease_build_sha_check" CHECK ("build_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "runtime_process_lease_image_digest_check" CHECK ("image_digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "runtime_process_lease_artifact_digest_check" CHECK ("artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "runtime_process_lease_queue_check" CHECK (
    ("role" = 'WORKER' AND char_length("task_queue") BETWEEN 1 AND 191)
    OR ("role" <> 'WORKER' AND "task_queue" IS NULL)
  ),
  CONSTRAINT "runtime_process_lease_time_check" CHECK (
    "last_seen_at" >= "started_at"
    AND (("state" = 'STOPPED' AND "stopped_at" IS NOT NULL) OR ("state" <> 'STOPPED' AND "stopped_at" IS NULL))
  )
);
CREATE INDEX "runtime_process_lease_role_state_seen_idx" ON "runtime_process_lease"("role", "state", "last_seen_at");
CREATE INDEX "runtime_process_lease_queue_state_seen_idx" ON "runtime_process_lease"("task_queue", "state", "last_seen_at");
CREATE INDEX "runtime_process_lease_artifact_state_seen_idx" ON "runtime_process_lease"("image_digest", "artifact_digest", "state", "last_seen_at");

CREATE FUNCTION register_runtime_process_lease(
  p_instance_id UUID,
  p_role "runtime_process_role",
  p_task_queue TEXT,
  p_build_sha TEXT,
  p_image_digest TEXT,
  p_artifact_digest TEXT,
  p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v "runtime_process_lease"%ROWTYPE;
BEGIN
  IF p_started_at > clock_timestamp() + INTERVAL '1 minute' THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID';
  END IF;
  SELECT * INTO v FROM "runtime_process_lease" WHERE "instance_id"=p_instance_id FOR UPDATE;
  IF v."id" IS NULL THEN
    INSERT INTO "runtime_process_lease"(
      "instance_id","role","state","task_queue","build_sha","image_digest",
      "artifact_digest","migration_revision","started_at","last_seen_at"
    ) VALUES(
      p_instance_id,p_role,'STARTING',p_task_queue,p_build_sha,p_image_digest,
      p_artifact_digest,p_migration_revision,p_started_at,p_started_at
    ) RETURNING * INTO v;
  ELSIF v."role" IS DISTINCT FROM p_role
    OR v."task_queue" IS DISTINCT FROM p_task_queue
    OR v."build_sha" IS DISTINCT FROM p_build_sha
    OR v."image_digest" IS DISTINCT FROM p_image_digest
    OR v."artifact_digest" IS DISTINCT FROM p_artifact_digest
    OR v."migration_revision" IS DISTINCT FROM p_migration_revision
    OR v."started_at" IS DISTINCT FROM p_started_at
  THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_IDENTITY_MISMATCH';
  ELSIF v."state"='STOPPED' THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_STOPPED';
  END IF;
  RETURN v."id";
END $$;

CREATE FUNCTION heartbeat_runtime_process_lease(
  p_instance_id UUID,
  p_state "runtime_process_state",
  p_last_seen_at TIMESTAMPTZ
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v "runtime_process_lease"%ROWTYPE;
BEGIN
  SELECT * INTO v FROM "runtime_process_lease" WHERE "instance_id"=p_instance_id FOR UPDATE;
  IF v."id" IS NULL THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_NOT_FOUND'; END IF;
  IF p_last_seen_at < v."last_seen_at" OR p_last_seen_at > clock_timestamp() + INTERVAL '1 minute' THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID';
  END IF;
  IF NOT (
    (v."state"='STARTING' AND p_state IN ('STARTING','READY','DRAINING','STOPPED'))
    OR (v."state"='READY' AND p_state IN ('READY','DRAINING','STOPPED'))
    OR (v."state"='DRAINING' AND p_state IN ('DRAINING','STOPPED'))
    OR (v."state"='STOPPED' AND p_state='STOPPED')
  ) THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_STATE_TRANSITION_INVALID'; END IF;
  UPDATE "runtime_process_lease" SET "state"=p_state,
    "last_seen_at"=LEAST(p_last_seen_at,clock_timestamp()),
    "stopped_at"=CASE WHEN p_state='STOPPED' THEN LEAST(p_last_seen_at,clock_timestamp()) ELSE NULL END
  WHERE "id"=v."id";
END $$;

CREATE FUNCTION register_api_runtime_process_lease(
  p_instance_id UUID, p_task_queue TEXT, p_build_sha TEXT,
  p_image_digest TEXT, p_artifact_digest TEXT, p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_api', 'member') OR p_task_queue IS NOT NULL THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED';
  END IF;
  RETURN register_runtime_process_lease(
    p_instance_id, 'API', NULL, p_build_sha, p_image_digest,
    p_artifact_digest, p_migration_revision, p_started_at
  );
END $$;

CREATE FUNCTION register_worker_runtime_process_lease(
  p_instance_id UUID, p_task_queue TEXT, p_build_sha TEXT,
  p_image_digest TEXT, p_artifact_digest TEXT, p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED';
  END IF;
  RETURN register_runtime_process_lease(
    p_instance_id, 'WORKER', p_task_queue, p_build_sha, p_image_digest,
    p_artifact_digest, p_migration_revision, p_started_at
  );
END $$;

CREATE FUNCTION register_outbox_relay_runtime_process_lease(
  p_instance_id UUID, p_task_queue TEXT, p_build_sha TEXT,
  p_image_digest TEXT, p_artifact_digest TEXT, p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_outbox_relay', 'member') OR p_task_queue IS NOT NULL THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED';
  END IF;
  RETURN register_runtime_process_lease(
    p_instance_id, 'OUTBOX_RELAY', NULL, p_build_sha, p_image_digest,
    p_artifact_digest, p_migration_revision, p_started_at
  );
END $$;

CREATE FUNCTION heartbeat_api_runtime_process_lease(
  p_instance_id UUID, p_state "runtime_process_state", p_last_seen_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_api', 'member') OR NOT EXISTS (
    SELECT 1 FROM "runtime_process_lease" WHERE "instance_id"=p_instance_id AND "role"='API'
  ) THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED'; END IF;
  PERFORM heartbeat_runtime_process_lease(p_instance_id,p_state,p_last_seen_at);
END $$;

CREATE FUNCTION heartbeat_worker_runtime_process_lease(
  p_instance_id UUID, p_state "runtime_process_state", p_last_seen_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') OR NOT EXISTS (
    SELECT 1 FROM "runtime_process_lease" WHERE "instance_id"=p_instance_id AND "role"='WORKER'
  ) THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED'; END IF;
  PERFORM heartbeat_runtime_process_lease(p_instance_id,p_state,p_last_seen_at);
END $$;

CREATE FUNCTION heartbeat_outbox_relay_runtime_process_lease(
  p_instance_id UUID, p_state "runtime_process_state", p_last_seen_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_outbox_relay', 'member') OR NOT EXISTS (
    SELECT 1 FROM "runtime_process_lease" WHERE "instance_id"=p_instance_id AND "role"='OUTBOX_RELAY'
  ) THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED'; END IF;
  PERFORM heartbeat_runtime_process_lease(p_instance_id,p_state,p_last_seen_at);
END $$;

CREATE TABLE "site_build_budget_grant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "issuer" VARCHAR(512) NOT NULL,
  "audience" VARCHAR(256) NOT NULL,
  "jti" UUID NOT NULL,
  "schema_version" VARCHAR(80) NOT NULL,
  "purpose" VARCHAR(80) NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "request_sha256" VARCHAR(64) NOT NULL,
  "token_sha256" VARCHAR(64) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "unit" VARCHAR(16) NOT NULL,
  "cap_microusd" BIGINT NOT NULL,
  "issued_at" TIMESTAMPTZ(3) NOT NULL,
  "not_before" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_build_budget_grant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_budget_grant_build_run_id_key" UNIQUE ("build_run_id"),
  CONSTRAINT "site_build_budget_grant_issuer_jti_key" UNIQUE ("issuer", "jti"),
  CONSTRAINT "site_build_budget_grant_claims_check" CHECK (
    "schema_version" = 'site-builder-budget-grant/v1'
    AND "audience" = 'global-backend:site-builder-budget'
    AND "purpose" = 'site_builder.build_run'
    AND "operation" IN ('refurbish', 'intake')
    AND "currency" = 'USD'
    AND "unit" = 'microusd'
    AND "cap_microusd" > 0
    AND "request_sha256" ~ '^[0-9a-f]{64}$'
    AND "token_sha256" ~ '^[0-9a-f]{64}$'
    AND "issued_at" <= "not_before"
    AND "not_before" <= "expires_at"
    AND "expires_at" <= "issued_at" + INTERVAL '5 minutes'
  ),
  CONSTRAINT "site_build_budget_grant_run_scope_fkey" FOREIGN KEY ("build_run_id", "workspace_id", "site_id")
    REFERENCES "site_build_run"("id", "workspace_id", "site_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "site_build_budget_grant_scope_key" ON "site_build_budget_grant"("build_run_id", "workspace_id", "site_id");
CREATE INDEX "site_build_budget_grant_workspace_site_consumed_idx" ON "site_build_budget_grant"("workspace_id", "site_id", "consumed_at");

CREATE FUNCTION enforce_site_build_budget_grant_consumption()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  NEW."consumed_at" := clock_timestamp();
  IF NEW."consumed_at" > NEW."expires_at" + INTERVAL '60 seconds' THEN
    RAISE EXCEPTION 'BUDGET_GRANT_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "site_build_budget_grant_consumption_guard"
  BEFORE INSERT ON "site_build_budget_grant"
  FOR EACH ROW EXECUTE FUNCTION enforce_site_build_budget_grant_consumption();

CREATE UNIQUE INDEX "site_build_spend_scope_key"
  ON "site_build_spend"("id", "workspace_id", "site_id", "build_run_id");

CREATE TABLE "site_build_spend_reconciliation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "spend_id" UUID NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "status" "site_build_spend_reconciliation_status" NOT NULL,
  "resolver_id" VARCHAR(191) NOT NULL,
  "request_id" VARCHAR(191),
  "receipt_digest" VARCHAR(64),
  "cost_basis" VARCHAR(32),
  "exact_cost_microusd" BIGINT,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  "meta" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_build_spend_reconciliation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_spend_reconciliation_attempt_key" UNIQUE ("spend_id", "attempt_no"),
  CONSTRAINT "site_build_spend_reconciliation_receipt_key" UNIQUE ("spend_id", "receipt_digest"),
  CONSTRAINT "site_build_spend_reconciliation_spend_scope_fkey" FOREIGN KEY ("spend_id", "workspace_id", "site_id", "build_run_id")
    REFERENCES "site_build_spend"("id", "workspace_id", "site_id", "build_run_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "site_build_spend_reconciliation_shape_check" CHECK (
    "attempt_no" >= 1
    AND ("receipt_digest" IS NULL OR "receipt_digest" ~ '^[0-9a-f]{64}$')
    AND ("exact_cost_microusd" IS NULL OR "exact_cost_microusd" >= 0)
    AND ("input_tokens" IS NULL OR "input_tokens" >= 0)
    AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
    AND ("meta" IS NULL OR jsonb_typeof("meta") = 'object')
    AND (("status" = 'RESOLVED' AND "receipt_digest" IS NOT NULL AND "exact_cost_microusd" IS NOT NULL AND "cost_basis" IN ('provider_reported', 'token_pricing'))
      OR ("status" <> 'RESOLVED' AND "exact_cost_microusd" IS NULL AND "cost_basis" IS NULL))
  )
);
CREATE UNIQUE INDEX "site_build_spend_reconciliation_one_resolved_idx"
  ON "site_build_spend_reconciliation"("spend_id") WHERE "status" = 'RESOLVED';
CREATE INDEX "site_build_spend_reconciliation_workspace_run_status_idx"
  ON "site_build_spend_reconciliation"("workspace_id", "build_run_id", "status", "created_at");

-- Supersede the historical hard-cap guard. A provider-reported exact amount
-- above the admitted reservation is a known CAP_VARIANCE, not UNKNOWN: retain
-- the execution status and durable result, charge the user at most the
-- reservation, stop later paid calls, and append an immutable variance fact.
ALTER FUNCTION settle_site_build_spend(UUID, UUID, VARCHAR, UUID, TEXT, BIGINT, TEXT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, JSONB, JSONB, TEXT)
  RENAME TO settle_site_build_spend_legacy_20260719;
REVOKE ALL ON FUNCTION settle_site_build_spend_legacy_20260719(UUID, UUID, VARCHAR, UUID, TEXT, BIGINT, TEXT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, JSONB, JSONB, TEXT)
  FROM PUBLIC, app_user;

CREATE FUNCTION settle_site_build_spend(
  p_workspace_id UUID,
  p_build_run_id UUID,
  p_operation_key VARCHAR(64),
  p_fence_token UUID,
  p_status TEXT,
  p_budget_charge_microusd BIGINT,
  p_cost_basis TEXT,
  p_reported_cost_microusd BIGINT,
  p_calculated_cost_microusd BIGINT,
  p_estimated_cost_microusd BIGINT,
  p_input_tokens INTEGER,
  p_output_tokens INTEGER,
  p_call_count INTEGER,
  p_result_json JSONB,
  p_meta JSONB,
  p_error_code TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_budget "site_build_budget"%ROWTYPE;
  v_spend "site_build_spend"%ROWTYPE;
  v_reservation BIGINT;
  v_attempt_no INTEGER;
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  SELECT "reservation_microusd" INTO v_reservation
  FROM "site_build_spend"
  WHERE "workspace_id" = p_workspace_id
    AND "build_run_id" = p_build_run_id
    AND "operation_key" = p_operation_key;

  IF v_reservation IS NULL OR p_budget_charge_microusd <= v_reservation THEN
    RETURN settle_site_build_spend_legacy_20260719(
      p_workspace_id, p_build_run_id, p_operation_key, p_fence_token,
      p_status, p_budget_charge_microusd, p_cost_basis,
      p_reported_cost_microusd, p_calculated_cost_microusd,
      p_estimated_cost_microusd, p_input_tokens, p_output_tokens,
      p_call_count, p_result_json, p_meta, p_error_code
    );
  END IF;

  IF p_status NOT IN ('SUCCEEDED', 'FAILED', 'RELEASED')
    OR p_budget_charge_microusd < 0
  THEN
    RAISE EXCEPTION 'invalid paid-call settlement';
  END IF;

  SELECT * INTO v_budget
  FROM "site_build_budget"
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  SELECT * INTO v_spend
  FROM "site_build_spend"
  WHERE "workspace_id" = p_workspace_id
    AND "build_run_id" = p_build_run_id
    AND "operation_key" = p_operation_key
  FOR UPDATE;

  IF v_budget."build_run_id" IS NULL OR v_spend."id" IS NULL THEN
    RETURN 'MISSING';
  END IF;
  IF v_spend."status" <> 'RESERVED' THEN
    RETURN 'REPLAY';
  END IF;
  IF v_spend."fence_token" IS DISTINCT FROM p_fence_token THEN
    RETURN 'STALE_FENCE';
  END IF;

  UPDATE "site_build_spend"
  SET "status" = p_status,
      "budget_charge_microusd" = v_spend."reservation_microusd",
      "reported_cost_microusd" = p_reported_cost_microusd,
      "calculated_cost_microusd" = p_calculated_cost_microusd,
      "estimated_cost_microusd" = p_estimated_cost_microusd,
      "cost_basis" = p_cost_basis,
      "input_tokens" = p_input_tokens,
      "output_tokens" = p_output_tokens,
      "call_count" = p_call_count,
      "result_json" = p_result_json,
      "meta" = p_meta,
      "error_code" = 'CAP_VARIANCE',
      "settled_at" = clock_timestamp()
  WHERE "id" = v_spend."id"
    AND "workspace_id" = p_workspace_id;

  UPDATE "site_build_budget"
  SET "reserved_microusd" = GREATEST(
        0, "reserved_microusd" - v_spend."reservation_microusd"
      ),
      "charged_microusd" = "charged_microusd" + v_spend."reservation_microusd",
      "paid_calls_enabled" = false,
      "disabled_reason" = 'settlement_exceeded_reservation',
      "exhausted_at" = COALESCE("exhausted_at", clock_timestamp()),
      "updated_at" = clock_timestamp()
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id;

  PERFORM pg_advisory_xact_lock(
    hashtext('site-build-reconciliation-' || v_spend."id"::text)
  );
  SELECT COALESCE(MAX("attempt_no"), 0) + 1 INTO v_attempt_no
  FROM "site_build_spend_reconciliation"
  WHERE "spend_id" = v_spend."id"
    AND "workspace_id" = p_workspace_id;
  INSERT INTO "site_build_spend_reconciliation"(
    "workspace_id", "site_id", "build_run_id", "spend_id", "attempt_no",
    "status", "resolver_id", "observed_at", "meta"
  ) VALUES (
    v_spend."workspace_id", v_spend."site_id", v_spend."build_run_id",
    v_spend."id", v_attempt_no, 'CONFLICT', 'site-build-cap-variance-v1',
    clock_timestamp(), jsonb_build_object(
      'reason', 'CAP_VARIANCE',
      'observedMicrousd', p_budget_charge_microusd,
      'authorizedMicrousd', v_spend."reservation_microusd"
    )
  );
  RETURN 'OVER_RESERVATION';
END
$$;

-- Cost classification: valid output with temporarily unavailable exact cost is
-- successful and conservatively charged at its reservation upper bound.
ALTER TABLE "site_build_spend" DROP CONSTRAINT "site_build_spend_cost_basis_check";
ALTER TABLE "site_build_spend" DROP CONSTRAINT "site_build_spend_cost_truth_check";
ALTER TABLE "site_build_spend" ADD CONSTRAINT "site_build_spend_cost_basis_check" CHECK (
  ("status" = 'RESERVED' AND "cost_basis" IS NULL)
  OR ("status" <> 'RESERVED' AND "cost_basis" IN (
    'provider_reported', 'token_pricing', 'tool_reported', 'legacy_estimate',
    'estimated_upper_bound', 'unknown', 'not_incurred'
  ))
);
ALTER TABLE "site_build_spend" ADD CONSTRAINT "site_build_spend_cost_truth_check" CHECK (
  ("cost_basis" IN ('provider_reported', 'tool_reported') AND "reported_cost_microusd" IS NOT NULL AND "calculated_cost_microusd" IS NULL AND "estimated_cost_microusd" IS NULL)
  OR ("cost_basis" = 'token_pricing' AND "reported_cost_microusd" IS NULL AND "calculated_cost_microusd" IS NOT NULL AND "estimated_cost_microusd" IS NULL)
  OR ("cost_basis" IN ('legacy_estimate', 'estimated_upper_bound') AND "reported_cost_microusd" IS NULL AND "calculated_cost_microusd" IS NULL AND "estimated_cost_microusd" IS NOT NULL)
  OR ("cost_basis" IN ('unknown', 'not_incurred') AND "reported_cost_microusd" IS NULL AND "calculated_cost_microusd" IS NULL AND "estimated_cost_microusd" IS NULL)
  OR ("status" = 'RESERVED' AND "cost_basis" IS NULL AND "reported_cost_microusd" IS NULL AND "calculated_cost_microusd" IS NULL AND "estimated_cost_microusd" IS NULL)
);

-- Every new physical Site Builder operation must be authorized by the exact
-- immutable Grant that created the BuildRun budget. Historical rows remain readable.
CREATE FUNCTION enforce_site_build_spend_grant()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "site_build_budget_grant" g
    JOIN "site_build_budget" b
      ON b."build_run_id" = g."build_run_id"
     AND b."workspace_id" = g."workspace_id"
     AND b."site_id" = g."site_id"
     AND b."cap_microusd" = g."cap_microusd"
    WHERE g."build_run_id" = NEW."build_run_id"
      AND g."workspace_id" = NEW."workspace_id"
      AND g."site_id" = NEW."site_id"
  ) THEN
    RAISE EXCEPTION 'DENIED_BUDGET_AUTHORIZATION' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "site_build_spend_grant_guard"
  BEFORE INSERT ON "site_build_spend"
  FOR EACH ROW EXECUTE FUNCTION enforce_site_build_spend_grant();

-- Product roles never write budget arithmetic directly. The immutable Grant is
-- the sole authority for opening a SiteBuildBudget; disabling is one-way.
CREATE FUNCTION create_site_build_budget_from_grant(p_workspace_id UUID, p_build_run_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE g "site_build_budget_grant"%ROWTYPE;
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  SELECT * INTO g FROM "site_build_budget_grant"
  WHERE "workspace_id"=p_workspace_id AND "build_run_id"=p_build_run_id;
  IF g."id" IS NULL THEN RAISE EXCEPTION 'DENIED_BUDGET_AUTHORIZATION'; END IF;
  INSERT INTO "site_build_budget"(
    "workspace_id","site_id","build_run_id","cap_microusd","paid_calls_enabled"
  ) VALUES(g."workspace_id",g."site_id",g."build_run_id",g."cap_microusd",true);
END $$;

CREATE FUNCTION disable_site_build_paid_calls(p_workspace_id UUID, p_build_run_id UUID, p_reason TEXT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n INTEGER;
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR char_length(trim(p_reason)) NOT BETWEEN 1 AND 80
  THEN RAISE EXCEPTION 'invalid site build paid-call disable'; END IF;
  UPDATE "site_build_budget" SET "paid_calls_enabled"=false,
    "disabled_reason"=left(trim(p_reason),80),"updated_at"=clock_timestamp()
  WHERE "workspace_id"=p_workspace_id AND "build_run_id"=p_build_run_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

ALTER FUNCTION reserve_site_build_spend(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, TEXT, BIGINT, JSONB) SECURITY DEFINER;
ALTER FUNCTION settle_site_build_spend(UUID, UUID, VARCHAR, UUID, TEXT, BIGINT, TEXT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, JSONB, JSONB, TEXT) SECURITY DEFINER;
ALTER FUNCTION reconcile_site_build_spend(UUID, UUID) SECURITY DEFINER;

CREATE TABLE "tool_budget_account" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "scope_key" VARCHAR(200) NOT NULL,
  "account_key" VARCHAR(200) NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "cap_cents" BIGINT NOT NULL,
  "reserved_cents" BIGINT NOT NULL DEFAULT 0,
  "charged_cents" BIGINT NOT NULL DEFAULT 0,
  "exhausted" BOOLEAN NOT NULL DEFAULT false,
  "ref_count" INTEGER NOT NULL DEFAULT 1,
  "closed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_budget_account_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_budget_account_scope_key" UNIQUE ("scope_key", "account_key"),
  CONSTRAINT "tool_budget_account_scope_id_key" UNIQUE ("scope_key", "id"),
  CONSTRAINT "tool_budget_account_amounts_check" CHECK (
    "generation" >= 1 AND "cap_cents" >= 0 AND "reserved_cents" >= 0
    AND "charged_cents" >= 0 AND "ref_count" >= 0
    AND "reserved_cents" + "charged_cents" <= "cap_cents"
  ),
  CONSTRAINT "tool_budget_account_closed_check" CHECK (
    ("ref_count" = 0 AND "closed_at" IS NOT NULL) OR ("ref_count" > 0 AND "closed_at" IS NULL)
  )
);
CREATE INDEX "tool_budget_account_scope_state_idx" ON "tool_budget_account"("scope_key", "exhausted", "closed_at");

CREATE TABLE "tool_budget_operation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "scope_key" VARCHAR(200) NOT NULL,
  "account_id" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "operation_key" VARCHAR(200) NOT NULL,
  "reserved_cents" BIGINT NOT NULL,
  "observed_cents" BIGINT,
  "charged_cents" BIGINT,
  "status" "tool_budget_operation_status" NOT NULL DEFAULT 'RESERVED',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMPTZ(3),
  CONSTRAINT "tool_budget_operation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tool_budget_operation_generation_key" UNIQUE ("account_id", "generation", "operation_key"),
  CONSTRAINT "tool_budget_operation_account_scope_fkey" FOREIGN KEY ("scope_key", "account_id")
    REFERENCES "tool_budget_account"("scope_key", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "tool_budget_operation_amounts_check" CHECK (
    "generation" >= 1 AND "reserved_cents" >= 0
    AND ("observed_cents" IS NULL OR "observed_cents" >= 0)
    AND ("charged_cents" IS NULL OR ("charged_cents" >= 0 AND "charged_cents" <= "reserved_cents"))
  ),
  CONSTRAINT "tool_budget_operation_status_shape_check" CHECK (
    ("status" = 'RESERVED' AND "observed_cents" IS NULL AND "charged_cents" IS NULL AND "settled_at" IS NULL)
    OR ("status" <> 'RESERVED' AND "observed_cents" IS NOT NULL AND "charged_cents" IS NOT NULL AND "settled_at" IS NOT NULL)
  )
);
CREATE INDEX "tool_budget_operation_scope_account_status_idx" ON "tool_budget_operation"("scope_key", "account_id", "status");

ALTER TABLE "site_build_budget_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_budget_grant" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_build_budget_grant_tenant_isolation" ON "site_build_budget_grant"
  USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id());
ALTER TABLE "site_build_spend_reconciliation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_spend_reconciliation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_build_spend_reconciliation_tenant_isolation" ON "site_build_spend_reconciliation"
  USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id());
ALTER TABLE "tool_budget_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_budget_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tool_budget_account_tenant_isolation" ON "tool_budget_account"
  USING (("scope_key" = 'platform' AND session_user <> 'app_user') OR "scope_key" = current_workspace_id()::text)
  WITH CHECK (("scope_key" = 'platform' AND session_user <> 'app_user') OR "scope_key" = current_workspace_id()::text);
ALTER TABLE "tool_budget_operation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_budget_operation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tool_budget_operation_tenant_isolation" ON "tool_budget_operation"
  USING (("scope_key" = 'platform' AND session_user <> 'app_user') OR "scope_key" = current_workspace_id()::text)
  WITH CHECK (("scope_key" = 'platform' AND session_user <> 'app_user') OR "scope_key" = current_workspace_id()::text);

CREATE FUNCTION open_tool_budget(p_scope_key TEXT, p_account_key TEXT, p_cap_cents BIGINT, p_replay_scope BOOLEAN DEFAULT false)
RETURNS TABLE(account_id UUID, generation INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v "tool_budget_account"%ROWTYPE;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) OR char_length(p_account_key) NOT BETWEEN 1 AND 200 OR p_cap_cents < 0 THEN
    RAISE EXCEPTION 'invalid tool budget account';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tool-budget-' || p_scope_key || '-' || p_account_key));
  SELECT * INTO v FROM "tool_budget_account" WHERE "scope_key"=p_scope_key AND "account_key"=p_account_key FOR UPDATE;
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
      -- Durable workflow/run identity: retry after ACK loss reuses settled operations.
      UPDATE "tool_budget_account" AS target
      SET "ref_count"=1,"closed_at"=NULL,"updated_at"=clock_timestamp()
      WHERE target."id"=v."id" RETURNING target.* INTO v;
    ELSE
      -- A reusable product key starts a fresh authorized generation.
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

CREATE FUNCTION reserve_tool_budget(p_scope_key TEXT, p_account_key TEXT, p_operation_key TEXT, p_reservation_cents BIGINT)
RETURNS TABLE(kind TEXT, operation_id UUID, reserved_cents BIGINT, remaining_cents BIGINT, status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a "tool_budget_account"%ROWTYPE; o "tool_budget_operation"%ROWTYPE;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) OR char_length(p_operation_key) NOT BETWEEN 1 AND 200 OR p_reservation_cents < 0 THEN RAISE EXCEPTION 'invalid tool budget reservation'; END IF;
  SELECT * INTO a FROM "tool_budget_account" WHERE "scope_key"=p_scope_key AND "account_key"=p_account_key FOR UPDATE;
  IF a."id" IS NULL OR a."ref_count"=0 THEN RAISE EXCEPTION 'TOOL_BUDGET_ACCOUNT_UNAVAILABLE'; END IF;
  SELECT * INTO o FROM "tool_budget_operation" WHERE "account_id"=a."id" AND "generation"=a."generation" AND "operation_key"=p_operation_key FOR UPDATE;
  IF o."id" IS NOT NULL THEN RETURN QUERY SELECT 'REPLAY',o."id",o."reserved_cents",a."cap_cents"-a."reserved_cents"-a."charged_cents",o."status"::text; RETURN; END IF;
  -- A cap variance is a durable safety stop. Existing operation keys remain
  -- replayable above, but no new physical operation may be reserved after it.
  IF a."exhausted" THEN
    RETURN QUERY SELECT 'DENIED',NULL::UUID,0::BIGINT,a."cap_cents"-a."reserved_cents"-a."charged_cents",'EXHAUSTED'; RETURN;
  END IF;
  IF p_reservation_cents > a."cap_cents"-a."reserved_cents"-a."charged_cents" THEN
    UPDATE "tool_budget_account" SET "exhausted"=true,"updated_at"=clock_timestamp() WHERE "id"=a."id";
    RETURN QUERY SELECT 'DENIED',NULL::UUID,0::BIGINT,a."cap_cents"-a."reserved_cents"-a."charged_cents",'EXHAUSTED'; RETURN;
  END IF;
  INSERT INTO "tool_budget_operation"("scope_key","account_id","generation","operation_key","reserved_cents") VALUES(p_scope_key,a."id",a."generation",p_operation_key,p_reservation_cents) RETURNING * INTO o;
  UPDATE "tool_budget_account" AS target
  SET "reserved_cents"=target."reserved_cents"+p_reservation_cents,
      "updated_at"=clock_timestamp()
  WHERE target."id"=a."id" RETURNING target.* INTO a;
  RETURN QUERY SELECT 'EXECUTE',o."id",o."reserved_cents",a."cap_cents"-a."reserved_cents"-a."charged_cents",o."status"::text;
END $$;

CREATE FUNCTION settle_tool_budget(p_scope_key TEXT, p_operation_id UUID, p_observed_cents BIGINT)
RETURNS TABLE(charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN, status TEXT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a "tool_budget_account"%ROWTYPE; o "tool_budget_operation"%ROWTYPE; charge BIGINT;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) OR p_observed_cents < 0 THEN RAISE EXCEPTION 'invalid tool budget settlement'; END IF;
  SELECT * INTO o FROM "tool_budget_operation" WHERE "id"=p_operation_id AND "scope_key"=p_scope_key FOR UPDATE;
  IF o."id" IS NULL THEN RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE'; END IF;
  SELECT * INTO a FROM "tool_budget_account" WHERE "id"=o."account_id" AND "scope_key"=p_scope_key FOR UPDATE;
  IF o."status" <> 'RESERVED' THEN RETURN QUERY SELECT o."charged_cents",o."observed_cents",o."observed_cents">o."reserved_cents",o."status"::text,true; RETURN; END IF;
  charge:=LEAST(p_observed_cents,o."reserved_cents");
  UPDATE "tool_budget_operation" SET "observed_cents"=p_observed_cents,"charged_cents"=charge,"status"='SETTLED',"settled_at"=clock_timestamp() WHERE "id"=o."id" RETURNING * INTO o;
  UPDATE "tool_budget_account" AS target
  SET "reserved_cents"=target."reserved_cents"-o."reserved_cents",
      "charged_cents"=target."charged_cents"+charge,
      "exhausted"=(target."exhausted" OR p_observed_cents>o."reserved_cents"),
      "updated_at"=clock_timestamp()
  WHERE target."id"=a."id";
  RETURN QUERY SELECT charge,p_observed_cents,p_observed_cents>o."reserved_cents",o."status"::text,false;
END $$;

CREATE FUNCTION release_tool_budget(p_scope_key TEXT, p_operation_id UUID)
RETURNS TABLE(charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN, status TEXT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a "tool_budget_account"%ROWTYPE; o "tool_budget_operation"%ROWTYPE;
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) THEN RAISE EXCEPTION 'workspace scope mismatch'; END IF;
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

CREATE FUNCTION tool_budget_status(p_scope_key TEXT, p_account_key TEXT)
RETURNS TABLE(remaining_cents BIGINT, exhausted BOOLEAN, ref_count INTEGER, generation INTEGER)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a."cap_cents"-a."reserved_cents"-a."charged_cents",a."exhausted",a."ref_count",a."generation"
  FROM "tool_budget_account" a WHERE a."scope_key"=p_scope_key AND a."account_key"=p_account_key
    AND ((p_scope_key = 'platform' AND session_user <> 'app_user') OR p_scope_key=current_workspace_id()::text)
$$;

CREATE FUNCTION close_tool_budget(p_scope_key TEXT, p_account_key TEXT, p_force BOOLEAN DEFAULT false)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF ((p_scope_key = 'platform' AND session_user = 'app_user') OR (p_scope_key <> 'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text)) THEN RAISE EXCEPTION 'workspace scope mismatch'; END IF;
  UPDATE "tool_budget_account" SET "ref_count"=CASE WHEN p_force THEN 0 ELSE GREATEST(0,"ref_count"-1) END,"closed_at"=CASE WHEN p_force OR "ref_count"<=1 THEN clock_timestamp() ELSE NULL END,"updated_at"=clock_timestamp()
  WHERE "scope_key"=p_scope_key AND "account_key"=p_account_key;
END $$;

REVOKE ALL ON TABLE "runtime_process_lease", "site_build_budget_grant", "site_build_spend_reconciliation", "tool_budget_account", "tool_budget_operation" FROM PUBLIC;
GRANT SELECT ON TABLE "runtime_process_lease" TO app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "runtime_process_lease" FROM app_user;
GRANT SELECT, INSERT ON TABLE "site_build_budget_grant", "site_build_spend_reconciliation" TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_build_budget_grant", "site_build_spend_reconciliation" FROM app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_build_budget", "site_build_spend" FROM app_user;
GRANT SELECT ON TABLE "site_build_budget", "site_build_spend" TO app_user;
GRANT SELECT ON TABLE "tool_budget_account", "tool_budget_operation" TO app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "tool_budget_account", "tool_budget_operation" FROM app_user;

REVOKE ALL ON FUNCTION enforce_site_build_spend_grant() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_site_build_budget_grant_consumption() FROM PUBLIC;
REVOKE ALL ON FUNCTION register_runtime_process_lease(UUID,"runtime_process_role",TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ), heartbeat_runtime_process_lease(UUID,"runtime_process_state",TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_api_runtime_process_lease(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ), register_worker_runtime_process_lease(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ), register_outbox_relay_runtime_process_lease(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION heartbeat_api_runtime_process_lease(UUID,"runtime_process_state",TIMESTAMPTZ), heartbeat_worker_runtime_process_lease(UUID,"runtime_process_state",TIMESTAMPTZ), heartbeat_outbox_relay_runtime_process_lease(UUID,"runtime_process_state",TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_site_build_budget_from_grant(UUID,UUID), disable_site_build_paid_calls(UUID,UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_site_build_spend(UUID,UUID,UUID,UUID,VARCHAR,TEXT,TEXT,TEXT,BIGINT,JSONB), settle_site_build_spend(UUID,UUID,VARCHAR,UUID,TEXT,BIGINT,TEXT,BIGINT,BIGINT,BIGINT,INTEGER,INTEGER,INTEGER,JSONB,JSONB,TEXT), reconcile_site_build_spend(UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION open_tool_budget(TEXT,TEXT,BIGINT,BOOLEAN), reserve_tool_budget(TEXT,TEXT,TEXT,BIGINT), settle_tool_budget(TEXT,UUID,BIGINT), release_tool_budget(TEXT,UUID), tool_budget_status(TEXT,TEXT), close_tool_budget(TEXT,TEXT,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_tool_budget(TEXT,TEXT,BIGINT,BOOLEAN), reserve_tool_budget(TEXT,TEXT,TEXT,BIGINT), settle_tool_budget(TEXT,UUID,BIGINT), release_tool_budget(TEXT,UUID), tool_budget_status(TEXT,TEXT), close_tool_budget(TEXT,TEXT,BOOLEAN) TO app_user;
GRANT EXECUTE ON FUNCTION create_site_build_budget_from_grant(UUID,UUID), disable_site_build_paid_calls(UUID,UUID,TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION reserve_site_build_spend(UUID,UUID,UUID,UUID,VARCHAR,TEXT,TEXT,TEXT,BIGINT,JSONB), settle_site_build_spend(UUID,UUID,VARCHAR,UUID,TEXT,BIGINT,TEXT,BIGINT,BIGINT,BIGINT,INTEGER,INTEGER,INTEGER,JSONB,JSONB,TEXT), reconcile_site_build_spend(UUID,UUID) TO app_user;
REVOKE EXECUTE ON FUNCTION register_runtime_process_lease(UUID,"runtime_process_role",TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ), heartbeat_runtime_process_lease(UUID,"runtime_process_state",TIMESTAMPTZ) FROM app_user;
GRANT EXECUTE ON FUNCTION register_api_runtime_process_lease(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ), heartbeat_api_runtime_process_lease(UUID,"runtime_process_state",TIMESTAMPTZ) TO runtime_api;
GRANT EXECUTE ON FUNCTION register_worker_runtime_process_lease(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ), heartbeat_worker_runtime_process_lease(UUID,"runtime_process_state",TIMESTAMPTZ) TO runtime_worker;
GRANT EXECUTE ON FUNCTION register_outbox_relay_runtime_process_lease(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ), heartbeat_outbox_relay_runtime_process_lease(UUID,"runtime_process_state",TIMESTAMPTZ) TO runtime_outbox_relay;

COMMIT;
