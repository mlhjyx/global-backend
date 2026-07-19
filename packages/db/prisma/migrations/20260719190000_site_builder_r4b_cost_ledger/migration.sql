-- R4-B-min durable paid-call accounting. Additive and forward-only: historical
-- BuildRun/BrandProfile rows stay valid and no cost/provenance is fabricated.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

LOCK TABLE "site_build_run" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile" IN SHARE ROW EXCLUSIVE MODE;

CREATE UNIQUE INDEX "site_build_run_id_workspace_site_key"
  ON "site_build_run"("id", "workspace_id", "site_id");

CREATE TABLE "site_build_budget" (
  "build_run_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "cap_microusd" BIGINT NOT NULL,
  "reserved_microusd" BIGINT NOT NULL DEFAULT 0,
  "charged_microusd" BIGINT NOT NULL DEFAULT 0,
  "paid_calls_enabled" BOOLEAN NOT NULL DEFAULT true,
  "disabled_reason" TEXT,
  "exhausted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "site_build_budget_pkey" PRIMARY KEY ("build_run_id"),
  CONSTRAINT "site_build_budget_amounts_check" CHECK (
    "cap_microusd" >= 0
    AND "reserved_microusd" >= 0
    AND "charged_microusd" >= 0
  ),
  CONSTRAINT "site_build_budget_disabled_reason_check" CHECK (
    ("paid_calls_enabled" AND "disabled_reason" IS NULL)
    OR (NOT "paid_calls_enabled" AND char_length("disabled_reason") BETWEEN 1 AND 80)
  )
);

CREATE UNIQUE INDEX "site_build_budget_scope_key"
  ON "site_build_budget"("build_run_id", "workspace_id", "site_id");
CREATE INDEX "site_build_budget_workspace_run_idx"
  ON "site_build_budget"("workspace_id", "build_run_id");

ALTER TABLE "site_build_budget"
  ADD CONSTRAINT "site_build_budget_run_scope_fkey"
    FOREIGN KEY ("build_run_id", "workspace_id", "site_id")
    REFERENCES "site_build_run"("id", "workspace_id", "site_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "site_build_task_attempt" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "task_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CLAIMED',
  "attempt_no" INTEGER NOT NULL DEFAULT 1,
  "fence_token" UUID NOT NULL,
  "lease_until" TIMESTAMP(3) NOT NULL,
  "input_hash" VARCHAR(64),
  "input_json" JSONB,
  "output_json" JSONB,
  "result_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "site_build_task_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_task_attempt_run_task_key" UNIQUE ("build_run_id", "task_id"),
  CONSTRAINT "site_build_task_attempt_task_check" CHECK (char_length("task_id") BETWEEN 1 AND 160),
  CONSTRAINT "site_build_task_attempt_status_check" CHECK (
    "status" IN ('CLAIMED', 'INPUT_READY', 'MODEL_SUCCEEDED', 'SUCCEEDED', 'FAILED', 'CANCELLED')
  ),
  CONSTRAINT "site_build_task_attempt_attempt_check" CHECK ("attempt_no" >= 1),
  CONSTRAINT "site_build_task_attempt_input_hash_check" CHECK (
    "input_hash" IS NULL OR "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "site_build_task_attempt_input_pair_check" CHECK (
    ("input_hash" IS NULL AND "input_json" IS NULL)
    OR ("input_hash" IS NOT NULL AND jsonb_typeof("input_json") = 'object')
  ),
  CONSTRAINT "site_build_task_attempt_output_check" CHECK (
    "output_json" IS NULL OR jsonb_typeof("output_json") = 'object'
  ),
  CONSTRAINT "site_build_task_attempt_result_check" CHECK (
    "result_json" IS NULL OR jsonb_typeof("result_json") = 'object'
  )
);

CREATE UNIQUE INDEX "site_build_task_attempt_scope_key"
  ON "site_build_task_attempt"("id", "workspace_id", "site_id");
CREATE INDEX "site_build_task_attempt_workspace_run_idx"
  ON "site_build_task_attempt"("workspace_id", "build_run_id");

ALTER TABLE "site_build_task_attempt"
  ADD CONSTRAINT "site_build_task_attempt_run_scope_fkey"
    FOREIGN KEY ("build_run_id", "workspace_id", "site_id")
    REFERENCES "site_build_run"("id", "workspace_id", "site_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "brand_profile"
  ADD COLUMN "task_attempt_id" UUID;

CREATE UNIQUE INDEX "brand_profile_task_attempt_id_key"
  ON "brand_profile"("task_attempt_id");
CREATE UNIQUE INDEX "brand_profile_task_attempt_scope_key"
  ON "brand_profile"("task_attempt_id", "workspace_id", "site_id");

ALTER TABLE "brand_profile"
  ADD CONSTRAINT "brand_profile_task_attempt_scope_fkey"
    FOREIGN KEY ("task_attempt_id", "workspace_id", "site_id")
    REFERENCES "site_build_task_attempt"("id", "workspace_id", "site_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "site_build_spend" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "task_attempt_id" UUID,
  "operation_key" VARCHAR(64) NOT NULL,
  "kind" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "reservation_microusd" BIGINT NOT NULL,
  "budget_charge_microusd" BIGINT NOT NULL DEFAULT 0,
  "reported_cost_microusd" BIGINT,
  "calculated_cost_microusd" BIGINT,
  "estimated_cost_microusd" BIGINT,
  "cost_basis" TEXT,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "call_count" INTEGER,
  "result_json" JSONB,
  "meta" JSONB,
  "error_code" TEXT,
  "fence_token" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMP(3),

  CONSTRAINT "site_build_spend_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_build_spend_run_operation_key" UNIQUE ("build_run_id", "operation_key"),
  CONSTRAINT "site_build_spend_operation_key_check" CHECK ("operation_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_build_spend_kind_check" CHECK ("kind" IN ('model', 'tool')),
  CONSTRAINT "site_build_spend_task_check" CHECK (char_length("task_id") BETWEEN 1 AND 160),
  CONSTRAINT "site_build_spend_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 240),
  CONSTRAINT "site_build_spend_status_check" CHECK (
    "status" IN ('RESERVED', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'RELEASED')
  ),
  CONSTRAINT "site_build_spend_amounts_check" CHECK (
    "reservation_microusd" >= 0
    AND "budget_charge_microusd" >= 0
    AND ("reported_cost_microusd" IS NULL OR "reported_cost_microusd" >= 0)
    AND ("calculated_cost_microusd" IS NULL OR "calculated_cost_microusd" >= 0)
    AND ("estimated_cost_microusd" IS NULL OR "estimated_cost_microusd" >= 0)
  ),
  CONSTRAINT "site_build_spend_usage_check" CHECK (
    ("input_tokens" IS NULL OR "input_tokens" >= 0)
    AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
    AND ("call_count" IS NULL OR "call_count" >= 1)
  ),
  CONSTRAINT "site_build_spend_cost_basis_check" CHECK (
    ("status" = 'RESERVED' AND "cost_basis" IS NULL)
    OR ("status" <> 'RESERVED' AND "cost_basis" IN (
      'provider_reported', 'token_pricing', 'tool_reported',
      'legacy_estimate', 'unknown', 'not_incurred'
    ))
  ),
  CONSTRAINT "site_build_spend_cost_truth_check" CHECK (
    ("cost_basis" IN ('provider_reported', 'tool_reported')
      AND "reported_cost_microusd" IS NOT NULL
      AND "calculated_cost_microusd" IS NULL
      AND "estimated_cost_microusd" IS NULL)
    OR ("cost_basis" = 'token_pricing'
      AND "reported_cost_microusd" IS NULL
      AND "calculated_cost_microusd" IS NOT NULL
      AND "estimated_cost_microusd" IS NULL)
    OR ("cost_basis" = 'legacy_estimate'
      AND "reported_cost_microusd" IS NULL
      AND "calculated_cost_microusd" IS NULL
      AND "estimated_cost_microusd" IS NOT NULL)
    OR ("cost_basis" IN ('unknown', 'not_incurred')
      AND "reported_cost_microusd" IS NULL
      AND "calculated_cost_microusd" IS NULL
      AND "estimated_cost_microusd" IS NULL)
    OR ("status" = 'RESERVED' AND "cost_basis" IS NULL
      AND "reported_cost_microusd" IS NULL
      AND "calculated_cost_microusd" IS NULL
      AND "estimated_cost_microusd" IS NULL)
  ),
  CONSTRAINT "site_build_spend_result_check" CHECK (
    "result_json" IS NULL OR jsonb_typeof("result_json") = 'object'
  ),
  CONSTRAINT "site_build_spend_meta_check" CHECK (
    "meta" IS NULL OR jsonb_typeof("meta") = 'object'
  ),
  CONSTRAINT "site_build_spend_fence_pair_check" CHECK (
    ("task_attempt_id" IS NULL AND "fence_token" IS NULL)
    OR ("task_attempt_id" IS NOT NULL AND "fence_token" IS NOT NULL)
  )
);

CREATE INDEX "site_build_spend_workspace_run_kind_status_idx"
  ON "site_build_spend"("workspace_id", "build_run_id", "kind", "status");
CREATE INDEX "site_build_spend_task_attempt_idx"
  ON "site_build_spend"("task_attempt_id");

ALTER TABLE "site_build_spend"
  ADD CONSTRAINT "site_build_spend_run_scope_fkey"
    FOREIGN KEY ("build_run_id", "workspace_id", "site_id")
    REFERENCES "site_build_run"("id", "workspace_id", "site_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_build_spend_attempt_scope_fkey"
    FOREIGN KEY ("task_attempt_id", "workspace_id", "site_id")
    REFERENCES "site_build_task_attempt"("id", "workspace_id", "site_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

-- Atomic reserve. Existing RESERVED means the acknowledgement boundary is
-- ambiguous; consume its reservation as UNKNOWN and never execute it again.
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
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_budget "site_build_budget"%ROWTYPE;
  v_spend "site_build_spend"%ROWTYPE;
  v_attempt "site_build_task_attempt"%ROWTYPE;
  v_run_status TEXT;
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  IF p_reservation_microusd < 0 OR p_operation_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid paid-call reservation';
  END IF;

  SELECT b.* INTO v_budget
  FROM "site_build_budget" b
  WHERE b."build_run_id" = p_build_run_id
    AND b."workspace_id" = p_workspace_id
  FOR UPDATE;

  IF v_budget."build_run_id" IS NULL THEN
    RETURN QUERY SELECT 'DENIED_NO_BUDGET', NULL::UUID, NULL::TEXT, NULL::JSONB, NULL::JSONB, NULL::TEXT;
    RETURN;
  END IF;

  SELECT r."status" INTO v_run_status
  FROM "site_build_run" r
  WHERE r."id" = v_budget."build_run_id"
    AND r."workspace_id" = v_budget."workspace_id"
    AND r."site_id" = v_budget."site_id";

  IF p_task_attempt_id IS NOT NULL THEN
    SELECT * INTO v_attempt
    FROM "site_build_task_attempt"
    WHERE "id" = p_task_attempt_id
      AND "workspace_id" = p_workspace_id
      AND "build_run_id" = p_build_run_id
    FOR UPDATE;
    IF v_attempt."id" IS NULL
      OR v_attempt."fence_token" IS DISTINCT FROM p_fence_token
      OR v_attempt."lease_until" <= clock_timestamp()
      OR v_attempt."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
    THEN
      RETURN QUERY SELECT 'DENIED_STALE_FENCE', NULL::UUID, NULL::TEXT, NULL::JSONB, NULL::JSONB, NULL::TEXT;
      RETURN;
    END IF;
  ELSIF p_fence_token IS NOT NULL THEN
    RAISE EXCEPTION 'fence token requires task attempt';
  END IF;

  SELECT * INTO v_spend
  FROM "site_build_spend"
  WHERE "build_run_id" = p_build_run_id
    AND "operation_key" = p_operation_key
  FOR UPDATE;

  IF v_spend."id" IS NOT NULL THEN
    IF v_spend."status" = 'RESERVED' THEN
      UPDATE "site_build_spend"
      SET "status" = 'UNKNOWN',
          "budget_charge_microusd" = "reservation_microusd",
          "cost_basis" = 'unknown',
          "error_code" = 'ACK_UNKNOWN',
          "settled_at" = clock_timestamp()
      WHERE "id" = v_spend."id"
      RETURNING * INTO v_spend;

      UPDATE "site_build_budget"
      SET "reserved_microusd" = GREATEST(0, "reserved_microusd" - v_spend."reservation_microusd"),
          "charged_microusd" = "charged_microusd" + v_spend."reservation_microusd",
          "paid_calls_enabled" = CASE
            WHEN "charged_microusd" + v_spend."reservation_microusd" > "cap_microusd" THEN false
            ELSE "paid_calls_enabled"
          END,
          "disabled_reason" = CASE
            WHEN "charged_microusd" + v_spend."reservation_microusd" > "cap_microusd" THEN 'budget_exhausted'
            ELSE "disabled_reason"
          END,
          "exhausted_at" = CASE
            WHEN "charged_microusd" + v_spend."reservation_microusd" > "cap_microusd" THEN COALESCE("exhausted_at", clock_timestamp())
            ELSE "exhausted_at"
          END,
          "updated_at" = clock_timestamp()
      WHERE "build_run_id" = p_build_run_id;
      RETURN QUERY SELECT 'UNKNOWN', v_spend."id", v_spend."status", NULL::JSONB, v_spend."meta", v_spend."error_code";
      RETURN;
    END IF;
    RETURN QUERY SELECT 'REPLAY', v_spend."id", v_spend."status", v_spend."result_json", v_spend."meta", v_spend."error_code";
    RETURN;
  END IF;

  IF v_run_status <> 'running' OR NOT v_budget."paid_calls_enabled" THEN
    RETURN QUERY SELECT 'DENIED_STATE', NULL::UUID, NULL::TEXT, NULL::JSONB, NULL::JSONB, NULL::TEXT;
    RETURN;
  END IF;

  IF p_reservation_microusd >
    v_budget."cap_microusd" - v_budget."reserved_microusd" - v_budget."charged_microusd"
  THEN
    UPDATE "site_build_budget"
    SET "paid_calls_enabled" = false,
        "disabled_reason" = 'budget_exhausted',
        "exhausted_at" = COALESCE("exhausted_at", clock_timestamp()),
        "updated_at" = clock_timestamp()
    WHERE "build_run_id" = p_build_run_id;
    RETURN QUERY SELECT 'DENIED_BUDGET_EXHAUSTED', NULL::UUID, NULL::TEXT, NULL::JSONB, NULL::JSONB, NULL::TEXT;
    RETURN;
  END IF;

  INSERT INTO "site_build_spend" (
    "id", "workspace_id", "site_id", "build_run_id", "task_attempt_id",
    "operation_key", "kind", "task_id", "subject", "status",
    "reservation_microusd", "meta", "fence_token"
  ) VALUES (
    gen_random_uuid(), p_workspace_id, v_budget."site_id", p_build_run_id, p_task_attempt_id,
    p_operation_key, p_kind, p_task_id, p_subject, 'RESERVED',
    p_reservation_microusd, p_meta, p_fence_token
  ) RETURNING * INTO v_spend;

  UPDATE "site_build_budget"
  SET "reserved_microusd" = "reserved_microusd" + p_reservation_microusd,
      "updated_at" = clock_timestamp()
  WHERE "build_run_id" = p_build_run_id;

  RETURN QUERY SELECT 'EXECUTE', v_spend."id", v_spend."status", NULL::JSONB, v_spend."meta", NULL::TEXT;
END
$$;

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
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_budget "site_build_budget"%ROWTYPE;
  v_spend "site_build_spend"%ROWTYPE;
BEGIN
  IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'workspace scope mismatch';
  END IF;
  IF p_status NOT IN ('SUCCEEDED', 'FAILED', 'RELEASED') OR p_budget_charge_microusd < 0 THEN
    RAISE EXCEPTION 'invalid paid-call settlement';
  END IF;

  SELECT * INTO v_budget
  FROM "site_build_budget"
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id
  FOR UPDATE;
  SELECT * INTO v_spend
  FROM "site_build_spend"
  WHERE "build_run_id" = p_build_run_id
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
      "budget_charge_microusd" = p_budget_charge_microusd,
      "reported_cost_microusd" = p_reported_cost_microusd,
      "calculated_cost_microusd" = p_calculated_cost_microusd,
      "estimated_cost_microusd" = p_estimated_cost_microusd,
      "cost_basis" = p_cost_basis,
      "input_tokens" = p_input_tokens,
      "output_tokens" = p_output_tokens,
      "call_count" = p_call_count,
      "result_json" = p_result_json,
      "meta" = p_meta,
      "error_code" = p_error_code,
      "settled_at" = clock_timestamp()
  WHERE "id" = v_spend."id";

  UPDATE "site_build_budget"
  SET "reserved_microusd" = GREATEST(0, "reserved_microusd" - v_spend."reservation_microusd"),
      "charged_microusd" = "charged_microusd" + p_budget_charge_microusd,
      "paid_calls_enabled" = CASE
        WHEN "charged_microusd" + p_budget_charge_microusd > "cap_microusd" THEN false
        ELSE "paid_calls_enabled"
      END,
      "disabled_reason" = CASE
        WHEN "charged_microusd" + p_budget_charge_microusd > "cap_microusd" THEN 'budget_exhausted'
        ELSE "disabled_reason"
      END,
      "exhausted_at" = CASE
        WHEN "charged_microusd" + p_budget_charge_microusd > "cap_microusd" THEN COALESCE("exhausted_at", clock_timestamp())
        ELSE "exhausted_at"
      END,
      "updated_at" = clock_timestamp()
  WHERE "build_run_id" = p_build_run_id;
  RETURN 'SETTLED';
END
$$;

CREATE FUNCTION reconcile_site_build_spend(
  p_workspace_id UUID,
  p_build_run_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
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

  SELECT COALESCE(sum("reservation_microusd"), 0), count(*)
    INTO v_reserved, v_count
  FROM "site_build_spend"
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id
    AND "status" = 'RESERVED';

  UPDATE "site_build_spend"
  SET "status" = 'UNKNOWN',
      "budget_charge_microusd" = "reservation_microusd",
      "cost_basis" = 'unknown',
      "error_code" = 'ACK_UNKNOWN',
      "settled_at" = clock_timestamp()
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id
    AND "status" = 'RESERVED';

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
        WHEN "charged_microusd" + v_reserved > "cap_microusd" THEN COALESCE("exhausted_at", clock_timestamp())
        ELSE "exhausted_at"
      END,
      "updated_at" = clock_timestamp()
  WHERE "build_run_id" = p_build_run_id
    AND "workspace_id" = p_workspace_id;
  RETURN v_count;
END
$$;

ALTER TABLE "site_build_budget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_budget" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_build_budget_tenant_isolation"
  ON "site_build_budget"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "site_build_spend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_spend" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_build_spend_tenant_isolation"
  ON "site_build_spend"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "site_build_task_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_build_task_attempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_build_task_attempt_tenant_isolation"
  ON "site_build_task_attempt"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "site_build_budget" FROM PUBLIC;
REVOKE ALL ON TABLE "site_build_spend" FROM PUBLIC;
REVOKE ALL ON TABLE "site_build_task_attempt" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE "site_build_budget" TO app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "site_build_spend" TO app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "site_build_task_attempt" TO app_user;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_build_budget" FROM app_user;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_build_spend" FROM app_user;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_build_task_attempt" FROM app_user;

REVOKE ALL ON FUNCTION reserve_site_build_spend(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, TEXT, BIGINT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_site_build_spend(UUID, UUID, VARCHAR, UUID, TEXT, BIGINT, TEXT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, JSONB, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_site_build_spend(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_site_build_spend(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, TEXT, BIGINT, JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION settle_site_build_spend(UUID, UUID, VARCHAR, UUID, TEXT, BIGINT, TEXT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, JSONB, JSONB, TEXT) TO app_user;
GRANT EXECUTE ON FUNCTION reconcile_site_build_spend(UUID, UUID) TO app_user;
