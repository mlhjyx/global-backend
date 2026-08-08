BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "acquisition_budget_account" (
  "id" VARCHAR(80) NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" VARCHAR(200) NOT NULL,
  "purpose" VARCHAR(80) NOT NULL,
  "target_kind" VARCHAR(16) NOT NULL,
  "target_id" VARCHAR(200) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "billing_unit" VARCHAR(32) NOT NULL,
  "request_limit" BIGINT NOT NULL,
  "call_limit" BIGINT NOT NULL,
  "record_limit" BIGINT NOT NULL,
  "model_call_limit" BIGINT NOT NULL,
  "cost_limit" BIGINT NOT NULL,
  "request_reserved" BIGINT NOT NULL DEFAULT 0,
  "call_reserved" BIGINT NOT NULL DEFAULT 0,
  "record_reserved" BIGINT NOT NULL DEFAULT 0,
  "model_call_reserved" BIGINT NOT NULL DEFAULT 0,
  "cost_reserved" BIGINT NOT NULL DEFAULT 0,
  "request_settled" BIGINT NOT NULL DEFAULT 0,
  "call_settled" BIGINT NOT NULL DEFAULT 0,
  "record_settled" BIGINT NOT NULL DEFAULT 0,
  "model_call_settled" BIGINT NOT NULL DEFAULT 0,
  "cost_settled" BIGINT NOT NULL DEFAULT 0,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "authorization_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "exhausted_at" TIMESTAMP(3),
  "frozen_at" TIMESTAMP(3),
  "freeze_reason" VARCHAR(200),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "acquisition_budget_account_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acquisition_budget_account_id_workspace_key" UNIQUE ("id", "workspace_id"),
  CONSTRAINT "acquisition_budget_account_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "acquisition_budget_account_identity_check" CHECK (
    length(btrim("id")) > 0
    AND length(btrim("run_id")) > 0
    AND length(btrim("purpose")) > 0
    AND "target_kind" IN ('SOURCE', 'MODEL', 'TOOL')
    AND length(btrim("target_id")) > 0
    AND "currency" ~ '^[A-Z]{3}$'
    AND "billing_unit" ~ '^[a-z][a-z0-9_-]{0,31}$'
    AND "authorization_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "acquisition_budget_account_limits_check" CHECK (
    "request_limit" >= 0
    AND "call_limit" >= 0
    AND "record_limit" >= 0
    AND "model_call_limit" >= 0
    AND "cost_limit" >= 0
    AND (
      "request_limit" > 0 OR "call_limit" > 0 OR "record_limit" > 0
      OR "model_call_limit" > 0 OR "cost_limit" > 0
    )
  ),
  CONSTRAINT "acquisition_budget_account_counters_check" CHECK (
    "request_reserved" >= 0 AND "request_settled" >= 0
    AND "request_reserved" + "request_settled" <= "request_limit"
    AND "call_reserved" >= 0 AND "call_settled" >= 0
    AND "call_reserved" + "call_settled" <= "call_limit"
    AND "record_reserved" >= 0 AND "record_settled" >= 0
    AND "record_reserved" + "record_settled" <= "record_limit"
    AND "model_call_reserved" >= 0 AND "model_call_settled" >= 0
    AND "model_call_reserved" + "model_call_settled" <= "model_call_limit"
    AND "cost_reserved" >= 0 AND "cost_settled" >= 0
    AND "cost_reserved" + "cost_settled" <= "cost_limit"
  ),
  CONSTRAINT "acquisition_budget_account_status_check" CHECK (
    "status" IN ('ACTIVE', 'EXHAUSTED', 'FROZEN', 'EXPIRED')
    AND (("status" = 'EXHAUSTED') = ("exhausted_at" IS NOT NULL))
    AND (("status" = 'FROZEN') = ("frozen_at" IS NOT NULL))
    AND (("status" = 'FROZEN') = ("freeze_reason" IS NOT NULL))
  )
);

CREATE INDEX "acquisition_budget_account_workspace_run_status_idx"
  ON "acquisition_budget_account"("workspace_id", "run_id", "status");
CREATE INDEX "acquisition_budget_account_workspace_expiry_idx"
  ON "acquisition_budget_account"("workspace_id", "expires_at");

CREATE TABLE "acquisition_budget_reservation" (
  "id" VARCHAR(68) NOT NULL,
  "account_id" VARCHAR(80) NOT NULL,
  "workspace_id" UUID NOT NULL,
  "run_id" VARCHAR(200) NOT NULL,
  "purpose" VARCHAR(80) NOT NULL,
  "target_kind" VARCHAR(16) NOT NULL,
  "target_id" VARCHAR(200) NOT NULL,
  "execution_id" VARCHAR(240) NOT NULL,
  "attempt" INTEGER NOT NULL,
  "idempotency_key" CHAR(64) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "settlement_hash" CHAR(64),
  "max_request_count" BIGINT NOT NULL,
  "max_call_count" BIGINT NOT NULL,
  "max_record_count" BIGINT NOT NULL,
  "max_model_call_count" BIGINT NOT NULL,
  "max_cost_minor" BIGINT NOT NULL,
  "actual_request_count" BIGINT,
  "actual_call_count" BIGINT,
  "actual_record_count" BIGINT,
  "actual_model_call_count" BIGINT,
  "actual_cost_minor" BIGINT,
  "status" VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMP(3),

  CONSTRAINT "acquisition_budget_reservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acquisition_budget_reservation_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "acq_budget_reservation_full_identity_key" UNIQUE (
    "workspace_id", "run_id", "account_id", "purpose", "target_kind",
    "target_id", "execution_id", "attempt"
  ),
  CONSTRAINT "acquisition_budget_reservation_account_fkey"
    FOREIGN KEY ("account_id", "workspace_id")
    REFERENCES "acquisition_budget_account"("id", "workspace_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "acquisition_budget_reservation_identity_check" CHECK (
    length(btrim("id")) > 0
    AND length(btrim("run_id")) > 0
    AND length(btrim("purpose")) > 0
    AND "target_kind" IN ('SOURCE', 'MODEL', 'TOOL')
    AND length(btrim("target_id")) > 0
    AND length(btrim("execution_id")) > 0
    AND "attempt" > 0
    AND "idempotency_key" ~ '^[0-9a-f]{64}$'
    AND "request_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND ("settlement_hash" IS NULL OR "settlement_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "acquisition_budget_reservation_maximum_check" CHECK (
    "max_request_count" >= 0 AND "max_call_count" >= 0
    AND "max_record_count" >= 0 AND "max_model_call_count" >= 0
    AND "max_cost_minor" >= 0
    AND (
      "max_request_count" > 0 OR "max_call_count" > 0 OR "max_record_count" > 0
      OR "max_model_call_count" > 0 OR "max_cost_minor" > 0
    )
  ),
  CONSTRAINT "acquisition_budget_reservation_actual_check" CHECK (
    ("actual_request_count" IS NULL OR "actual_request_count" >= 0)
    AND ("actual_call_count" IS NULL OR "actual_call_count" >= 0)
    AND ("actual_record_count" IS NULL OR "actual_record_count" >= 0)
    AND ("actual_model_call_count" IS NULL OR "actual_model_call_count" >= 0)
    AND ("actual_cost_minor" IS NULL OR "actual_cost_minor" >= 0)
  ),
  CONSTRAINT "acquisition_budget_reservation_status_check" CHECK (
    "status" IN ('RESERVED', 'SETTLED', 'RELEASED', 'UNKNOWN')
    AND (("status" = 'RESERVED') = ("settled_at" IS NULL))
    AND (("status" = 'RESERVED') = ("settlement_hash" IS NULL))
    AND (("status" = 'RESERVED') = (
      "actual_request_count" IS NULL
      AND "actual_call_count" IS NULL
      AND "actual_record_count" IS NULL
      AND "actual_model_call_count" IS NULL
      AND "actual_cost_minor" IS NULL
    ))
  )
);

CREATE INDEX "acquisition_budget_reservation_account_status_idx"
  ON "acquisition_budget_reservation"("workspace_id", "account_id", "status");

ALTER TABLE "acquisition_budget_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acquisition_budget_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acquisition_budget_account_tenant_isolation"
  ON "acquisition_budget_account"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "acquisition_budget_reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acquisition_budget_reservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acquisition_budget_reservation_tenant_isolation"
  ON "acquisition_budget_reservation"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- The stored transitions execute as a non-login, non-bypass role with access
-- to only these two tables. app_user remains read-only on ledger rows.
DO $$
DECLARE
  v_role RECORD;
BEGIN
  SELECT * INTO v_role FROM pg_catalog.pg_roles
  WHERE rolname = 'acquisition_budget_executor';
  IF NOT FOUND THEN
    CREATE ROLE acquisition_budget_executor
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSIF v_role.rolcanlogin OR v_role.rolinherit OR v_role.rolsuper OR v_role.rolcreatedb
    OR v_role.rolcreaterole OR v_role.rolreplication OR v_role.rolbypassrls
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE roleid = v_role.oid
    )
  THEN
    RAISE EXCEPTION 'acquisition_budget_executor exists with unsafe privileges';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO acquisition_budget_executor;
GRANT SELECT, INSERT, UPDATE
  ON TABLE "acquisition_budget_account", "acquisition_budget_reservation"
  TO acquisition_budget_executor;
GRANT EXECUTE ON FUNCTION current_workspace_id()
  TO acquisition_budget_executor;

CREATE FUNCTION open_acquisition_budget_account(
  p_account_id TEXT,
  p_workspace_id UUID,
  p_run_id TEXT,
  p_purpose TEXT,
  p_target_kind TEXT,
  p_target_id TEXT,
  p_currency TEXT,
  p_billing_unit TEXT,
  p_request_limit BIGINT,
  p_call_limit BIGINT,
  p_record_limit BIGINT,
  p_model_call_limit BIGINT,
  p_cost_limit BIGINT,
  p_expires_at TIMESTAMPTZ(3),
  p_authorization_hash TEXT
)
RETURNS TABLE (
  decision TEXT,
  reservation_id TEXT,
  account_status TEXT,
  reservation_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_account public."acquisition_budget_account"%ROWTYPE;
  v_inserted_count INTEGER;
BEGIN
  IF p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RETURN QUERY SELECT 'IDENTITY_MISMATCH', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF p_account_id IS NULL OR length(btrim(p_account_id)) = 0 OR length(p_account_id) > 80
    OR p_run_id IS NULL OR length(btrim(p_run_id)) = 0 OR length(p_run_id) > 200
    OR p_purpose IS NULL OR length(btrim(p_purpose)) = 0 OR length(p_purpose) > 80
    OR p_target_kind IS NULL OR p_target_kind NOT IN ('SOURCE', 'MODEL', 'TOOL')
    OR p_target_id IS NULL OR length(btrim(p_target_id)) = 0 OR length(p_target_id) > 200
    OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
    OR p_billing_unit IS NULL OR p_billing_unit !~ '^[a-z][a-z0-9_-]{0,31}$'
    OR p_request_limit IS NULL OR p_request_limit < 0
    OR p_call_limit IS NULL OR p_call_limit < 0
    OR p_record_limit IS NULL OR p_record_limit < 0
    OR p_model_call_limit IS NULL OR p_model_call_limit < 0
    OR p_cost_limit IS NULL OR p_cost_limit < 0
    OR (p_request_limit = 0 AND p_call_limit = 0 AND p_record_limit = 0
      AND p_model_call_limit = 0 AND p_cost_limit = 0)
    OR p_expires_at IS NULL OR p_expires_at <= clock_timestamp()
    OR p_authorization_hash IS NULL OR p_authorization_hash !~ '^[0-9a-f]{64}$'
  THEN
    RETURN QUERY SELECT 'INVALID_AUTHORIZATION', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  INSERT INTO public."acquisition_budget_account" (
    "id", "workspace_id", "run_id", "purpose", "target_kind", "target_id",
    "currency", "billing_unit", "request_limit", "call_limit", "record_limit",
    "model_call_limit", "cost_limit", "expires_at", "authorization_hash"
  ) VALUES (
    p_account_id, p_workspace_id, p_run_id, p_purpose, p_target_kind, p_target_id,
    p_currency, p_billing_unit, p_request_limit, p_call_limit, p_record_limit,
    p_model_call_limit, p_cost_limit, p_expires_at, p_authorization_hash
  )
  ON CONFLICT ("id") DO NOTHING;
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  SELECT * INTO v_account
  FROM public."acquisition_budget_account"
  WHERE "id" = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_account."authorization_hash" = p_authorization_hash
    AND v_account."workspace_id" = p_workspace_id
    AND v_account."run_id" = p_run_id
    AND v_account."purpose" = p_purpose
    AND v_account."target_kind" = p_target_kind
    AND v_account."target_id" = p_target_id
    AND v_account."currency" = p_currency
    AND v_account."billing_unit" = p_billing_unit
    AND v_account."request_limit" = p_request_limit
    AND v_account."call_limit" = p_call_limit
    AND v_account."record_limit" = p_record_limit
    AND v_account."model_call_limit" = p_model_call_limit
    AND v_account."cost_limit" = p_cost_limit
    AND v_account."expires_at" = p_expires_at
  THEN
    RETURN QUERY SELECT
      CASE WHEN v_inserted_count = 1 THEN 'OPENED' ELSE 'REPLAY' END,
      NULL::TEXT,
      v_account."status",
      NULL::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'IDEMPOTENCY_CONFLICT', NULL::TEXT, v_account."status", NULL::TEXT;
END;
$$;

CREATE FUNCTION reserve_acquisition_budget(
  p_reservation_id TEXT,
  p_account_id TEXT,
  p_workspace_id UUID,
  p_run_id TEXT,
  p_purpose TEXT,
  p_target_kind TEXT,
  p_target_id TEXT,
  p_execution_id TEXT,
  p_attempt INTEGER,
  p_idempotency_key TEXT,
  p_request_fingerprint TEXT,
  p_payload_hash TEXT,
  p_max_request BIGINT,
  p_max_call BIGINT,
  p_max_record BIGINT,
  p_max_model_call BIGINT,
  p_max_cost BIGINT
)
RETURNS TABLE (
  decision TEXT,
  reservation_id TEXT,
  account_status TEXT,
  reservation_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_account public."acquisition_budget_account"%ROWTYPE;
  v_reservation public."acquisition_budget_reservation"%ROWTYPE;
BEGIN
  IF p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RETURN QUERY SELECT 'IDENTITY_MISMATCH', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF p_reservation_id IS NULL OR p_reservation_id <> 'abr_' || p_idempotency_key
    OR p_run_id IS NULL OR length(btrim(p_run_id)) = 0 OR length(p_run_id) > 200
    OR p_purpose IS NULL OR length(btrim(p_purpose)) = 0 OR length(p_purpose) > 80
    OR p_target_kind IS NULL OR p_target_kind NOT IN ('SOURCE', 'MODEL', 'TOOL')
    OR p_target_id IS NULL OR length(btrim(p_target_id)) = 0 OR length(p_target_id) > 200
    OR p_execution_id IS NULL OR length(btrim(p_execution_id)) = 0 OR length(p_execution_id) > 240
    OR p_attempt IS NULL OR p_attempt < 1
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[0-9a-f]{64}$'
    OR p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$'
    OR p_max_request IS NULL OR p_max_request < 0
    OR p_max_call IS NULL OR p_max_call < 0
    OR p_max_record IS NULL OR p_max_record < 0
    OR p_max_model_call IS NULL OR p_max_model_call < 0
    OR p_max_cost IS NULL OR p_max_cost < 0
    OR (p_max_request = 0 AND p_max_call = 0 AND p_max_record = 0
      AND p_max_model_call = 0 AND p_max_cost = 0)
  THEN
    RETURN QUERY SELECT 'INVALID_RESERVATION', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_account
  FROM public."acquisition_budget_account"
  WHERE "id" = p_account_id AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_account."run_id" <> p_run_id
    OR v_account."purpose" <> p_purpose
    OR v_account."target_kind" <> p_target_kind
    OR v_account."target_id" <> p_target_id
  THEN
    RETURN QUERY SELECT 'IDENTITY_MISMATCH', NULL::TEXT, v_account."status", NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_reservation
  FROM public."acquisition_budget_reservation"
  WHERE "workspace_id" = p_workspace_id
    AND "run_id" = p_run_id
    AND "account_id" = p_account_id
    AND "purpose" = p_purpose
    AND "target_kind" = p_target_kind
    AND "target_id" = p_target_id
    AND "execution_id" = p_execution_id
    AND "attempt" = p_attempt;
  IF FOUND THEN
    IF v_reservation."idempotency_key" = p_idempotency_key
      AND v_reservation."request_fingerprint" = p_request_fingerprint
      AND v_reservation."payload_hash" = p_payload_hash
      AND v_reservation."max_request_count" = p_max_request
      AND v_reservation."max_call_count" = p_max_call
      AND v_reservation."max_record_count" = p_max_record
      AND v_reservation."max_model_call_count" = p_max_model_call
      AND v_reservation."max_cost_minor" = p_max_cost
    THEN
      RETURN QUERY SELECT 'REPLAY', v_reservation."id", v_account."status", v_reservation."status";
    ELSE
      RETURN QUERY SELECT 'IDEMPOTENCY_CONFLICT', v_reservation."id", v_account."status", v_reservation."status";
    END IF;
    RETURN;
  END IF;

  IF v_account."status" = 'ACTIVE' AND v_account."expires_at" <= clock_timestamp() THEN
    UPDATE public."acquisition_budget_account"
    SET "status" = 'EXPIRED', "updated_at" = clock_timestamp()
    WHERE "id" = p_account_id;
    RETURN QUERY SELECT 'EXPIRED', NULL::TEXT, 'EXPIRED', NULL::TEXT;
    RETURN;
  END IF;
  IF v_account."status" <> 'ACTIVE' THEN
    RETURN QUERY SELECT v_account."status", NULL::TEXT, v_account."status", NULL::TEXT;
    RETURN;
  END IF;

  -- Compare against subtraction-based remaining capacity so an attempted
  -- reserve near BIGINT_MAX produces EXHAUSTED instead of arithmetic overflow.
  IF p_max_request > v_account."request_limit" - v_account."request_reserved" - v_account."request_settled"
    OR p_max_call > v_account."call_limit" - v_account."call_reserved" - v_account."call_settled"
    OR p_max_record > v_account."record_limit" - v_account."record_reserved" - v_account."record_settled"
    OR p_max_model_call > v_account."model_call_limit" - v_account."model_call_reserved" - v_account."model_call_settled"
    OR p_max_cost > v_account."cost_limit" - v_account."cost_reserved" - v_account."cost_settled"
  THEN
    UPDATE public."acquisition_budget_account"
    SET "status" = 'EXHAUSTED', "exhausted_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "id" = p_account_id;
    RETURN QUERY SELECT 'EXHAUSTED', NULL::TEXT, 'EXHAUSTED', NULL::TEXT;
    RETURN;
  END IF;

  INSERT INTO public."acquisition_budget_reservation" (
    "id", "account_id", "workspace_id", "run_id", "purpose", "target_kind",
    "target_id", "execution_id", "attempt", "idempotency_key", "request_fingerprint",
    "payload_hash", "max_request_count", "max_call_count", "max_record_count",
    "max_model_call_count", "max_cost_minor"
  ) VALUES (
    p_reservation_id, p_account_id, p_workspace_id, p_run_id, p_purpose, p_target_kind,
    p_target_id, p_execution_id, p_attempt, p_idempotency_key, p_request_fingerprint,
    p_payload_hash, p_max_request, p_max_call, p_max_record, p_max_model_call, p_max_cost
  );
  UPDATE public."acquisition_budget_account"
  SET
    "request_reserved" = "request_reserved" + p_max_request,
    "call_reserved" = "call_reserved" + p_max_call,
    "record_reserved" = "record_reserved" + p_max_record,
    "model_call_reserved" = "model_call_reserved" + p_max_model_call,
    "cost_reserved" = "cost_reserved" + p_max_cost,
    "updated_at" = clock_timestamp()
  WHERE "id" = p_account_id;

  RETURN QUERY SELECT 'RESERVED', p_reservation_id, 'ACTIVE', 'RESERVED';
END;
$$;

CREATE FUNCTION settle_acquisition_budget(
  p_reservation_id TEXT,
  p_account_id TEXT,
  p_workspace_id UUID,
  p_run_id TEXT,
  p_purpose TEXT,
  p_target_kind TEXT,
  p_target_id TEXT,
  p_execution_id TEXT,
  p_attempt INTEGER,
  p_outcome TEXT,
  p_actual_request BIGINT,
  p_actual_call BIGINT,
  p_actual_record BIGINT,
  p_actual_model_call BIGINT,
  p_actual_cost BIGINT,
  p_settlement_hash TEXT
)
RETURNS TABLE (
  decision TEXT,
  reservation_id TEXT,
  account_status TEXT,
  reservation_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_account public."acquisition_budget_account"%ROWTYPE;
  v_reservation public."acquisition_budget_reservation"%ROWTYPE;
  v_decision TEXT;
  v_status TEXT;
  v_charge_request BIGINT;
  v_charge_call BIGINT;
  v_charge_record BIGINT;
  v_charge_model_call BIGINT;
  v_charge_cost BIGINT;
  v_overrun BOOLEAN;
BEGIN
  IF p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RETURN QUERY SELECT 'IDENTITY_MISMATCH', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF p_reservation_id IS NULL OR length(btrim(p_reservation_id)) = 0
    OR p_run_id IS NULL OR length(btrim(p_run_id)) = 0 OR length(p_run_id) > 200
    OR p_purpose IS NULL OR length(btrim(p_purpose)) = 0 OR length(p_purpose) > 80
    OR p_target_kind IS NULL OR p_target_kind NOT IN ('SOURCE', 'MODEL', 'TOOL')
    OR p_target_id IS NULL OR length(btrim(p_target_id)) = 0 OR length(p_target_id) > 200
    OR p_execution_id IS NULL OR length(btrim(p_execution_id)) = 0 OR length(p_execution_id) > 240
    OR p_attempt IS NULL OR p_attempt < 1
    OR p_outcome IS NULL OR p_outcome NOT IN ('SETTLED', 'RELEASED', 'UNKNOWN')
    OR p_actual_request IS NULL OR p_actual_request < 0
    OR p_actual_call IS NULL OR p_actual_call < 0
    OR p_actual_record IS NULL OR p_actual_record < 0
    OR p_actual_model_call IS NULL OR p_actual_model_call < 0
    OR p_actual_cost IS NULL OR p_actual_cost < 0
    OR p_settlement_hash IS NULL OR p_settlement_hash !~ '^[0-9a-f]{64}$'
    OR (p_outcome = 'RELEASED' AND (
      p_actual_request <> 0 OR p_actual_call <> 0 OR p_actual_record <> 0
      OR p_actual_model_call <> 0 OR p_actual_cost <> 0
    ))
  THEN
    RETURN QUERY SELECT 'INVALID_RESERVATION', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_account
  FROM public."acquisition_budget_account"
  WHERE "id" = p_account_id AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_reservation
  FROM public."acquisition_budget_reservation"
  WHERE "id" = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'RESERVATION_NOT_FOUND', NULL::TEXT, v_account."status", NULL::TEXT;
    RETURN;
  END IF;

  IF v_account."run_id" <> p_run_id
    OR v_account."purpose" <> p_purpose
    OR v_account."target_kind" <> p_target_kind
    OR v_account."target_id" <> p_target_id
    OR v_reservation."account_id" <> p_account_id
    OR v_reservation."workspace_id" <> p_workspace_id
    OR v_reservation."run_id" <> p_run_id
    OR v_reservation."purpose" <> p_purpose
    OR v_reservation."target_kind" <> p_target_kind
    OR v_reservation."target_id" <> p_target_id
    OR v_reservation."execution_id" <> p_execution_id
    OR v_reservation."attempt" <> p_attempt
  THEN
    RETURN QUERY SELECT 'IDENTITY_MISMATCH', v_reservation."id", v_account."status", v_reservation."status";
    RETURN;
  END IF;

  IF v_reservation."status" <> 'RESERVED' THEN
    IF v_reservation."settlement_hash" = p_settlement_hash THEN
      RETURN QUERY SELECT 'REPLAY', v_reservation."id", v_account."status", v_reservation."status";
    ELSE
      RETURN QUERY SELECT 'IDEMPOTENCY_CONFLICT', v_reservation."id", v_account."status", v_reservation."status";
    END IF;
    RETURN;
  END IF;

  v_overrun := p_actual_request > v_reservation."max_request_count"
    OR p_actual_call > v_reservation."max_call_count"
    OR p_actual_record > v_reservation."max_record_count"
    OR p_actual_model_call > v_reservation."max_model_call_count"
    OR p_actual_cost > v_reservation."max_cost_minor";

  IF p_outcome = 'UNKNOWN' OR v_overrun THEN
    v_charge_request := v_reservation."max_request_count";
    v_charge_call := v_reservation."max_call_count";
    v_charge_record := v_reservation."max_record_count";
    v_charge_model_call := v_reservation."max_model_call_count";
    v_charge_cost := v_reservation."max_cost_minor";
    v_status := 'UNKNOWN';
    v_decision := CASE WHEN v_overrun THEN 'FROZEN_OVERRUN' ELSE 'UNKNOWN' END;
  ELSIF p_outcome = 'RELEASED' THEN
    v_charge_request := 0; v_charge_call := 0; v_charge_record := 0;
    v_charge_model_call := 0; v_charge_cost := 0;
    v_status := 'RELEASED'; v_decision := 'RELEASED';
  ELSE
    v_charge_request := p_actual_request;
    v_charge_call := p_actual_call;
    v_charge_record := p_actual_record;
    v_charge_model_call := p_actual_model_call;
    v_charge_cost := p_actual_cost;
    v_status := 'SETTLED'; v_decision := 'SETTLED';
  END IF;

  UPDATE public."acquisition_budget_reservation"
  SET
    "actual_request_count" = v_charge_request,
    "actual_call_count" = v_charge_call,
    "actual_record_count" = v_charge_record,
    "actual_model_call_count" = v_charge_model_call,
    "actual_cost_minor" = v_charge_cost,
    "status" = v_status,
    "settlement_hash" = p_settlement_hash,
    "settled_at" = clock_timestamp()
  WHERE "id" = p_reservation_id;

  UPDATE public."acquisition_budget_account"
  SET
    "request_reserved" = "request_reserved" - v_reservation."max_request_count",
    "call_reserved" = "call_reserved" - v_reservation."max_call_count",
    "record_reserved" = "record_reserved" - v_reservation."max_record_count",
    "model_call_reserved" = "model_call_reserved" - v_reservation."max_model_call_count",
    "cost_reserved" = "cost_reserved" - v_reservation."max_cost_minor",
    "request_settled" = "request_settled" + v_charge_request,
    "call_settled" = "call_settled" + v_charge_call,
    "record_settled" = "record_settled" + v_charge_record,
    "model_call_settled" = "model_call_settled" + v_charge_model_call,
    "cost_settled" = "cost_settled" + v_charge_cost,
    "status" = CASE
      WHEN v_status = 'UNKNOWN' THEN 'FROZEN'
      WHEN "status" = 'ACTIVE' AND (
        ("request_limit" > 0 AND "request_settled" + v_charge_request = "request_limit")
        OR ("call_limit" > 0 AND "call_settled" + v_charge_call = "call_limit")
        OR ("record_limit" > 0 AND "record_settled" + v_charge_record = "record_limit")
        OR ("model_call_limit" > 0 AND "model_call_settled" + v_charge_model_call = "model_call_limit")
        OR ("cost_limit" > 0 AND "cost_settled" + v_charge_cost = "cost_limit")
      ) THEN 'EXHAUSTED'
      ELSE "status"
    END,
    "frozen_at" = CASE WHEN v_status = 'UNKNOWN' THEN clock_timestamp() ELSE "frozen_at" END,
    "freeze_reason" = CASE WHEN v_status = 'UNKNOWN' THEN v_decision ELSE "freeze_reason" END,
    "exhausted_at" = CASE
      WHEN v_status = 'UNKNOWN' THEN NULL
      WHEN "status" = 'ACTIVE' AND (
        ("request_limit" > 0 AND "request_settled" + v_charge_request = "request_limit")
        OR ("call_limit" > 0 AND "call_settled" + v_charge_call = "call_limit")
        OR ("record_limit" > 0 AND "record_settled" + v_charge_record = "record_limit")
        OR ("model_call_limit" > 0 AND "model_call_settled" + v_charge_model_call = "model_call_limit")
        OR ("cost_limit" > 0 AND "cost_settled" + v_charge_cost = "cost_limit")
      ) THEN clock_timestamp()
      ELSE "exhausted_at"
    END,
    "updated_at" = clock_timestamp()
  WHERE "id" = p_account_id
  RETURNING "status" INTO v_status;

  RETURN QUERY SELECT v_decision, p_reservation_id, v_status, CASE WHEN v_decision = 'FROZEN_OVERRUN' THEN 'UNKNOWN' ELSE v_decision END;
END;
$$;

-- Function ownership requires transient membership plus CREATE on the schema.
-- Revoke both immediately after assigning these fixed, non-dynamic functions.
REVOKE ALL ON FUNCTION open_acquisition_budget_account(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_acquisition_budget(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_acquisition_budget(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_acquisition_budget_account(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION reserve_acquisition_budget(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) TO app_user;
GRANT EXECUTE ON FUNCTION settle_acquisition_budget(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT) TO app_user;

GRANT acquisition_budget_executor TO CURRENT_USER;
GRANT CREATE ON SCHEMA public TO acquisition_budget_executor;
ALTER FUNCTION open_acquisition_budget_account(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TIMESTAMPTZ, TEXT)
  OWNER TO acquisition_budget_executor;
ALTER FUNCTION reserve_acquisition_budget(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT)
  OWNER TO acquisition_budget_executor;
ALTER FUNCTION settle_acquisition_budget(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT)
  OWNER TO acquisition_budget_executor;
REVOKE CREATE ON SCHEMA public FROM acquisition_budget_executor;
REVOKE acquisition_budget_executor FROM CURRENT_USER;

REVOKE ALL ON TABLE "acquisition_budget_account" FROM PUBLIC;
REVOKE ALL ON TABLE "acquisition_budget_reservation" FROM PUBLIC;
REVOKE ALL ON TABLE "acquisition_budget_account" FROM app_user;
REVOKE ALL ON TABLE "acquisition_budget_reservation" FROM app_user;
GRANT SELECT ON TABLE "acquisition_budget_account" TO app_user;
GRANT SELECT ON TABLE "acquisition_budget_reservation" TO app_user;

COMMIT;
