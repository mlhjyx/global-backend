-- Additive Task 4 Domain ACK ledger.
-- This remains transaction-compatible only: callers use the same DB transaction
-- for apply_execution_domain_ack_v1 and their domain mutation. Task 6 authority-
-- bound physical spend/wire remains cutover-blocked.

ALTER TABLE "tool_budget_operation"
  ADD COLUMN IF NOT EXISTS "receipt_usage" JSONB,
  ADD COLUMN IF NOT EXISTS "receipt_cost_basis" VARCHAR(40);

ALTER TABLE "tool_budget_operation"
  ADD CONSTRAINT "tool_budget_operation_receipt_facts_check" CHECK (
    ("receipt_usage" IS NULL AND "receipt_cost_basis" IS NULL)
    OR (
      jsonb_typeof("receipt_usage") = 'object'
      AND "receipt_cost_basis" IN (
        'provider_reported',
        'token_pricing',
        'estimated_upper_bound',
        'not_incurred'
      )
      AND "receipt_usage" ? 'currency'
      AND "receipt_usage" ? 'unit'
      AND "receipt_usage"->>'currency' = 'USD'
      AND "receipt_usage"->>'unit' = 'microusd'
    )
  ) NOT VALID;

CREATE FUNCTION tool_budget_projection_receipt_usage_v1(
  p_result_schema TEXT,
  p_result_json JSONB,
  p_reserved_microusd BIGINT,
  p_charged_microusd BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  cost_basis TEXT;
  maximum_bytes TEXT;
  observed_bytes TEXT;
BEGIN
  IF p_result_schema IS DISTINCT FROM 'google-patents-search/v1' OR p_result_json IS NULL THEN
    RETURN NULL;
  END IF;

  cost_basis := p_result_json #>> '{data,data,data,costFacts,costBasis}';
  maximum_bytes := p_result_json #>> '{data,data,data,costFacts,maximumBytesBilled}';
  observed_bytes := p_result_json #>> '{data,data,data,costFacts,observedBytesBilled}';

  IF cost_basis = 'not_incurred' THEN
    RETURN jsonb_build_object(
      'currency', 'USD',
      'unit', 'microusd',
      'callCount', 0,
      'chargedMicrousd', '0',
      'upperBoundMicrousd', '0'
    );
  END IF;

  IF cost_basis = 'provider_reported' AND observed_bytes IS NOT NULL THEN
    RETURN jsonb_build_object(
      'currency', 'USD',
      'unit', 'microusd',
      'callCount', 1,
      'bytesBilled', observed_bytes,
      'maximumBytesBilled', maximum_bytes,
      'chargedMicrousd', p_charged_microusd::TEXT,
      'upperBoundMicrousd', p_reserved_microusd::TEXT
    );
  END IF;

  IF cost_basis = 'estimated_upper_bound' THEN
    RETURN jsonb_build_object(
      'currency', 'USD',
      'unit', 'microusd',
      'callCount', 1,
      'maximumBytesBilled', maximum_bytes,
      'upperBoundMicrousd', p_reserved_microusd::TEXT
    );
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION tool_budget_projection_receipt_cost_basis_v1(
  p_result_schema TEXT,
  p_result_json JSONB
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_result_schema = 'google-patents-search/v1'
      AND p_result_json #>> '{data,data,data,costFacts,costBasis}' IN (
        'provider_reported',
        'estimated_upper_bound',
        'not_incurred'
      )
    THEN p_result_json #>> '{data,data,data,costFacts,costBasis}'
    ELSE NULL
  END
$$;

CREATE TABLE "execution_domain_ack" (
  "ack_id" CHAR(64) PRIMARY KEY,
  "operation_id" UUID NOT NULL,
  "operation_key" TEXT NOT NULL,
  "authority_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "scope_key" TEXT NOT NULL,
  "consumer" VARCHAR(200) NOT NULL,
  "domain_aggregate_type" VARCHAR(200) NOT NULL,
  "domain_ack_key" VARCHAR(200) NOT NULL,
  "domain_revision" VARCHAR(200) NOT NULL,
  "result_strategy" VARCHAR(40) NOT NULL,
  "result_schema" VARCHAR(100) NOT NULL,
  "result_digest" CHAR(64) NOT NULL,
  "artifact_id" TEXT,
  "usage" JSONB NOT NULL,
  "cost_basis" VARCHAR(40) NOT NULL,
  "ack_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("ack_id"),
  UNIQUE ("operation_id", "consumer", "domain_aggregate_type", "domain_ack_key", "domain_revision"),
  CONSTRAINT "execution_domain_ack_operation_fkey"
    FOREIGN KEY ("scope_key", "operation_id")
    REFERENCES "tool_budget_operation"("scope_key", "id"),
  CONSTRAINT "execution_domain_ack_account_fkey"
    FOREIGN KEY ("scope_key", "account_id")
    REFERENCES "tool_budget_account"("scope_key", "id"),
  CONSTRAINT "execution_domain_ack_authority_fkey"
    FOREIGN KEY ("authority_id")
    REFERENCES "execution_budget_authority"("id"),
  CONSTRAINT "execution_domain_ack_digest_check"
    CHECK ("ack_id" ~ '^[0-9a-f]{64}$' AND "result_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_domain_ack_ack_json_check"
    CHECK (
      jsonb_typeof("ack_json") = 'object'
      AND "ack_json"->>'schemaVersion' = 'domain-ack/v1'
      AND "ack_json"->>'ackId' = "ack_id"
      AND "ack_json"->>'operationId' = "operation_id"::text
      AND "ack_json"->>'operationKey' = "operation_key"
      AND "ack_json"->>'authorityId' = "authority_id"::text
      AND "ack_json"->>'accountId' = "account_id"::text
      AND "ack_json"->>'scopeKey' = "scope_key"
      AND "ack_json"->>'consumer' = "consumer"
      AND "ack_json"->>'domainAggregateType' = "domain_aggregate_type"
      AND "ack_json"->>'domainAckKey' = "domain_ack_key"
      AND "ack_json"->>'domainRevision' = "domain_revision"
      AND "ack_json"->>'resultStrategy' = "result_strategy"
      AND "ack_json"->>'resultSchema' = "result_schema"
      AND "ack_json"->>'resultDigest' = "result_digest"
      AND COALESCE("ack_json"->>'artifactId', '') = COALESCE("artifact_id", '')
      AND "ack_json"->'usage' = "usage"
      AND "ack_json"->>'costBasis' = "cost_basis"
    )
);

ALTER TABLE "execution_domain_ack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_domain_ack" FORCE ROW LEVEL SECURITY;

CREATE POLICY "execution_domain_ack_tenant_isolation" ON "execution_domain_ack"
  USING (
    ("scope_key" = current_workspace_id()::TEXT)
    OR ("scope_key" = 'platform' AND session_user <> 'app_user')
  )
  WITH CHECK (
    ("scope_key" = current_workspace_id()::TEXT)
    OR ("scope_key" = 'platform' AND session_user <> 'app_user')
  );

REVOKE ALL ON TABLE "execution_domain_ack" FROM PUBLIC;
GRANT SELECT ON TABLE "execution_domain_ack" TO app_user;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "execution_domain_ack" FROM app_user;

CREATE FUNCTION apply_execution_domain_ack_v1(p_ack JSONB)
RETURNS TABLE(status TEXT, ack_json JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  expected_keys TEXT[];
  actual_keys TEXT[];
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  existing "execution_domain_ack"%ROWTYPE;
  inserted "execution_domain_ack"%ROWTYPE;
BEGIN
  expected_keys := ARRAY[
    'accountId', 'ackId', 'artifactId', 'authorityId', 'consumer',
    'costBasis', 'domainAckKey', 'domainAggregateType', 'domainRevision',
    'operationId', 'operationKey', 'resultDigest', 'resultSchema',
    'resultStrategy', 'schemaVersion', 'scopeKey', 'usage'
  ];

  IF p_ack IS NULL
    OR jsonb_typeof(p_ack) <> 'object'
    OR p_ack->>'schemaVersion' IS DISTINCT FROM 'domain-ack/v1'
    OR COALESCE(p_ack->>'ackId' !~ '^[0-9a-f]{64}$', true)
    OR COALESCE(p_ack->>'operationId' !~ '^[0-9a-f-]{36}$', true)
    OR COALESCE(p_ack->>'authorityId' !~ '^[0-9a-f-]{36}$', true)
    OR COALESCE(p_ack->>'accountId' !~ '^[0-9a-f-]{36}$', true)
    OR COALESCE(p_ack->>'resultDigest' !~ '^[0-9a-f]{64}$', true)
    OR NOT (p_ack ? 'usage')
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_INVALID';
  END IF;

  SELECT array_agg(key ORDER BY key) INTO actual_keys
  FROM jsonb_object_keys(p_ack) AS key;
  IF actual_keys IS DISTINCT FROM expected_keys THEN
    RAISE EXCEPTION 'DOMAIN_ACK_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        E'\u0000',
        p_ack->>'operationId',
        p_ack->>'consumer',
        p_ack->>'domainAggregateType',
        p_ack->>'domainAckKey',
        p_ack->>'domainRevision'
      ),
      0
    )
  );

  SELECT * INTO operation
  FROM "tool_budget_operation"
  WHERE "id" = (p_ack->>'operationId')::uuid
    AND "scope_key" = p_ack->>'scopeKey'
  FOR UPDATE;

  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "id" = (p_ack->>'accountId')::uuid
    AND "scope_key" = p_ack->>'scopeKey'
  FOR UPDATE;

  IF operation."id" IS NULL
    OR account."id" IS NULL
    OR operation."account_id" IS DISTINCT FROM account."id"
    OR account."authority_id" IS DISTINCT FROM (p_ack->>'authorityId')::uuid
    OR operation."operation_key" IS DISTINCT FROM p_ack->>'operationKey'
    OR NOT (operation."status" = 'SETTLED'::"tool_budget_operation_status")
    OR operation."result_schema" IS DISTINCT FROM p_ack->>'resultSchema'
    OR operation."result_digest" IS DISTINCT FROM p_ack->>'resultDigest'
    OR operation."receipt_usage" IS DISTINCT FROM p_ack->'usage'
    OR operation."receipt_cost_basis" IS DISTINCT FROM p_ack->>'costBasis'
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_LEDGER_MISMATCH';
  END IF;

  SELECT * INTO existing
  FROM "execution_domain_ack"
  WHERE (
      "operation_id" = (p_ack->>'operationId')::uuid
      AND "consumer" = p_ack->>'consumer'
      AND "domain_aggregate_type" = p_ack->>'domainAggregateType'
      AND "domain_ack_key" = p_ack->>'domainAckKey'
      AND "domain_revision" = p_ack->>'domainRevision'
    )
    OR "ack_id" = p_ack->>'ackId'
  FOR UPDATE;

  IF existing."ack_id" IS NOT NULL THEN
    IF existing."ack_json" IS DISTINCT FROM p_ack THEN
      RAISE EXCEPTION 'DOMAIN_ACK_CONFLICT';
    END IF;
    RETURN QUERY SELECT 'REPLAYED', existing."ack_json";
    RETURN;
  END IF;

  INSERT INTO "execution_domain_ack"(
    "ack_id", "operation_id", "operation_key", "authority_id", "account_id",
    "scope_key", "consumer", "domain_aggregate_type", "domain_ack_key",
    "domain_revision", "result_strategy", "result_schema", "result_digest",
    "artifact_id", "usage", "cost_basis", "ack_json"
  )
  VALUES(
    p_ack->>'ackId',
    (p_ack->>'operationId')::uuid,
    p_ack->>'operationKey',
    (p_ack->>'authorityId')::uuid,
    (p_ack->>'accountId')::uuid,
    p_ack->>'scopeKey',
    p_ack->>'consumer',
    p_ack->>'domainAggregateType',
    p_ack->>'domainAckKey',
    p_ack->>'domainRevision',
    p_ack->>'resultStrategy',
    p_ack->>'resultSchema',
    p_ack->>'resultDigest',
    NULLIF(p_ack->>'artifactId', ''),
    p_ack->'usage',
    p_ack->>'costBasis',
    p_ack
  )
  RETURNING * INTO inserted;

  RETURN QUERY SELECT 'APPLIED', inserted."ack_json";
END;
$$;

CREATE FUNCTION reserve_tool_budget_with_receipt_v1(
  p_scope_key TEXT, p_account_key TEXT, p_operation_key TEXT,
  p_reservation_cents BIGINT
)
RETURNS TABLE(
  kind TEXT, operation_id UUID, reserved_cents BIGINT, remaining_cents BIGINT,
  status TEXT, result_json JSONB, operation_key TEXT, account_id UUID,
  authority_id UUID, charged_cents BIGINT, observed_cents BIGINT,
  result_schema_version TEXT, result_schema TEXT, result_digest TEXT,
  receipt_usage JSONB, receipt_cost_basis TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
BEGIN
  SELECT * INTO base
  FROM reserve_tool_budget(
    p_scope_key, p_account_key, p_operation_key, p_reservation_cents
  );

  IF base.operation_id IS NULL THEN
    RETURN QUERY SELECT base.kind, base.operation_id, base.reserved_cents,
      base.remaining_cents, base.status, base.result_json, NULL::TEXT,
      NULL::UUID, NULL::UUID, NULL::BIGINT, NULL::BIGINT, NULL::TEXT,
      NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO operation
  FROM "tool_budget_operation"
  WHERE "id" = base.operation_id AND "scope_key" = p_scope_key
  FOR UPDATE;

  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "id" = operation."account_id" AND "scope_key" = p_scope_key
  FOR UPDATE;

  RETURN QUERY SELECT base.kind, base.operation_id, base.reserved_cents,
    base.remaining_cents, base.status, base.result_json,
    operation."operation_key", account."id", account."authority_id",
    operation."charged_cents", operation."observed_cents",
    operation."result_schema_version", operation."result_schema",
    operation."result_digest", operation."receipt_usage",
    operation."receipt_cost_basis";
END;
$$;

CREATE FUNCTION settle_tool_budget_with_receipt_v1(
  p_scope_key TEXT, p_operation_id UUID, p_observed_cents BIGINT,
  p_result_schema_version TEXT, p_result_schema TEXT, p_result_digest TEXT,
  p_result_json JSONB
)
RETURNS TABLE(
  charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN,
  status TEXT, replay BOOLEAN, reserved_cents BIGINT, operation_id UUID,
  operation_key TEXT, account_id UUID, authority_id UUID,
  result_schema_version TEXT, result_schema TEXT, result_digest TEXT,
  result_json JSONB, receipt_usage JSONB, receipt_cost_basis TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  explicit_usage JSONB;
  explicit_cost_basis TEXT;
BEGIN
  SELECT * INTO base
  FROM settle_tool_budget(
    p_scope_key, p_operation_id, p_observed_cents, p_result_schema_version,
    p_result_schema, p_result_digest, p_result_json
  );

  SELECT * INTO operation
  FROM "tool_budget_operation"
  WHERE "id" = p_operation_id AND "scope_key" = p_scope_key
  FOR UPDATE;

  explicit_usage := tool_budget_projection_receipt_usage_v1(
    operation."result_schema",
    operation."result_json",
    operation."reserved_cents" * 10000,
    operation."charged_cents" * 10000
  );
  explicit_cost_basis := tool_budget_projection_receipt_cost_basis_v1(
    operation."result_schema",
    operation."result_json"
  );

  IF explicit_usage IS NOT NULL AND explicit_cost_basis IS NOT NULL THEN
    UPDATE "tool_budget_operation" target
    SET "receipt_usage" = explicit_usage,
        "receipt_cost_basis" = explicit_cost_basis
    WHERE target."id" = operation."id"
    RETURNING * INTO operation;
  END IF;

  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "id" = operation."account_id" AND "scope_key" = p_scope_key
  FOR UPDATE;

  RETURN QUERY SELECT base.charged_cents, base.observed_cents,
    base.cap_variance, base.status, base.replay, operation."reserved_cents",
    operation."id", operation."operation_key", account."id",
    account."authority_id", operation."result_schema_version",
    operation."result_schema", operation."result_digest",
    operation."result_json", operation."receipt_usage",
    operation."receipt_cost_basis";
END;
$$;

CREATE FUNCTION reserve_tool_budget_microusd_with_receipt_v1(
  p_scope_key TEXT, p_account_key TEXT, p_operation_key TEXT,
  p_reservation_microusd BIGINT
)
RETURNS TABLE(
  kind TEXT, operation_id UUID, reserved_microusd BIGINT, remaining_microusd BIGINT,
  status TEXT, result_json JSONB, operation_key TEXT, account_id UUID,
  authority_id UUID, charged_microusd BIGINT, observed_microusd BIGINT,
  result_schema_version TEXT, result_schema TEXT, result_digest TEXT,
  receipt_usage JSONB, receipt_cost_basis TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
BEGIN
  SELECT * INTO base
  FROM reserve_tool_budget_microusd_v1(
    p_scope_key, p_account_key, p_operation_key, p_reservation_microusd
  );

  IF base.operation_id IS NULL THEN
    RETURN QUERY SELECT base.kind, base.operation_id, base.reserved_microusd,
      base.remaining_microusd, base.status, base.result_json, NULL::TEXT,
      NULL::UUID, NULL::UUID, NULL::BIGINT, NULL::BIGINT, NULL::TEXT,
      NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO operation
  FROM "tool_budget_operation"
  WHERE "id" = base.operation_id AND "scope_key" = p_scope_key
  FOR UPDATE;

  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "id" = operation."account_id" AND "scope_key" = p_scope_key
  FOR UPDATE;

  RETURN QUERY SELECT base.kind, base.operation_id, base.reserved_microusd,
    base.remaining_microusd, base.status, base.result_json,
    operation."operation_key", account."id", account."authority_id",
    operation."charged_microusd", operation."observed_microusd",
    operation."result_schema_version", operation."result_schema",
    operation."result_digest", operation."receipt_usage",
    operation."receipt_cost_basis";
END;
$$;

CREATE FUNCTION settle_tool_budget_microusd_with_receipt_v1(
  p_scope_key TEXT, p_operation_id UUID, p_observed_microusd BIGINT,
  p_result_schema_version TEXT, p_result_schema TEXT, p_result_digest TEXT,
  p_result_json JSONB
)
RETURNS TABLE(
  charged_microusd BIGINT, observed_microusd BIGINT, cap_variance BOOLEAN,
  status TEXT, replay BOOLEAN, reserved_microusd BIGINT, operation_id UUID,
  operation_key TEXT, account_id UUID, authority_id UUID,
  result_schema_version TEXT, result_schema TEXT, result_digest TEXT,
  result_json JSONB, receipt_usage JSONB, receipt_cost_basis TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  explicit_usage JSONB;
  explicit_cost_basis TEXT;
BEGIN
  SELECT * INTO base
  FROM settle_tool_budget_microusd_v1(
    p_scope_key, p_operation_id, p_observed_microusd, p_result_schema_version,
    p_result_schema, p_result_digest, p_result_json
  );

  SELECT * INTO operation
  FROM "tool_budget_operation"
  WHERE "id" = p_operation_id AND "scope_key" = p_scope_key
  FOR UPDATE;

  explicit_usage := tool_budget_projection_receipt_usage_v1(
    operation."result_schema",
    operation."result_json",
    operation."reserved_microusd",
    operation."charged_microusd"
  );
  explicit_cost_basis := tool_budget_projection_receipt_cost_basis_v1(
    operation."result_schema",
    operation."result_json"
  );

  IF explicit_usage IS NOT NULL AND explicit_cost_basis IS NOT NULL THEN
    UPDATE "tool_budget_operation" target
    SET "receipt_usage" = explicit_usage,
        "receipt_cost_basis" = explicit_cost_basis
    WHERE target."id" = operation."id"
    RETURNING * INTO operation;
  END IF;

  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "id" = operation."account_id" AND "scope_key" = p_scope_key
  FOR UPDATE;

  RETURN QUERY SELECT base.charged_microusd, base.observed_microusd,
    base.cap_variance, base.status, base.replay, operation."reserved_microusd",
    operation."id", operation."operation_key", account."id",
    account."authority_id", operation."result_schema_version",
    operation."result_schema", operation."result_digest",
    operation."result_json", operation."receipt_usage",
    operation."receipt_cost_basis";
END;
$$;
