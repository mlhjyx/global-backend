-- Additive Task 4 Domain ACK ledger.
-- This is transaction-compatible only: callers must invoke the function and the
-- domain mutation in the same transaction so rollback removes the ACK insert.

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
  "result_strategy" VARCHAR(40) NOT NULL,
  "result_schema" VARCHAR(100) NOT NULL,
  "result_digest" CHAR(64) NOT NULL,
  "artifact_id" TEXT,
  "usage" JSONB NOT NULL,
  "cost_basis" VARCHAR(40) NOT NULL,
  "ack_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("operation_id"),
  UNIQUE ("ack_id"),
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
      AND "ack_json"->>'resultStrategy' = "result_strategy"
      AND "ack_json"->>'resultSchema' = "result_schema"
      AND "ack_json"->>'resultDigest' = "result_digest"
      AND "ack_json"->'usage' = "usage"
      AND "ack_json"->>'costBasis' = "cost_basis"
    )
);

CREATE FUNCTION apply_execution_domain_ack_v1(p_ack JSONB)
RETURNS TABLE(status TEXT, ack_json JSONB)
LANGUAGE plpgsql
AS $$
DECLARE
  existing "execution_domain_ack"%ROWTYPE;
  inserted "execution_domain_ack"%ROWTYPE;
BEGIN
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

  SELECT * INTO existing
  FROM "execution_domain_ack"
  WHERE "operation_id" = (p_ack->>'operationId')::uuid
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
    "result_strategy", "result_schema", "result_digest", "artifact_id",
    "usage", "cost_basis", "ack_json"
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
  result_schema_version TEXT, result_schema TEXT, result_digest TEXT
)
LANGUAGE plpgsql
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
      NULL::TEXT, NULL::TEXT;
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
    operation."result_digest";
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
  result_json JSONB
)
LANGUAGE plpgsql
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
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

  SELECT * INTO account
  FROM "tool_budget_account"
  WHERE "id" = operation."account_id" AND "scope_key" = p_scope_key
  FOR UPDATE;

  RETURN QUERY SELECT base.charged_cents, base.observed_cents,
    base.cap_variance, base.status, base.replay, operation."reserved_cents",
    operation."id", operation."operation_key", account."id",
    account."authority_id", operation."result_schema_version",
    operation."result_schema", operation."result_digest",
    operation."result_json";
END;
$$;
