-- Additive physical-wire authority for exact New API settlement readback.
-- Historical SiteBuildSpend rows are deliberately not backfilled: only rows in
-- site_build_provider_wire_attempt participate in the v1 readback path.

CREATE TABLE "site_build_provider_wire_attempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "spend_id" UUID NOT NULL,
  "operation_key" VARCHAR(64) NOT NULL,
  "contract_version" VARCHAR(64) NOT NULL DEFAULT 'site-build-provider-transport/v1',
  "physical_wire_attempt" INTEGER NOT NULL,
  "derivation_key_id" VARCHAR(64) NOT NULL,
  "settlement_request_id" VARCHAR(43) NOT NULL,
  "settlement_nonce_sha256" VARCHAR(64) NOT NULL,
  "resolver_id" VARCHAR(191) NOT NULL,
  "protocol" VARCHAR(32) NOT NULL,
  "requested_alias" VARCHAR(120) NOT NULL,
  "expected_channel_id" INTEGER NOT NULL,
  "prompt_utf8_bytes" INTEGER NOT NULL,
  "maximum_wire_calls" INTEGER NOT NULL,
  "actual_max_output_tokens" INTEGER NOT NULL,
  "catalog_max_output_tokens" INTEGER NOT NULL,
  "maximum_quota_points" BIGINT NOT NULL,
  "catalog_id" VARCHAR(191) NOT NULL,
  "catalog_sha256" VARCHAR(64) NOT NULL,
  "pricing_snapshot_sha256" VARCHAR(64) NOT NULL,
  "input_price_microunits_per_million" BIGINT NOT NULL,
  "output_price_microunits_per_million" BIGINT NOT NULL,
  "ledger_microusd_per_pricing_unit" BIGINT NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'ALLOCATED',
  "settlement_status" VARCHAR(16),
  "final_phase" VARCHAR(64),
  "gateway_id_state" VARCHAR(32),
  "upstream_id_state" VARCHAR(32),
  "payload_state" VARCHAR(32),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatch_started_at" TIMESTAMPTZ(3),
  "observed_at" TIMESTAMPTZ(3),
  CONSTRAINT "site_build_provider_wire_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_provider_wire_spend_attempt_key"
    UNIQUE ("spend_id", "physical_wire_attempt"),
  CONSTRAINT "site_build_provider_wire_request_id_key"
    UNIQUE ("settlement_request_id"),
  CONSTRAINT "site_build_provider_wire_scope_key"
    UNIQUE ("id", "workspace_id", "site_id", "build_run_id"),
  CONSTRAINT "site_build_provider_wire_spend_scope_fkey"
    FOREIGN KEY ("spend_id", "workspace_id", "site_id", "build_run_id")
    REFERENCES "site_build_spend"("id", "workspace_id", "site_id", "build_run_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "site_build_provider_wire_identity_check" CHECK (
    "contract_version" = 'site-build-provider-transport/v1'
    AND "physical_wire_attempt" IN (1, 2)
    AND "operation_key" ~ '^[0-9a-f]{64}$'
    AND "derivation_key_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'
    AND "settlement_request_id" ~ '^[A-Za-z0-9_-]{43}$'
    AND "settlement_nonce_sha256" ~ '^[0-9a-f]{64}$'
    AND "resolver_id" = 'new-api-request-bound-reconciliation-v1'
    AND "protocol" IN ('openai-chat-completions', 'openai-responses', 'anthropic-messages')
    AND "requested_alias" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
    AND "expected_channel_id" BETWEEN 1 AND 1000000000
    AND "prompt_utf8_bytes" > 0
    AND "maximum_wire_calls" IN (1, 2)
    AND "physical_wire_attempt" <= "maximum_wire_calls"
    AND "actual_max_output_tokens" > 0
    AND "catalog_max_output_tokens" >= "actual_max_output_tokens"
    AND "maximum_quota_points" BETWEEN 1 AND 1000000000
    AND "catalog_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,190}$'
    AND "catalog_sha256" ~ '^[0-9a-f]{64}$'
    AND "pricing_snapshot_sha256" ~ '^[0-9a-f]{64}$'
    AND "input_price_microunits_per_million" BETWEEN 0 AND 500000000000
    AND "output_price_microunits_per_million" BETWEEN 0 AND 500000000000
    AND "ledger_microusd_per_pricing_unit" = 1000000
  ),
  CONSTRAINT "site_build_provider_wire_lifecycle_check" CHECK (
    ("state" = 'ALLOCATED'
      AND "dispatch_started_at" IS NULL AND "observed_at" IS NULL
      AND "settlement_status" IS NULL AND "final_phase" IS NULL
      AND "gateway_id_state" IS NULL AND "upstream_id_state" IS NULL
      AND "payload_state" IS NULL)
    OR
    ("state" = 'DISPATCH_STARTED'
      AND "dispatch_started_at" IS NOT NULL AND "observed_at" IS NULL
      AND "settlement_status" IS NULL AND "final_phase" IS NULL
      AND "gateway_id_state" IS NULL AND "upstream_id_state" IS NULL
      AND "payload_state" IS NULL)
    OR
    ("state" = 'NOT_DISPATCHED'
      AND "dispatch_started_at" IS NULL AND "observed_at" IS NOT NULL
      AND "settlement_status" = 'NOT_INCURRED'
      AND "final_phase" = 'not_dispatched'
      AND "gateway_id_state" = 'not_observable'
      AND "upstream_id_state" = 'not_exposed'
      AND "payload_state" = 'not_read')
    OR
    ("state" IN ('OBSERVED', 'UNKNOWN')
      AND "dispatch_started_at" IS NOT NULL AND "observed_at" IS NOT NULL
      AND "settlement_status" = CASE WHEN "state" = 'OBSERVED' THEN 'SETTLED' ELSE 'UNKNOWN' END
      AND "final_phase" IN (
        'gateway_unavailable', 'gateway_request_id_observed',
        'upstream_ack_unknown', 'payload_unavailable',
        'gateway_log_missing', 'gateway_log_unavailable',
        'gateway_log_invalid', 'database_ack_unknown'
      )
      AND "gateway_id_state" IN ('observed', 'missing', 'not_observable')
      AND "upstream_id_state" IN ('observed', 'absent', 'not_exposed', 'unknown')
      AND "payload_state" IN ('not_read', 'available', 'unavailable'))
  )
);

CREATE INDEX "site_build_provider_wire_workspace_run_state_idx"
  ON "site_build_provider_wire_attempt"(
    "workspace_id", "build_run_id", "state", "created_at"
  );

CREATE TABLE "site_build_provider_wire_receipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "spend_id" UUID NOT NULL,
  "wire_attempt_id" UUID NOT NULL,
  "receipt_digest" VARCHAR(64) NOT NULL,
  "alias" VARCHAR(120) NOT NULL,
  "protocol" VARCHAR(32) NOT NULL,
  "channel_id" INTEGER NOT NULL,
  "quota" BIGINT NOT NULL,
  "input_tokens" INTEGER NOT NULL,
  "output_tokens" INTEGER NOT NULL,
  "exact_cost_microusd" BIGINT NOT NULL,
  "upstream_id_state" VARCHAR(32) NOT NULL,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_build_provider_wire_receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_provider_wire_receipt_wire_key" UNIQUE ("wire_attempt_id"),
  CONSTRAINT "site_build_provider_wire_receipt_digest_key" UNIQUE ("receipt_digest"),
  CONSTRAINT "site_build_provider_wire_receipt_scope_key"
    UNIQUE ("wire_attempt_id", "workspace_id", "site_id", "build_run_id"),
  CONSTRAINT "site_build_provider_wire_receipt_scope_fkey"
    FOREIGN KEY ("wire_attempt_id", "workspace_id", "site_id", "build_run_id")
    REFERENCES "site_build_provider_wire_attempt"(
      "id", "workspace_id", "site_id", "build_run_id"
    ) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "site_build_provider_wire_receipt_shape_check" CHECK (
    "receipt_digest" ~ '^[0-9a-f]{64}$'
    AND "alias" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
    AND "protocol" IN ('openai-chat-completions', 'openai-responses', 'anthropic-messages')
    AND "channel_id" BETWEEN 1 AND 1000000000
    AND "quota" BETWEEN 0 AND 1000000000
    AND "input_tokens" BETWEEN 0 AND 1000000000
    AND "output_tokens" BETWEEN 0 AND 1000000000
    AND "exact_cost_microusd" BETWEEN 0 AND 1000000000000000
    AND "upstream_id_state" IN ('observed', 'absent')
  )
);

CREATE INDEX "site_build_provider_wire_receipt_workspace_run_idx"
  ON "site_build_provider_wire_receipt"(
    "workspace_id", "build_run_id", "observed_at"
  );

CREATE TABLE "site_build_provider_readback_probe" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "spend_id" UUID NOT NULL,
  "wire_attempt_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "claimed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_build_provider_readback_probe_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_provider_probe_wire_sequence_key"
    UNIQUE ("wire_attempt_id", "sequence"),
  CONSTRAINT "site_build_provider_probe_scope_key"
    UNIQUE ("id", "workspace_id", "site_id", "build_run_id"),
  CONSTRAINT "site_build_provider_probe_wire_scope_fkey"
    FOREIGN KEY ("wire_attempt_id", "workspace_id", "site_id", "build_run_id")
    REFERENCES "site_build_provider_wire_attempt"(
      "id", "workspace_id", "site_id", "build_run_id"
    ) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "site_build_provider_probe_sequence_check"
    CHECK ("sequence" IN (1, 2))
);

CREATE INDEX "site_build_provider_probe_workspace_run_idx"
  ON "site_build_provider_readback_probe"(
    "workspace_id", "build_run_id", "claimed_at"
  );

CREATE TABLE "site_build_provider_readback_probe_observation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "spend_id" UUID NOT NULL,
  "probe_id" UUID NOT NULL,
  "phase" VARCHAR(64) NOT NULL,
  "http_status_class" INTEGER,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_build_provider_probe_observation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_provider_probe_observation_probe_key" UNIQUE ("probe_id"),
  CONSTRAINT "site_build_provider_probe_observation_scope_key"
    UNIQUE ("probe_id", "workspace_id", "site_id", "build_run_id"),
  CONSTRAINT "site_build_provider_probe_observation_scope_fkey"
    FOREIGN KEY ("probe_id", "workspace_id", "site_id", "build_run_id")
    REFERENCES "site_build_provider_readback_probe"(
      "id", "workspace_id", "site_id", "build_run_id"
    ) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "site_build_provider_probe_observation_shape_check" CHECK (
    "phase" IN (
      'gateway_log_observed', 'gateway_log_pending', 'gateway_log_missing',
      'gateway_log_unavailable', 'gateway_log_invalid',
      'gateway_log_ambiguous'
    )
    AND ("http_status_class" IS NULL OR "http_status_class" IN (2, 4, 5))
  )
);

CREATE INDEX "site_build_provider_probe_observation_workspace_run_idx"
  ON "site_build_provider_readback_probe_observation"(
    "workspace_id", "build_run_id", "observed_at"
  );

CREATE FUNCTION guard_site_build_provider_wire_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."workspace_id" IS DISTINCT FROM NEW."workspace_id"
    OR OLD."site_id" IS DISTINCT FROM NEW."site_id"
    OR OLD."build_run_id" IS DISTINCT FROM NEW."build_run_id"
    OR OLD."spend_id" IS DISTINCT FROM NEW."spend_id"
    OR OLD."operation_key" IS DISTINCT FROM NEW."operation_key"
    OR OLD."contract_version" IS DISTINCT FROM NEW."contract_version"
    OR OLD."physical_wire_attempt" IS DISTINCT FROM NEW."physical_wire_attempt"
    OR OLD."derivation_key_id" IS DISTINCT FROM NEW."derivation_key_id"
    OR OLD."settlement_request_id" IS DISTINCT FROM NEW."settlement_request_id"
    OR OLD."settlement_nonce_sha256" IS DISTINCT FROM NEW."settlement_nonce_sha256"
    OR OLD."resolver_id" IS DISTINCT FROM NEW."resolver_id"
    OR OLD."protocol" IS DISTINCT FROM NEW."protocol"
    OR OLD."requested_alias" IS DISTINCT FROM NEW."requested_alias"
    OR OLD."expected_channel_id" IS DISTINCT FROM NEW."expected_channel_id"
    OR OLD."prompt_utf8_bytes" IS DISTINCT FROM NEW."prompt_utf8_bytes"
    OR OLD."maximum_wire_calls" IS DISTINCT FROM NEW."maximum_wire_calls"
    OR OLD."actual_max_output_tokens" IS DISTINCT FROM NEW."actual_max_output_tokens"
    OR OLD."catalog_max_output_tokens" IS DISTINCT FROM NEW."catalog_max_output_tokens"
    OR OLD."maximum_quota_points" IS DISTINCT FROM NEW."maximum_quota_points"
    OR OLD."catalog_id" IS DISTINCT FROM NEW."catalog_id"
    OR OLD."catalog_sha256" IS DISTINCT FROM NEW."catalog_sha256"
    OR OLD."pricing_snapshot_sha256" IS DISTINCT FROM NEW."pricing_snapshot_sha256"
    OR OLD."input_price_microunits_per_million" IS DISTINCT FROM NEW."input_price_microunits_per_million"
    OR OLD."output_price_microunits_per_million" IS DISTINCT FROM NEW."output_price_microunits_per_million"
    OR OLD."ledger_microusd_per_pricing_unit" IS DISTINCT FROM NEW."ledger_microusd_per_pricing_unit"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN
    RAISE EXCEPTION 'immutable provider wire context mismatch';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "site_build_provider_wire_immutable_guard"
  BEFORE UPDATE ON "site_build_provider_wire_attempt"
  FOR EACH ROW EXECUTE FUNCTION guard_site_build_provider_wire_immutable();

CREATE FUNCTION deny_site_build_provider_append_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'site build provider readback facts are append-only';
END
$$;

CREATE TRIGGER "site_build_provider_probe_append_only"
  BEFORE UPDATE OR DELETE ON "site_build_provider_readback_probe"
  FOR EACH ROW EXECUTE FUNCTION deny_site_build_provider_append_mutation();
CREATE TRIGGER "site_build_provider_wire_receipt_append_only"
  BEFORE UPDATE OR DELETE ON "site_build_provider_wire_receipt"
  FOR EACH ROW EXECUTE FUNCTION deny_site_build_provider_append_mutation();
CREATE TRIGGER "site_build_provider_probe_observation_append_only"
  BEFORE UPDATE OR DELETE ON "site_build_provider_readback_probe_observation"
  FOR EACH ROW EXECUTE FUNCTION deny_site_build_provider_append_mutation();

ALTER TABLE "site_build_provider_wire_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_provider_wire_attempt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_build_provider_wire_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_provider_wire_receipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_build_provider_readback_probe" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_provider_readback_probe" FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_build_provider_readback_probe_observation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_provider_readback_probe_observation" FORCE ROW LEVEL SECURITY;

CREATE POLICY "site_build_provider_wire_workspace_policy"
  ON "site_build_provider_wire_attempt"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
CREATE POLICY "site_build_provider_wire_receipt_workspace_policy"
  ON "site_build_provider_wire_receipt"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
CREATE POLICY "site_build_provider_probe_workspace_policy"
  ON "site_build_provider_readback_probe"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
CREATE POLICY "site_build_provider_probe_observation_workspace_policy"
  ON "site_build_provider_readback_probe_observation"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- Retain the legacy implementation for tools and historical replay, but make
-- the public name reject every new model reservation. Only the successor can
-- create a model Spend plus its first immutable wire identity atomically.
ALTER FUNCTION reserve_site_build_spend(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, TEXT, BIGINT, JSONB)
  RENAME TO reserve_site_build_spend_legacy_20260904;
REVOKE ALL ON FUNCTION reserve_site_build_spend_legacy_20260904(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, TEXT, BIGINT, JSONB)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay;

CREATE FUNCTION reserve_site_build_spend(
  p_workspace_id UUID,
  p_build_run_id UUID,
  p_task_attempt_id UUID,
  p_fence_token UUID,
  p_operation_key VARCHAR(64),
  p_kind TEXT,
  p_task_id TEXT,
  p_subject TEXT,
  p_reservation_microusd BIGINT,
  p_meta JSONB
)
RETURNS TABLE (
  decision TEXT,
  spend_id UUID,
  spend_status TEXT,
  cached_result JSONB,
  cached_meta JSONB,
  cached_error_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_kind = 'model' THEN
    RAISE EXCEPTION 'MODEL_WIRE_AUTHORITY_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT * FROM reserve_site_build_spend_legacy_20260904(
    p_workspace_id, p_build_run_id, p_task_attempt_id, p_fence_token,
    p_operation_key, p_kind, p_task_id, p_subject,
    p_reservation_microusd, p_meta
  );
END
$$;

CREATE FUNCTION reserve_site_build_model_spend_v1(
  p_workspace_id UUID,
  p_build_run_id UUID,
  p_task_attempt_id UUID,
  p_fence_token UUID,
  p_operation_key VARCHAR(64),
  p_task_id TEXT,
  p_subject TEXT,
  p_reservation_microusd BIGINT,
  p_meta JSONB,
  p_derivation_key_id VARCHAR(64),
  p_settlement_request_id VARCHAR(43),
  p_settlement_nonce_sha256 VARCHAR(64),
  p_resolver_id VARCHAR(191),
  p_protocol VARCHAR(32),
  p_requested_alias VARCHAR(120),
  p_expected_channel_id INTEGER,
  p_prompt_utf8_bytes INTEGER,
  p_maximum_wire_calls INTEGER,
  p_actual_max_output_tokens INTEGER,
  p_catalog_max_output_tokens INTEGER,
  p_maximum_quota_points BIGINT,
  p_catalog_id VARCHAR(191),
  p_catalog_sha256 VARCHAR(64),
  p_pricing_snapshot_sha256 VARCHAR(64),
  p_input_price_microunits_per_million BIGINT,
  p_output_price_microunits_per_million BIGINT,
  p_ledger_microusd_per_pricing_unit BIGINT
)
RETURNS TABLE (
  decision TEXT,
  spend_id UUID,
  spend_status TEXT,
  cached_result JSONB,
  cached_meta JSONB,
  cached_error_code TEXT,
  wire_attempt_id UUID,
  physical_wire_attempt INTEGER,
  wire_state TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reserve RECORD;
  v_existing "site_build_spend"%ROWTYPE;
  v_wire "site_build_provider_wire_attempt"%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_operation_key !~ '^[0-9a-f]{64}$'
    OR p_derivation_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'
    OR p_settlement_request_id !~ '^[A-Za-z0-9_-]{43}$'
    OR p_settlement_nonce_sha256 !~ '^[0-9a-f]{64}$'
    OR p_resolver_id <> 'new-api-request-bound-reconciliation-v1'
    OR p_protocol NOT IN ('openai-chat-completions', 'openai-responses', 'anthropic-messages')
    OR p_requested_alias !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
    OR p_expected_channel_id NOT BETWEEN 1 AND 1000000000
    OR p_prompt_utf8_bytes <= 0
    OR p_maximum_wire_calls NOT IN (1, 2)
    OR p_actual_max_output_tokens <= 0
    OR p_catalog_max_output_tokens < p_actual_max_output_tokens
    OR p_maximum_quota_points NOT BETWEEN 1 AND 1000000000
    OR p_catalog_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,190}$'
    OR p_catalog_sha256 !~ '^[0-9a-f]{64}$'
    OR p_pricing_snapshot_sha256 !~ '^[0-9a-f]{64}$'
    OR p_input_price_microunits_per_million NOT BETWEEN 0 AND 500000000000
    OR p_output_price_microunits_per_million NOT BETWEEN 0 AND 500000000000
    OR p_ledger_microusd_per_pricing_unit <> 1000000
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_CONTEXT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize this exact logical operation before consulting the legacy
  -- reserve implementation. Without this lock, a concurrent duplicate could
  -- enter the legacy RESERVED replay branch and conservatively terminalize the
  -- first live execution as ACK_UNKNOWN.
  PERFORM pg_advisory_xact_lock(
    hashtext('site-build-model-spend-' || p_build_run_id::text || '-' || p_operation_key)
  );
  SELECT * INTO v_existing
  FROM "site_build_spend" s
  WHERE s."workspace_id" = p_workspace_id
    AND s."build_run_id" = p_build_run_id
    AND s."operation_key" = p_operation_key
  FOR UPDATE;
  IF v_existing."id" IS NOT NULL THEN
    SELECT * INTO v_wire
    FROM "site_build_provider_wire_attempt" w
    WHERE w."spend_id" = v_existing."id"
      AND w."workspace_id" = p_workspace_id
      AND w."physical_wire_attempt" = 1;
    IF v_wire."id" IS NULL THEN
      RETURN QUERY SELECT
        'LEGACY_MODEL_SPEND', v_existing."id", v_existing."status",
        v_existing."result_json", v_existing."meta", v_existing."error_code",
        NULL::UUID, NULL::INTEGER, NULL::TEXT;
      RETURN;
    END IF;
    IF v_wire."operation_key" IS DISTINCT FROM p_operation_key
      OR v_wire."derivation_key_id" IS DISTINCT FROM p_derivation_key_id
      OR v_wire."settlement_request_id" IS DISTINCT FROM p_settlement_request_id
      OR v_wire."settlement_nonce_sha256" IS DISTINCT FROM p_settlement_nonce_sha256
      OR v_wire."resolver_id" IS DISTINCT FROM p_resolver_id
      OR v_wire."protocol" IS DISTINCT FROM p_protocol
      OR v_wire."requested_alias" IS DISTINCT FROM p_requested_alias
      OR v_wire."expected_channel_id" IS DISTINCT FROM p_expected_channel_id
      OR v_wire."prompt_utf8_bytes" IS DISTINCT FROM p_prompt_utf8_bytes
      OR v_wire."maximum_wire_calls" IS DISTINCT FROM p_maximum_wire_calls
      OR v_wire."actual_max_output_tokens" IS DISTINCT FROM p_actual_max_output_tokens
      OR v_wire."catalog_max_output_tokens" IS DISTINCT FROM p_catalog_max_output_tokens
      OR v_wire."maximum_quota_points" IS DISTINCT FROM p_maximum_quota_points
      OR v_wire."catalog_id" IS DISTINCT FROM p_catalog_id
      OR v_wire."catalog_sha256" IS DISTINCT FROM p_catalog_sha256
      OR v_wire."pricing_snapshot_sha256" IS DISTINCT FROM p_pricing_snapshot_sha256
      OR v_wire."input_price_microunits_per_million" IS DISTINCT FROM p_input_price_microunits_per_million
      OR v_wire."output_price_microunits_per_million" IS DISTINCT FROM p_output_price_microunits_per_million
      OR v_wire."ledger_microusd_per_pricing_unit" IS DISTINCT FROM p_ledger_microusd_per_pricing_unit
    THEN
      RAISE EXCEPTION 'immutable provider wire context mismatch' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT
      'REPLAY', v_existing."id", v_existing."status",
      v_existing."result_json", v_existing."meta", v_existing."error_code",
      v_wire."id", v_wire."physical_wire_attempt", v_wire."state"::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_reserve
  FROM reserve_site_build_spend_legacy_20260904(
    p_workspace_id, p_build_run_id, p_task_attempt_id, p_fence_token,
    p_operation_key, 'model', p_task_id, p_subject,
    p_reservation_microusd, COALESCE(p_meta, '{}'::jsonb)
  );

  IF v_reserve.decision = 'EXECUTE' THEN
    INSERT INTO "site_build_provider_wire_attempt"(
      "workspace_id", "site_id", "build_run_id", "spend_id",
      "operation_key", "physical_wire_attempt", "derivation_key_id",
      "settlement_request_id", "settlement_nonce_sha256", "resolver_id",
      "protocol", "requested_alias", "expected_channel_id",
      "prompt_utf8_bytes", "maximum_wire_calls",
      "actual_max_output_tokens", "catalog_max_output_tokens",
      "maximum_quota_points", "catalog_id", "catalog_sha256",
      "pricing_snapshot_sha256", "input_price_microunits_per_million",
      "output_price_microunits_per_million",
      "ledger_microusd_per_pricing_unit"
    )
    SELECT
      s."workspace_id", s."site_id", s."build_run_id", s."id",
      s."operation_key", 1, p_derivation_key_id,
      p_settlement_request_id, p_settlement_nonce_sha256, p_resolver_id,
      p_protocol, p_requested_alias, p_expected_channel_id,
      p_prompt_utf8_bytes, p_maximum_wire_calls,
      p_actual_max_output_tokens, p_catalog_max_output_tokens,
      p_maximum_quota_points, p_catalog_id, p_catalog_sha256,
      p_pricing_snapshot_sha256, p_input_price_microunits_per_million,
      p_output_price_microunits_per_million,
      p_ledger_microusd_per_pricing_unit
    FROM "site_build_spend" s
    WHERE s."id" = v_reserve.spend_id
      AND s."workspace_id" = p_workspace_id
    RETURNING * INTO v_wire;
  ELSE
    SELECT * INTO v_wire
    FROM "site_build_provider_wire_attempt" w
    WHERE w."spend_id" = v_reserve.spend_id
      AND w."workspace_id" = p_workspace_id
      AND w."physical_wire_attempt" = 1;
    IF v_reserve.spend_id IS NOT NULL AND v_wire."id" IS NULL THEN
      RETURN QUERY SELECT
        'LEGACY_MODEL_SPEND', v_reserve.spend_id,
        v_reserve.spend_status, v_reserve.cached_result,
        v_reserve.cached_meta, v_reserve.cached_error_code,
        NULL::UUID, NULL::INTEGER, NULL::TEXT;
      RETURN;
    END IF;
    IF v_wire."id" IS NOT NULL AND (
      v_wire."operation_key" IS DISTINCT FROM p_operation_key
      OR v_wire."derivation_key_id" IS DISTINCT FROM p_derivation_key_id
      OR v_wire."settlement_request_id" IS DISTINCT FROM p_settlement_request_id
      OR v_wire."settlement_nonce_sha256" IS DISTINCT FROM p_settlement_nonce_sha256
      OR v_wire."resolver_id" IS DISTINCT FROM p_resolver_id
      OR v_wire."protocol" IS DISTINCT FROM p_protocol
      OR v_wire."requested_alias" IS DISTINCT FROM p_requested_alias
      OR v_wire."expected_channel_id" IS DISTINCT FROM p_expected_channel_id
      OR v_wire."prompt_utf8_bytes" IS DISTINCT FROM p_prompt_utf8_bytes
      OR v_wire."maximum_wire_calls" IS DISTINCT FROM p_maximum_wire_calls
      OR v_wire."actual_max_output_tokens" IS DISTINCT FROM p_actual_max_output_tokens
      OR v_wire."catalog_max_output_tokens" IS DISTINCT FROM p_catalog_max_output_tokens
      OR v_wire."maximum_quota_points" IS DISTINCT FROM p_maximum_quota_points
      OR v_wire."catalog_id" IS DISTINCT FROM p_catalog_id
      OR v_wire."catalog_sha256" IS DISTINCT FROM p_catalog_sha256
      OR v_wire."pricing_snapshot_sha256" IS DISTINCT FROM p_pricing_snapshot_sha256
      OR v_wire."input_price_microunits_per_million" IS DISTINCT FROM p_input_price_microunits_per_million
      OR v_wire."output_price_microunits_per_million" IS DISTINCT FROM p_output_price_microunits_per_million
      OR v_wire."ledger_microusd_per_pricing_unit" IS DISTINCT FROM p_ledger_microusd_per_pricing_unit
    ) THEN
      RAISE EXCEPTION 'immutable provider wire context mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_reserve.decision, v_reserve.spend_id, v_reserve.spend_status,
    v_reserve.cached_result, v_reserve.cached_meta,
    v_reserve.cached_error_code, v_wire."id",
    v_wire."physical_wire_attempt", v_wire."state"::TEXT;
END
$$;

CREATE FUNCTION allocate_site_build_provider_wire_v1(
  p_workspace_id UUID,
  p_build_run_id UUID,
  p_spend_id UUID,
  p_operation_key VARCHAR(64),
  p_fence_token UUID,
  p_derivation_key_id VARCHAR(64),
  p_settlement_request_id VARCHAR(43),
  p_settlement_nonce_sha256 VARCHAR(64)
)
RETURNS TABLE (
  decision TEXT,
  wire_attempt_id UUID,
  physical_wire_attempt INTEGER,
  wire_state TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_spend "site_build_spend"%ROWTYPE;
  v_first "site_build_provider_wire_attempt"%ROWTYPE;
  v_second "site_build_provider_wire_attempt"%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_operation_key !~ '^[0-9a-f]{64}$'
    OR p_derivation_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'
    OR p_settlement_request_id !~ '^[A-Za-z0-9_-]{43}$'
    OR p_settlement_nonce_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_CONTEXT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_spend FROM "site_build_spend" s
  WHERE s."id" = p_spend_id AND s."workspace_id" = p_workspace_id
    AND s."build_run_id" = p_build_run_id
  FOR UPDATE;
  SELECT * INTO v_first FROM "site_build_provider_wire_attempt" w
  WHERE w."spend_id" = p_spend_id AND w."workspace_id" = p_workspace_id
    AND w."physical_wire_attempt" = 1
  FOR UPDATE;
  SELECT * INTO v_second FROM "site_build_provider_wire_attempt" w
  WHERE w."spend_id" = p_spend_id AND w."workspace_id" = p_workspace_id
    AND w."physical_wire_attempt" = 2;

  IF v_spend."id" IS NULL OR v_first."id" IS NULL
    OR v_spend."kind" <> 'model'
    OR v_spend."status" <> 'RESERVED'
    OR v_spend."operation_key" IS DISTINCT FROM p_operation_key
    OR v_spend."fence_token" IS DISTINCT FROM p_fence_token
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_ALLOCATION_DENIED' USING ERRCODE = 'P0001';
  END IF;
  IF v_second."id" IS NOT NULL THEN
    IF v_second."derivation_key_id" IS DISTINCT FROM p_derivation_key_id
      OR v_second."settlement_request_id" IS DISTINCT FROM p_settlement_request_id
      OR v_second."settlement_nonce_sha256" IS DISTINCT FROM p_settlement_nonce_sha256
    THEN
      RAISE EXCEPTION 'immutable provider wire context mismatch' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT 'REPLAY', v_second."id", 2, v_second."state"::TEXT;
    RETURN;
  END IF;
  IF v_first."maximum_wire_calls" <> 2
    OR v_first."state" <> 'OBSERVED'
    OR v_first."settlement_status" <> 'SETTLED'
    OR v_first."payload_state" <> 'available'
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_REPAIR_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "site_build_provider_wire_attempt"(
    "workspace_id", "site_id", "build_run_id", "spend_id",
    "operation_key", "physical_wire_attempt", "derivation_key_id",
    "settlement_request_id", "settlement_nonce_sha256", "resolver_id",
    "protocol", "requested_alias", "expected_channel_id",
    "prompt_utf8_bytes", "maximum_wire_calls",
    "actual_max_output_tokens", "catalog_max_output_tokens",
    "maximum_quota_points", "catalog_id", "catalog_sha256",
    "pricing_snapshot_sha256", "input_price_microunits_per_million",
    "output_price_microunits_per_million",
    "ledger_microusd_per_pricing_unit"
  ) VALUES (
    v_first."workspace_id", v_first."site_id", v_first."build_run_id",
    v_first."spend_id", v_first."operation_key", 2,
    p_derivation_key_id, p_settlement_request_id,
    p_settlement_nonce_sha256, v_first."resolver_id", v_first."protocol",
    v_first."requested_alias", v_first."expected_channel_id",
    v_first."prompt_utf8_bytes", v_first."maximum_wire_calls",
    v_first."actual_max_output_tokens", v_first."catalog_max_output_tokens",
    v_first."maximum_quota_points", v_first."catalog_id",
    v_first."catalog_sha256", v_first."pricing_snapshot_sha256",
    v_first."input_price_microunits_per_million",
    v_first."output_price_microunits_per_million",
    v_first."ledger_microusd_per_pricing_unit"
  ) RETURNING * INTO v_second;
  RETURN QUERY SELECT 'EXECUTE', v_second."id", 2, v_second."state"::TEXT;
END
$$;

CREATE FUNCTION begin_site_build_provider_wire_v1(
  p_workspace_id UUID,
  p_wire_attempt_id UUID,
  p_fence_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_wire "site_build_provider_wire_attempt"%ROWTYPE;
  v_spend "site_build_spend"%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  SELECT * INTO v_wire FROM "site_build_provider_wire_attempt"
  WHERE "id" = p_wire_attempt_id AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  SELECT * INTO v_spend FROM "site_build_spend"
  WHERE "id" = v_wire."spend_id" AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  IF v_wire."id" IS NULL OR v_spend."id" IS NULL
    OR v_spend."status" <> 'RESERVED'
    OR v_spend."fence_token" IS DISTINCT FROM p_fence_token
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_SEND_DENIED' USING ERRCODE = 'P0001';
  END IF;
  IF v_wire."state" <> 'ALLOCATED' THEN
    RETURN 'READBACK_ONLY';
  END IF;
  UPDATE "site_build_provider_wire_attempt"
  SET "state" = 'DISPATCH_STARTED', "dispatch_started_at" = clock_timestamp()
  WHERE "id" = v_wire."id";
  RETURN 'DISPATCH';
END
$$;

CREATE FUNCTION claim_site_build_provider_readback_probe_v1(
  p_workspace_id UUID,
  p_wire_attempt_id UUID,
  p_sequence INTEGER
)
RETURNS TABLE (decision TEXT, probe_id UUID, sequence INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_wire "site_build_provider_wire_attempt"%ROWTYPE;
  v_probe "site_build_provider_readback_probe"%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_sequence NOT IN (1, 2)
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_PROBE_CLAIM_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_wire FROM "site_build_provider_wire_attempt"
  WHERE "id" = p_wire_attempt_id AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  IF v_wire."id" IS NULL
    OR v_wire."state" NOT IN ('DISPATCH_STARTED', 'UNKNOWN')
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_PROBE_CLAIM_DENIED' USING ERRCODE = 'P0001';
  END IF;
  IF p_sequence = 2 AND NOT EXISTS (
    SELECT 1 FROM "site_build_provider_readback_probe" p
    WHERE p."wire_attempt_id" = p_wire_attempt_id AND p."sequence" = 1
  ) THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_PROBE_SEQUENCE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "site_build_provider_readback_probe"(
    "workspace_id", "site_id", "build_run_id", "spend_id",
    "wire_attempt_id", "sequence"
  ) VALUES (
    v_wire."workspace_id", v_wire."site_id", v_wire."build_run_id",
    v_wire."spend_id", v_wire."id", p_sequence
  ) ON CONFLICT ON CONSTRAINT "site_build_provider_probe_wire_sequence_key"
  DO NOTHING
  RETURNING * INTO v_probe;
  IF v_probe."id" IS NULL THEN
    SELECT * INTO v_probe FROM "site_build_provider_readback_probe" p
    WHERE p."wire_attempt_id" = p_wire_attempt_id AND p."sequence" = p_sequence;
    RETURN QUERY SELECT 'REPLAY', v_probe."id", v_probe."sequence";
    RETURN;
  END IF;
  IF (SELECT count(*) FROM "site_build_provider_readback_probe" p
      WHERE p."wire_attempt_id" = p_wire_attempt_id) > 2 THEN
    RAISE EXCEPTION 'readback probe count exceeds two';
  END IF;
  RETURN QUERY SELECT 'CLAIMED', v_probe."id", v_probe."sequence";
END
$$;

CREATE FUNCTION record_site_build_provider_readback_probe_v1(
  p_workspace_id UUID,
  p_probe_id UUID,
  p_phase VARCHAR(64),
  p_http_status_class INTEGER,
  p_observed_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_probe "site_build_provider_readback_probe"%ROWTYPE;
  v_existing "site_build_provider_readback_probe_observation"%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_phase NOT IN (
      'gateway_log_observed', 'gateway_log_pending', 'gateway_log_missing',
      'gateway_log_unavailable', 'gateway_log_invalid',
      'gateway_log_ambiguous'
    )
    OR (p_http_status_class IS NOT NULL AND p_http_status_class NOT IN (2, 4, 5))
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_PROBE_OBSERVATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_probe FROM "site_build_provider_readback_probe"
  WHERE "id" = p_probe_id AND "workspace_id" = p_workspace_id;
  IF v_probe."id" IS NULL THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_PROBE_OBSERVATION_DENIED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_existing
  FROM "site_build_provider_readback_probe_observation"
  WHERE "probe_id" = p_probe_id;
  IF v_existing."id" IS NOT NULL THEN
    IF v_existing."phase" IS DISTINCT FROM p_phase
      OR v_existing."http_status_class" IS DISTINCT FROM p_http_status_class
      OR v_existing."observed_at" IS DISTINCT FROM p_observed_at
    THEN
      RAISE EXCEPTION 'SITE_BUILD_PROVIDER_PROBE_OBSERVATION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    RETURN 'REPLAY';
  END IF;
  INSERT INTO "site_build_provider_readback_probe_observation"(
    "workspace_id", "site_id", "build_run_id", "spend_id", "probe_id",
    "phase", "http_status_class", "observed_at"
  ) VALUES (
    v_probe."workspace_id", v_probe."site_id", v_probe."build_run_id",
    v_probe."spend_id", v_probe."id", p_phase, p_http_status_class,
    p_observed_at
  );
  RETURN 'RECORDED';
END
$$;

CREATE FUNCTION record_site_build_provider_wire_receipt_v1(
  p_workspace_id UUID,
  p_wire_attempt_id UUID,
  p_receipt_digest VARCHAR(64),
  p_alias VARCHAR(191),
  p_protocol VARCHAR(32),
  p_channel_id INTEGER,
  p_quota BIGINT,
  p_input_tokens INTEGER,
  p_output_tokens INTEGER,
  p_exact_cost_microusd BIGINT,
  p_upstream_id_state VARCHAR(32),
  p_observed_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_wire "site_build_provider_wire_attempt"%ROWTYPE;
  v_existing "site_build_provider_wire_receipt"%ROWTYPE;
  v_expected_cost NUMERIC;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_receipt_digest !~ '^[0-9a-f]{64}$'
    OR p_alias !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
    OR p_protocol NOT IN ('openai-chat-completions', 'openai-responses', 'anthropic-messages')
    OR p_channel_id NOT BETWEEN 1 AND 1000000000
    OR p_quota NOT BETWEEN 0 AND 1000000000
    OR p_input_tokens NOT BETWEEN 0 AND 1000000000
    OR p_output_tokens NOT BETWEEN 0 AND 1000000000
    OR p_exact_cost_microusd NOT BETWEEN 0 AND 1000000000000000
    OR p_upstream_id_state NOT IN ('observed', 'absent')
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_RECEIPT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_wire FROM "site_build_provider_wire_attempt" w
  WHERE w."id" = p_wire_attempt_id AND w."workspace_id" = p_workspace_id
  FOR UPDATE;
  IF v_wire."id" IS NULL
    OR v_wire."state" NOT IN ('DISPATCH_STARTED', 'OBSERVED', 'UNKNOWN')
    OR v_wire."requested_alias" IS DISTINCT FROM p_alias
    OR v_wire."protocol" IS DISTINCT FROM p_protocol
    OR v_wire."expected_channel_id" IS DISTINCT FROM p_channel_id
    OR p_quota > v_wire."maximum_quota_points"
    OR p_output_tokens > v_wire."actual_max_output_tokens"
  THEN
    RAISE EXCEPTION 'immutable provider wire context mismatch' USING ERRCODE = 'P0001';
  END IF;
  v_expected_cost := ceil((
    p_input_tokens::numeric * v_wire."input_price_microunits_per_million"::numeric
    + p_output_tokens::numeric * v_wire."output_price_microunits_per_million"::numeric
  ) * v_wire."ledger_microusd_per_pricing_unit"::numeric / 1000000000000::numeric);
  IF v_expected_cost > 9223372036854775807::numeric
    OR v_expected_cost::bigint IS DISTINCT FROM p_exact_cost_microusd
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_RECEIPT_PRICE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_existing FROM "site_build_provider_wire_receipt" r
  WHERE r."wire_attempt_id" = p_wire_attempt_id;
  IF v_existing."id" IS NOT NULL THEN
    IF v_existing."receipt_digest" IS DISTINCT FROM p_receipt_digest
      OR v_existing."alias" IS DISTINCT FROM p_alias
      OR v_existing."protocol" IS DISTINCT FROM p_protocol
      OR v_existing."channel_id" IS DISTINCT FROM p_channel_id
      OR v_existing."quota" IS DISTINCT FROM p_quota
      OR v_existing."input_tokens" IS DISTINCT FROM p_input_tokens
      OR v_existing."output_tokens" IS DISTINCT FROM p_output_tokens
      OR v_existing."exact_cost_microusd" IS DISTINCT FROM p_exact_cost_microusd
      OR v_existing."upstream_id_state" IS DISTINCT FROM p_upstream_id_state
    THEN
      RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_RECEIPT_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    RETURN 'REPLAY';
  END IF;
  INSERT INTO "site_build_provider_wire_receipt"(
    "workspace_id", "site_id", "build_run_id", "spend_id",
    "wire_attempt_id", "receipt_digest", "alias", "protocol",
    "channel_id", "quota", "input_tokens", "output_tokens",
    "exact_cost_microusd", "upstream_id_state", "observed_at"
  ) VALUES (
    v_wire."workspace_id", v_wire."site_id", v_wire."build_run_id",
    v_wire."spend_id", v_wire."id", p_receipt_digest, p_alias,
    p_protocol, p_channel_id, p_quota, p_input_tokens, p_output_tokens,
    p_exact_cost_microusd, p_upstream_id_state, p_observed_at
  );
  RETURN 'RECORDED';
END
$$;

CREATE FUNCTION finalize_site_build_provider_wire_v1(
  p_workspace_id UUID,
  p_wire_attempt_id UUID,
  p_settlement_status VARCHAR(16),
  p_final_phase VARCHAR(64),
  p_gateway_id_state VARCHAR(32),
  p_upstream_id_state VARCHAR(32),
  p_payload_state VARCHAR(32),
  p_observed_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_wire "site_build_provider_wire_attempt"%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_settlement_status NOT IN ('SETTLED', 'UNKNOWN')
    OR p_final_phase NOT IN (
      'gateway_unavailable', 'gateway_request_id_observed',
      'upstream_ack_unknown', 'payload_unavailable',
      'gateway_log_missing', 'gateway_log_unavailable',
      'gateway_log_invalid', 'database_ack_unknown'
    )
    OR p_gateway_id_state NOT IN ('observed', 'missing', 'not_observable')
    OR p_upstream_id_state NOT IN ('observed', 'absent', 'not_exposed', 'unknown')
    OR p_payload_state NOT IN ('not_read', 'available', 'unavailable')
    OR (p_settlement_status = 'SETTLED' AND (
      p_final_phase <> 'gateway_request_id_observed'
      OR p_payload_state <> 'available'
      OR p_upstream_id_state NOT IN ('observed', 'absent')
    ))
  THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_OBSERVATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_wire FROM "site_build_provider_wire_attempt"
  WHERE "id" = p_wire_attempt_id AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  IF v_wire."id" IS NULL THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_OBSERVATION_DENIED' USING ERRCODE = 'P0001';
  END IF;
  IF v_wire."state" IN ('OBSERVED', 'UNKNOWN') THEN
    IF v_wire."settlement_status" IS DISTINCT FROM p_settlement_status
      OR v_wire."final_phase" IS DISTINCT FROM p_final_phase
      OR v_wire."gateway_id_state" IS DISTINCT FROM p_gateway_id_state
      OR v_wire."upstream_id_state" IS DISTINCT FROM p_upstream_id_state
      OR v_wire."payload_state" IS DISTINCT FROM p_payload_state
      OR v_wire."observed_at" IS DISTINCT FROM p_observed_at
    THEN
      RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_OBSERVATION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    RETURN 'REPLAY';
  END IF;
  IF v_wire."state" <> 'DISPATCH_STARTED' THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_SEND_NOT_STARTED' USING ERRCODE = 'P0001';
  END IF;
  IF p_settlement_status = 'SETTLED' AND NOT EXISTS (
    SELECT 1 FROM "site_build_provider_wire_receipt" r
    WHERE r."wire_attempt_id" = p_wire_attempt_id
      AND r."workspace_id" = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_RECEIPT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM "site_build_provider_readback_probe"
      WHERE "wire_attempt_id" = p_wire_attempt_id) > 2 THEN
    RAISE EXCEPTION 'readback probe count exceeds two';
  END IF;
  UPDATE "site_build_provider_wire_attempt"
  SET "state" = CASE WHEN p_settlement_status = 'SETTLED' THEN 'OBSERVED' ELSE 'UNKNOWN' END,
      "settlement_status" = p_settlement_status,
      "final_phase" = p_final_phase,
      "gateway_id_state" = p_gateway_id_state,
      "upstream_id_state" = p_upstream_id_state,
      "payload_state" = p_payload_state,
      "observed_at" = p_observed_at
  WHERE "id" = p_wire_attempt_id;
  RETURN 'FINALIZED';
END
$$;

-- Recovery may prove exact cost from an already-recorded receipt after the
-- request process lost its database acknowledgement. It must not claim that
-- the provider payload survived: provider receipt recovery cannot claim payload.
CREATE FUNCTION finalize_site_build_provider_wire_from_receipt_v1(
  p_workspace_id UUID,
  p_wire_attempt_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_wire "site_build_provider_wire_attempt"%ROWTYPE;
  v_receipt "site_build_provider_wire_receipt"%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_RECEIPT_RECOVERY_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_wire FROM "site_build_provider_wire_attempt"
  WHERE "id" = p_wire_attempt_id AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  IF v_wire."id" IS NULL THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_RECEIPT_RECOVERY_DENIED' USING ERRCODE = 'P0001';
  END IF;
  IF v_wire."state" = 'OBSERVED' THEN
    RETURN 'REPLAY';
  END IF;
  IF v_wire."state" <> 'DISPATCH_STARTED' THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_RECEIPT_RECOVERY_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_receipt FROM "site_build_provider_wire_receipt"
  WHERE "wire_attempt_id" = p_wire_attempt_id
    AND "workspace_id" = p_workspace_id;
  IF v_receipt."id" IS NULL THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_RECEIPT_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  UPDATE "site_build_provider_wire_attempt"
  SET "state" = 'OBSERVED',
      "settlement_status" = 'SETTLED',
      "final_phase" = 'gateway_request_id_observed',
      "gateway_id_state" = 'not_observable',
      "upstream_id_state" = v_receipt."upstream_id_state",
      "payload_state" = 'unavailable',
      "observed_at" = v_receipt."observed_at"
  WHERE "id" = p_wire_attempt_id;
  RETURN 'FINALIZED';
END
$$;

-- ALLOCATED is affirmative evidence that the send cut was never crossed. A
-- terminal recovery can therefore close the attempt as not incurred without
-- inventing a physical call or performing settlement readback.
CREATE FUNCTION finalize_site_build_provider_wire_not_dispatched_v1(
  p_workspace_id UUID,
  p_wire_attempt_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_wire "site_build_provider_wire_attempt"%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_NOT_DISPATCHED_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_wire FROM "site_build_provider_wire_attempt"
  WHERE "id" = p_wire_attempt_id AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  IF v_wire."id" IS NULL THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_NOT_DISPATCHED_DENIED' USING ERRCODE = 'P0001';
  END IF;
  IF v_wire."state" = 'NOT_DISPATCHED' THEN
    RETURN 'REPLAY';
  END IF;
  IF v_wire."state" <> 'ALLOCATED' THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_NOT_DISPATCHED_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  UPDATE "site_build_provider_wire_attempt"
  SET "state" = 'NOT_DISPATCHED',
      "settlement_status" = 'NOT_INCURRED',
      "final_phase" = 'not_dispatched',
      "gateway_id_state" = 'not_observable',
      "upstream_id_state" = 'not_exposed',
      "payload_state" = 'not_read',
      "observed_at" = clock_timestamp()
  WHERE "id" = p_wire_attempt_id;
  RETURN 'FINALIZED';
END
$$;

-- Whatever settlement function a future caller reaches, new v1 model rows are
-- checked against the relational physical-wire facts before leaving RESERVED.
CREATE FUNCTION guard_site_build_provider_spend_settlement_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_attempt_count INTEGER;
  v_physical_wire_count INTEGER;
  v_final_count INTEGER;
BEGIN
  IF NEW."kind" <> 'model' OR NEW."status" = 'RESERVED' THEN
    RETURN NEW;
  END IF;
  SELECT
    count(*),
    count(*) FILTER (WHERE "state" IN ('OBSERVED', 'UNKNOWN')),
    count(*) FILTER (
      WHERE "state" IN ('OBSERVED', 'UNKNOWN', 'NOT_DISPATCHED')
    )
  INTO v_attempt_count, v_physical_wire_count, v_final_count
  FROM "site_build_provider_wire_attempt"
  WHERE "spend_id" = NEW."id" AND "workspace_id" = NEW."workspace_id";
  IF v_attempt_count = 0 THEN
    RETURN NEW;
  END IF;
  -- A positive provider-wire discriminator turns every terminal Spend update
  -- into a Worker-only operation, even when a caller reaches an older generic
  -- settlement function through app_user.
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') THEN
    RAISE EXCEPTION 'provider Spend settlement requires runtime_worker: SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID'
      USING ERRCODE = '42501';
  END IF;
  IF (
    v_physical_wire_count = 0
    AND (NEW."status" <> 'RELEASED'
      OR NEW."cost_basis" <> 'not_incurred'
      OR NEW."budget_charge_microusd" <> 0
      OR NEW."call_count" IS NOT NULL)
  ) OR (
    v_physical_wire_count > 0
    AND (NEW."call_count" IS NULL
      OR v_physical_wire_count <> NEW."call_count")
  ) THEN
    RAISE EXCEPTION 'physical wire observation count exceeds call count';
  END IF;
  IF v_attempt_count <> v_final_count THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_WIRE_OBSERVATION_INCOMPLETE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "site_build_provider_readback_probe"
    WHERE "spend_id" = NEW."id"
    GROUP BY "wire_attempt_id" HAVING count(*) > 2
  ) THEN
    RAISE EXCEPTION 'readback probe count exceeds two';
  END IF;
  IF NEW."error_code" = 'MODEL_SETTLEMENT_UNKNOWN' THEN
    RAISE EXCEPTION 'NEW_MODEL_SETTLEMENT_CODE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."meta"::text ~* '"[^"]*(request[^a-z0-9]*id|nonce|credential|secret|authorization|prompt|response|body|cause|error)[^"]*"[[:space:]]*:' THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_SETTLEMENT_META_FORBIDDEN';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "site_build_provider_wire_attempt"
    WHERE "spend_id" = NEW."id"
      AND "final_phase" IN (
        'gateway_unavailable', 'upstream_ack_unknown',
        'payload_unavailable', 'gateway_log_invalid',
        'database_ack_unknown'
      )
  ) AND NEW."status" <> 'UNKNOWN' THEN
    RAISE EXCEPTION 'SITE_BUILD_PROVIDER_UNKNOWN_STATUS_REQUIRED';
  END IF;
  IF NEW."status" = 'UNKNOWN' AND NEW."error_code" NOT IN (
    'MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE',
    'MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN',
    'MODEL_SETTLEMENT_PAYLOAD_UNAVAILABLE',
    'MODEL_SETTLEMENT_GATEWAY_LOG_MISSING',
    'MODEL_SETTLEMENT_GATEWAY_LOG_UNAVAILABLE',
    'MODEL_SETTLEMENT_LOG_AMBIGUOUS',
    'MODEL_SETTLEMENT_LOG_INVALID',
    'MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN'
  ) THEN
    RAISE EXCEPTION 'NEW_MODEL_SETTLEMENT_CODE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "site_build_provider_spend_settlement_guard"
  BEFORE UPDATE ON "site_build_spend"
  FOR EACH ROW EXECUTE FUNCTION guard_site_build_provider_spend_settlement_v1();

-- The historical bulk close remains valid for legacy/tool reservations only.
-- Positive-discriminator model Spends stay untouched until their individual
-- physical-wire facts are terminal, so a run close cannot manufacture
-- ACK_UNKNOWN or strand the entire terminal transaction behind the v1 guard.
ALTER FUNCTION reconcile_site_build_spend(UUID, UUID)
  RENAME TO reconcile_site_build_spend_legacy_20260904;
REVOKE ALL ON FUNCTION reconcile_site_build_spend_legacy_20260904(UUID, UUID)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay;

CREATE FUNCTION reconcile_site_build_spend(
  p_workspace_id UUID,
  p_build_run_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reserved BIGINT := 0;
  v_count INTEGER := 0;
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  PERFORM 1 FROM "site_build_budget"
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id
  FOR UPDATE;

  SELECT COALESCE(sum(s."reservation_microusd"), 0), count(*)
    INTO v_reserved, v_count
  FROM "site_build_spend" s
  WHERE s."build_run_id" = p_build_run_id
    AND s."workspace_id" = p_workspace_id
    AND s."status" = 'RESERVED'
    AND NOT EXISTS (
      SELECT 1 FROM "site_build_provider_wire_attempt" w
      WHERE w."spend_id" = s."id"
        AND w."workspace_id" = s."workspace_id"
    );

  UPDATE "site_build_spend" s
  SET "status" = 'UNKNOWN',
      "budget_charge_microusd" = s."reservation_microusd",
      "cost_basis" = 'unknown',
      "error_code" = 'ACK_UNKNOWN',
      "settled_at" = clock_timestamp()
  WHERE s."build_run_id" = p_build_run_id
    AND s."workspace_id" = p_workspace_id
    AND s."status" = 'RESERVED'
    AND NOT EXISTS (
      SELECT 1 FROM "site_build_provider_wire_attempt" w
      WHERE w."spend_id" = s."id"
        AND w."workspace_id" = s."workspace_id"
    );

  UPDATE "site_build_budget"
  SET "reserved_microusd" = GREATEST(0, "reserved_microusd" - v_reserved),
      "charged_microusd" = "charged_microusd" + v_reserved,
      "paid_calls_enabled" = CASE
        WHEN "charged_microusd" + v_reserved > "cap_microusd" THEN false
        ELSE "paid_calls_enabled"
      END,
      "disabled_reason" = CASE
        WHEN "charged_microusd" + v_reserved > "cap_microusd" THEN 'budget_exhausted'
        ELSE "disabled_reason"
      END,
      "exhausted_at" = CASE
        WHEN "charged_microusd" + v_reserved > "cap_microusd"
          THEN COALESCE("exhausted_at", clock_timestamp())
        ELSE "exhausted_at"
      END,
      "updated_at" = clock_timestamp()
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION reconcile_site_build_spend(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_site_build_spend(UUID, UUID) TO app_user;

REVOKE ALL ON TABLE
  "site_build_provider_wire_attempt",
  "site_build_provider_wire_receipt",
  "site_build_provider_readback_probe",
  "site_build_provider_readback_probe_observation"
FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay;
GRANT SELECT ON TABLE
  "site_build_provider_wire_attempt",
  "site_build_provider_wire_receipt",
  "site_build_provider_readback_probe",
  "site_build_provider_readback_probe_observation"
TO app_user;

REVOKE ALL ON FUNCTION reserve_site_build_spend(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, TEXT, BIGINT, JSONB)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_site_build_spend(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, TEXT, BIGINT, JSONB)
  TO app_user;

REVOKE ALL ON FUNCTION reserve_site_build_model_spend_v1(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, BIGINT, JSONB, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BIGINT, VARCHAR, VARCHAR, VARCHAR, BIGINT, BIGINT, BIGINT)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;
REVOKE ALL ON FUNCTION allocate_site_build_provider_wire_v1(UUID, UUID, UUID, VARCHAR, UUID, VARCHAR, VARCHAR, VARCHAR)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;
REVOKE ALL ON FUNCTION begin_site_build_provider_wire_v1(UUID, UUID, UUID)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;
REVOKE ALL ON FUNCTION claim_site_build_provider_readback_probe_v1(UUID, UUID, INTEGER)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;
REVOKE ALL ON FUNCTION record_site_build_provider_readback_probe_v1(UUID, UUID, VARCHAR, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;
REVOKE ALL ON FUNCTION record_site_build_provider_wire_receipt_v1(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, INTEGER, BIGINT, INTEGER, INTEGER, BIGINT, VARCHAR, TIMESTAMPTZ)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;
REVOKE ALL ON FUNCTION finalize_site_build_provider_wire_v1(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;
REVOKE ALL ON FUNCTION finalize_site_build_provider_wire_from_receipt_v1(UUID, UUID)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;
REVOKE ALL ON FUNCTION finalize_site_build_provider_wire_not_dispatched_v1(UUID, UUID)
  FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay;

GRANT EXECUTE ON FUNCTION reserve_site_build_model_spend_v1(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, BIGINT, JSONB, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BIGINT, VARCHAR, VARCHAR, VARCHAR, BIGINT, BIGINT, BIGINT)
  TO runtime_worker;
GRANT EXECUTE ON FUNCTION allocate_site_build_provider_wire_v1(UUID, UUID, UUID, VARCHAR, UUID, VARCHAR, VARCHAR, VARCHAR)
  TO runtime_worker;
GRANT EXECUTE ON FUNCTION begin_site_build_provider_wire_v1(UUID, UUID, UUID)
  TO runtime_worker;
GRANT EXECUTE ON FUNCTION claim_site_build_provider_readback_probe_v1(UUID, UUID, INTEGER)
  TO runtime_worker;
GRANT EXECUTE ON FUNCTION record_site_build_provider_readback_probe_v1(UUID, UUID, VARCHAR, INTEGER, TIMESTAMPTZ)
  TO runtime_worker;
GRANT EXECUTE ON FUNCTION record_site_build_provider_wire_receipt_v1(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, INTEGER, BIGINT, INTEGER, INTEGER, BIGINT, VARCHAR, TIMESTAMPTZ)
  TO runtime_worker;
GRANT EXECUTE ON FUNCTION finalize_site_build_provider_wire_v1(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ)
  TO runtime_worker;
GRANT EXECUTE ON FUNCTION finalize_site_build_provider_wire_from_receipt_v1(UUID, UUID)
  TO runtime_worker;
GRANT EXECUTE ON FUNCTION finalize_site_build_provider_wire_not_dispatched_v1(UUID, UUID)
  TO runtime_worker;
