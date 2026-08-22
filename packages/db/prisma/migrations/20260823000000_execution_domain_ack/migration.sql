-- Additive Task 4 receipt facts and Domain ACK ledger.
-- Task 6 authority-bound physical execution remains cutover-blocked. Every
-- function here is additive and requires the existing exact app/platform
-- principal admission before it can read or write an execution ledger row.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

ALTER TABLE "tool_budget_operation"
  ADD COLUMN "receipt_usage" JSONB,
  ADD COLUMN "receipt_cost_basis" VARCHAR(40);

CREATE FUNCTION execution_receipt_facts_valid_v1(
  p_result_schema TEXT,
  p_usage JSONB,
  p_cost_basis TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  call_count NUMERIC := 0;
  input_tokens NUMERIC := 0;
  output_tokens NUMERIC := 0;
  charged NUMERIC;
  upper_bound NUMERIC;
  bytes_processed NUMERIC;
  bytes_billed NUMERIC;
  maximum_bytes NUMERIC;
BEGIN
  IF p_result_schema IS NULL
    OR p_result_schema !~ '^[a-z][a-z0-9_-]{1,79}/v[1-9][0-9]{0,3}$'
    OR p_usage IS NULL
    OR jsonb_typeof(p_usage) IS DISTINCT FROM 'object'
    OR p_cost_basis NOT IN (
      'provider_reported', 'token_pricing',
      'estimated_upper_bound', 'not_incurred'
    )
    OR p_usage->>'currency' IS DISTINCT FROM 'USD'
    OR p_usage->>'unit' IS DISTINCT FROM 'microusd'
    OR (p_usage - ARRAY[
      'currency', 'unit', 'callCount', 'inputTokens', 'outputTokens',
      'bytesProcessed', 'bytesBilled', 'maximumBytesBilled',
      'chargedMicrousd', 'upperBoundMicrousd'
    ]) <> '{}'::jsonb
  THEN
    RETURN false;
  END IF;

  IF p_usage ? 'callCount' THEN
    IF jsonb_typeof(p_usage->'callCount') <> 'number'
      OR p_usage->>'callCount' !~ '^(0|[1-9][0-9]{0,9})$'
    THEN RETURN false; END IF;
    call_count := (p_usage->>'callCount')::NUMERIC;
  END IF;
  IF p_usage ? 'inputTokens' THEN
    IF jsonb_typeof(p_usage->'inputTokens') <> 'number'
      OR p_usage->>'inputTokens' !~ '^(0|[1-9][0-9]{0,15})$'
    THEN RETURN false; END IF;
    input_tokens := (p_usage->>'inputTokens')::NUMERIC;
  END IF;
  IF p_usage ? 'outputTokens' THEN
    IF jsonb_typeof(p_usage->'outputTokens') <> 'number'
      OR p_usage->>'outputTokens' !~ '^(0|[1-9][0-9]{0,15})$'
    THEN RETURN false; END IF;
    output_tokens := (p_usage->>'outputTokens')::NUMERIC;
  END IF;

  IF p_usage ? 'chargedMicrousd' THEN
    IF jsonb_typeof(p_usage->'chargedMicrousd') <> 'string'
      OR p_usage->>'chargedMicrousd' !~ '^(0|[1-9][0-9]{0,39})$'
    THEN RETURN false; END IF;
    charged := (p_usage->>'chargedMicrousd')::NUMERIC;
  END IF;
  IF p_usage ? 'upperBoundMicrousd' THEN
    IF jsonb_typeof(p_usage->'upperBoundMicrousd') <> 'string'
      OR p_usage->>'upperBoundMicrousd' !~ '^(0|[1-9][0-9]{0,39})$'
    THEN RETURN false; END IF;
    upper_bound := (p_usage->>'upperBoundMicrousd')::NUMERIC;
  END IF;
  IF charged IS NOT NULL AND upper_bound IS NOT NULL AND charged > upper_bound THEN
    RETURN false;
  END IF;

  IF p_usage ? 'bytesProcessed' THEN
    IF jsonb_typeof(p_usage->'bytesProcessed') <> 'string'
      OR p_usage->>'bytesProcessed' !~ '^(0|[1-9][0-9]{0,39})$'
    THEN RETURN false; END IF;
    bytes_processed := (p_usage->>'bytesProcessed')::NUMERIC;
  END IF;
  IF p_usage ? 'bytesBilled' THEN
    IF jsonb_typeof(p_usage->'bytesBilled') <> 'string'
      OR p_usage->>'bytesBilled' !~ '^(0|[1-9][0-9]{0,39})$'
    THEN RETURN false; END IF;
    bytes_billed := (p_usage->>'bytesBilled')::NUMERIC;
  END IF;
  IF p_usage ? 'maximumBytesBilled' THEN
    IF jsonb_typeof(p_usage->'maximumBytesBilled') <> 'string'
      OR p_usage->>'maximumBytesBilled' !~ '^(0|[1-9][0-9]{0,39})$'
    THEN RETURN false; END IF;
    maximum_bytes := (p_usage->>'maximumBytesBilled')::NUMERIC;
  END IF;
  IF (bytes_processed IS NOT NULL OR bytes_billed IS NOT NULL OR maximum_bytes IS NOT NULL)
    AND (
      maximum_bytes IS NULL
      OR bytes_processed > maximum_bytes
      OR bytes_billed > maximum_bytes
    )
  THEN
    RETURN false;
  END IF;

  IF p_cost_basis = 'not_incurred' THEN
    RETURN call_count = 0
      AND input_tokens = 0
      AND output_tokens = 0
      AND bytes_processed IS NULL
      AND bytes_billed IS NULL
      AND maximum_bytes IS NULL
      AND COALESCE(charged, 0) = 0
      AND COALESCE(upper_bound, 0) = 0;
  END IF;
  IF p_cost_basis = 'provider_reported' THEN
    RETURN charged IS NOT NULL
      AND call_count >= 1
      AND (
        p_result_schema <> 'google-patents-search/v1'
        OR bytes_processed IS NOT NULL
        OR bytes_billed IS NOT NULL
      );
  END IF;
  IF p_cost_basis = 'token_pricing' THEN
    RETURN input_tokens + output_tokens >= 1
      AND charged IS NOT NULL
      AND upper_bound IS NOT NULL
      AND call_count >= 1;
  END IF;
  RETURN upper_bound IS NOT NULL
    AND call_count >= 1
    AND bytes_processed IS NULL
    AND bytes_billed IS NULL
    AND (
      p_result_schema <> 'google-patents-search/v1'
      OR maximum_bytes IS NOT NULL
    );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

ALTER TABLE "tool_budget_operation"
  ADD CONSTRAINT "tool_budget_operation_receipt_facts_check" CHECK (
    (
      "receipt_usage" IS NULL
      AND "receipt_cost_basis" IS NULL
    )
    OR (
      "result_schema" IS NOT NULL
      AND execution_receipt_facts_valid_v1(
        "result_schema", "receipt_usage", "receipt_cost_basis"
      )
    )
  ) NOT VALID;

ALTER TABLE "tool_budget_operation"
  VALIDATE CONSTRAINT "tool_budget_operation_receipt_facts_check";

CREATE TABLE "execution_domain_ack" (
  "ack_id" CHAR(64) PRIMARY KEY,
  "operation_id" UUID NOT NULL,
  "operation_key" VARCHAR(200) NOT NULL,
  "authority_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "scope_key" VARCHAR(200) NOT NULL,
  "consumer" VARCHAR(200) NOT NULL,
  "domain_aggregate_type" VARCHAR(200) NOT NULL,
  "domain_ack_key" CHAR(64) NOT NULL,
  "domain_revision" CHAR(64) NOT NULL,
  "result_strategy" VARCHAR(40) NOT NULL,
  "result_schema" VARCHAR(100) NOT NULL,
  "result_digest" CHAR(64) NOT NULL,
  "artifact_id" TEXT,
  "usage" JSONB NOT NULL,
  "cost_basis" VARCHAR(40) NOT NULL,
  "ack_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    "operation_id", "consumer", "domain_aggregate_type",
    "domain_ack_key", "domain_revision"
  ),
  CONSTRAINT "execution_domain_ack_operation_fkey"
    FOREIGN KEY ("scope_key", "operation_id")
    REFERENCES "tool_budget_operation"("scope_key", "id"),
  CONSTRAINT "execution_domain_ack_account_fkey"
    FOREIGN KEY ("scope_key", "account_id")
    REFERENCES "tool_budget_account"("scope_key", "id"),
  CONSTRAINT "execution_domain_ack_authority_fkey"
    FOREIGN KEY ("scope_key", "authority_id")
    REFERENCES "execution_budget_authority"("scope_key", "id"),
  CONSTRAINT "execution_domain_ack_shape_check" CHECK (
    "ack_id" ~ '^[0-9a-f]{64}$'
    AND "result_digest" ~ '^[0-9a-f]{64}$'
    AND "domain_ack_key" ~ '^[0-9a-f]{64}$'
    AND "domain_revision" ~ '^[0-9a-f]{64}$'
    AND "result_strategy" IN ('typed_projection', 'artifact_reference')
    AND (
      ("result_strategy" = 'typed_projection' AND "artifact_id" IS NULL)
      OR (
        "result_strategy" = 'artifact_reference'
        AND char_length("artifact_id") BETWEEN 1 AND 200
      )
    )
    AND execution_receipt_facts_valid_v1(
      "result_schema", "usage", "cost_basis"
    )
  ),
  CONSTRAINT "execution_domain_ack_ack_json_check" CHECK (
    jsonb_typeof("ack_json") = 'object'
    AND "ack_json" ?& ARRAY[
      'accountId', 'ackId', 'artifactId', 'authorityId', 'consumer',
      'costBasis', 'domainAckKey', 'domainAggregateType', 'domainRevision',
      'operationId', 'operationKey', 'resultDigest', 'resultSchema',
      'resultStrategy', 'schemaVersion', 'scopeKey', 'usage'
    ]
    AND (
      "ack_json" - ARRAY[
        'accountId', 'ackId', 'artifactId', 'authorityId', 'consumer',
        'costBasis', 'domainAckKey', 'domainAggregateType', 'domainRevision',
        'operationId', 'operationKey', 'resultDigest', 'resultSchema',
        'resultStrategy', 'schemaVersion', 'scopeKey', 'usage'
      ]
    ) = '{}'::jsonb
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
    AND "ack_json"->'artifactId' = COALESCE(
      to_jsonb("artifact_id"), 'null'::jsonb
    )
    AND "ack_json"->'usage' = "usage"
    AND "ack_json"->>'costBasis' = "cost_basis"
  )
);

ALTER TABLE "execution_domain_ack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_domain_ack" FORCE ROW LEVEL SECURITY;

CREATE POLICY "execution_domain_ack_tenant_isolation" ON "execution_domain_ack"
  USING (
    (
      "scope_key" <> 'platform'
      AND session_user = 'app_user'
      AND current_setting('role', true) = 'none'
      AND "scope_key" = current_workspace_id()::text
    )
    OR (
      "scope_key" = 'platform'
      AND current_setting('role', true) = 'none'
      AND pg_has_role(
        session_user, 'execution_budget_platform_writer', 'member'
      )
    )
  );

REVOKE ALL ON TABLE "execution_domain_ack" FROM PUBLIC, app_user,
  execution_budget_platform_writer;
GRANT SELECT ON TABLE "execution_domain_ack"
  TO app_user, execution_budget_platform_writer;

CREATE FUNCTION assert_execution_domain_ack_scope_v1(p_scope_key TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_scope_key IS NOT DISTINCT FROM 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS NULL
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
END
$$;

CREATE FUNCTION execution_receipt_store_facts_v1(
  p_scope_key TEXT,
  p_operation_id UUID,
  p_receipt_usage JSONB,
  p_receipt_cost_basis TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
BEGIN
  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR UPDATE;
  IF operation."id" IS NULL
    OR operation."status" IS DISTINCT FROM 'SETTLED'
    OR operation."result_schema" IS NULL
    OR NOT execution_receipt_facts_valid_v1(
      operation."result_schema", p_receipt_usage, p_receipt_cost_basis
    )
  THEN
    RAISE EXCEPTION 'DURABLE_EXECUTION_RECEIPT_FACTS_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF operation."receipt_usage" IS NOT NULL
    OR operation."receipt_cost_basis" IS NOT NULL
  THEN
    IF operation."receipt_usage" IS DISTINCT FROM p_receipt_usage
      OR operation."receipt_cost_basis" IS DISTINCT FROM p_receipt_cost_basis
    THEN
      RAISE EXCEPTION 'DURABLE_EXECUTION_RECEIPT_FACTS_CONFLICT'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  UPDATE "tool_budget_operation" target
  SET "receipt_usage" = p_receipt_usage,
      "receipt_cost_basis" = p_receipt_cost_basis
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id;
END
$$;

CREATE FUNCTION apply_execution_domain_ack_v1(
  p_scope_key TEXT,
  p_operation_id UUID,
  p_consumer TEXT,
  p_domain_aggregate_type TEXT,
  p_domain_ack_key TEXT,
  p_domain_revision TEXT
)
RETURNS TABLE(status TEXT, ack_json JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  existing "execution_domain_ack"%ROWTYPE;
  inserted "execution_domain_ack"%ROWTYPE;
  result_strategy TEXT;
  artifact_id TEXT;
  derived_ack_id TEXT;
  derived_ack JSONB;
BEGIN
  PERFORM assert_execution_domain_ack_scope_v1(p_scope_key);
  IF p_operation_id IS NULL
    OR p_consumer !~ '^[A-Za-z0-9:._/-]{1,200}$'
    OR p_domain_aggregate_type !~ '^[A-Za-z0-9:._/-]{1,200}$'
    OR p_domain_ack_key !~ '^[0-9a-f]{64}$'
    OR p_domain_revision !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_INVALID' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        chr(31), p_operation_id::text, p_consumer,
        p_domain_aggregate_type, p_domain_ack_key, p_domain_revision
      ),
      0
    )
  );

  SELECT target.* INTO operation
  FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = p_operation_id
  FOR UPDATE;
  SELECT target.* INTO account
  FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key
    AND target."id" = operation."account_id"
  FOR UPDATE;

  result_strategy := CASE operation."result_schema_version"
    WHEN 'generic-operation-projection/v1' THEN 'typed_projection'
    WHEN 'generic-operation-artifact-ref/v1' THEN 'artifact_reference'
    ELSE NULL
  END;
  artifact_id := CASE result_strategy
    WHEN 'artifact_reference' THEN operation."result_json"->>'artifactId'
    ELSE NULL
  END;

  IF operation."id" IS NULL
    OR account."id" IS NULL
    OR account."authority_id" IS NULL
    OR operation."account_id" IS DISTINCT FROM account."id"
    OR operation."status" IS DISTINCT FROM 'SETTLED'
    OR operation."result_schema" IS NULL
    OR operation."result_digest" IS NULL
    OR result_strategy IS NULL
    OR (
      result_strategy = 'artifact_reference'
      AND COALESCE(artifact_id !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true)
    )
    OR NOT execution_receipt_facts_valid_v1(
      operation."result_schema", operation."receipt_usage",
      operation."receipt_cost_basis"
    )
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_LEDGER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  derived_ack_id := encode(
    public.digest(
      convert_to(
        generic_operation_canonical_json(jsonb_build_object(
          'operationId', operation."id"::text,
          'consumer', p_consumer,
          'domainAggregateType', p_domain_aggregate_type,
          'domainAckKey', p_domain_ack_key,
          'domainRevision', p_domain_revision,
          'resultDigest', operation."result_digest"
        )),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  derived_ack := jsonb_build_object(
    'schemaVersion', 'domain-ack/v1',
    'ackId', derived_ack_id,
    'operationId', operation."id"::text,
    'operationKey', operation."operation_key",
    'authorityId', account."authority_id"::text,
    'accountId', account."id"::text,
    'scopeKey', operation."scope_key",
    'consumer', p_consumer,
    'domainAggregateType', p_domain_aggregate_type,
    'domainAckKey', p_domain_ack_key,
    'domainRevision', p_domain_revision,
    'resultStrategy', result_strategy,
    'resultSchema', operation."result_schema",
    'resultDigest', operation."result_digest",
    'artifactId', artifact_id,
    'usage', operation."receipt_usage",
    'costBasis', operation."receipt_cost_basis"
  );

  SELECT target.* INTO existing
  FROM "execution_domain_ack" target
  WHERE (
      target."operation_id" = operation."id"
      AND target."consumer" = p_consumer
      AND target."domain_aggregate_type" = p_domain_aggregate_type
      AND target."domain_ack_key" = p_domain_ack_key
      AND target."domain_revision" = p_domain_revision
    )
    OR target."ack_id" = derived_ack_id
  FOR UPDATE;
  IF existing."ack_id" IS NOT NULL THEN
    IF existing."ack_json" IS DISTINCT FROM derived_ack THEN
      RAISE EXCEPTION 'DOMAIN_ACK_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT 'REPLAYED', existing."ack_json";
    RETURN;
  END IF;

  INSERT INTO "execution_domain_ack"(
    "ack_id", "operation_id", "operation_key", "authority_id", "account_id",
    "scope_key", "consumer", "domain_aggregate_type", "domain_ack_key",
    "domain_revision", "result_strategy", "result_schema", "result_digest",
    "artifact_id", "usage", "cost_basis", "ack_json"
  ) VALUES (
    derived_ack_id, operation."id", operation."operation_key",
    account."authority_id", account."id", operation."scope_key", p_consumer,
    p_domain_aggregate_type, p_domain_ack_key, p_domain_revision,
    result_strategy, operation."result_schema", operation."result_digest",
    artifact_id, operation."receipt_usage", operation."receipt_cost_basis",
    derived_ack
  )
  RETURNING * INTO inserted;
  RETURN QUERY SELECT 'APPLIED', inserted."ack_json";
END
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
BEGIN
  PERFORM assert_execution_domain_ack_scope_v1(p_scope_key);
  SELECT * INTO base FROM reserve_tool_budget(
    p_scope_key, p_account_key, p_operation_key, p_reservation_cents
  );
  IF base.operation_id IS NULL THEN
    RETURN QUERY SELECT base.kind, base.operation_id, base.reserved_cents,
      base.remaining_cents, base.status, base.result_json, NULL::TEXT,
      NULL::UUID, NULL::UUID, NULL::BIGINT, NULL::BIGINT, NULL::TEXT,
      NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::TEXT;
    RETURN;
  END IF;
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key AND target."id" = base.operation_id
  FOR UPDATE;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key AND target."id" = operation."account_id"
  FOR UPDATE;
  RETURN QUERY SELECT base.kind, base.operation_id, base.reserved_cents,
    base.remaining_cents, base.status, base.result_json,
    operation."operation_key", account."id", account."authority_id",
    operation."charged_cents", operation."observed_cents",
    operation."result_schema_version", operation."result_schema",
    operation."result_digest", operation."receipt_usage",
    operation."receipt_cost_basis";
END
$$;

CREATE FUNCTION settle_tool_budget_with_receipt_v1(
  p_scope_key TEXT, p_operation_id UUID, p_observed_cents BIGINT,
  p_result_schema_version TEXT, p_result_schema TEXT, p_result_digest TEXT,
  p_result_json JSONB, p_receipt_usage JSONB, p_receipt_cost_basis TEXT
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
BEGIN
  PERFORM assert_execution_domain_ack_scope_v1(p_scope_key);
  SELECT * INTO base FROM settle_tool_budget(
    p_scope_key, p_operation_id, p_observed_cents, p_result_schema_version,
    p_result_schema, p_result_digest, p_result_json
  );
  IF p_result_json IS NOT NULL THEN
    PERFORM execution_receipt_store_facts_v1(
      p_scope_key, p_operation_id, p_receipt_usage, p_receipt_cost_basis
    );
  ELSIF p_receipt_usage IS NOT NULL OR p_receipt_cost_basis IS NOT NULL THEN
    RAISE EXCEPTION 'DURABLE_EXECUTION_RECEIPT_FACTS_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key AND target."id" = p_operation_id
  FOR UPDATE;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key AND target."id" = operation."account_id"
  FOR UPDATE;
  RETURN QUERY SELECT base.charged_cents, base.observed_cents,
    base.cap_variance, base.status, base.replay, operation."reserved_cents",
    operation."id", operation."operation_key", account."id",
    account."authority_id", operation."result_schema_version",
    operation."result_schema", operation."result_digest",
    operation."result_json", operation."receipt_usage",
    operation."receipt_cost_basis";
END
$$;

CREATE FUNCTION reserve_tool_budget_microusd_with_receipt_v1(
  p_scope_key TEXT, p_account_key TEXT, p_operation_key TEXT,
  p_reservation_microusd BIGINT
)
RETURNS TABLE(
  kind TEXT, operation_id UUID, reserved_microusd BIGINT,
  remaining_microusd BIGINT, status TEXT, result_json JSONB,
  operation_key TEXT, account_id UUID, authority_id UUID,
  charged_microusd BIGINT, observed_microusd BIGINT,
  result_schema_version TEXT, result_schema TEXT, result_digest TEXT,
  receipt_usage JSONB, receipt_cost_basis TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
BEGIN
  PERFORM assert_execution_domain_ack_scope_v1(p_scope_key);
  SELECT * INTO base FROM reserve_tool_budget_microusd_v1(
    p_scope_key, p_account_key, p_operation_key, p_reservation_microusd
  );
  IF base.operation_id IS NULL THEN
    RETURN QUERY SELECT base.kind, base.operation_id,
      base.reserved_microusd, base.remaining_microusd, base.status,
      base.result_json, NULL::TEXT, NULL::UUID, NULL::UUID,
      NULL::BIGINT, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::JSONB, NULL::TEXT;
    RETURN;
  END IF;
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key AND target."id" = base.operation_id
  FOR UPDATE;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key AND target."id" = operation."account_id"
  FOR UPDATE;
  RETURN QUERY SELECT base.kind, base.operation_id,
    base.reserved_microusd, base.remaining_microusd, base.status,
    base.result_json, operation."operation_key", account."id",
    account."authority_id", operation."charged_microusd",
    operation."observed_microusd", operation."result_schema_version",
    operation."result_schema", operation."result_digest",
    operation."receipt_usage", operation."receipt_cost_basis";
END
$$;

CREATE FUNCTION settle_tool_budget_microusd_with_receipt_v1(
  p_scope_key TEXT, p_operation_id UUID, p_observed_microusd BIGINT,
  p_result_schema_version TEXT, p_result_schema TEXT, p_result_digest TEXT,
  p_result_json JSONB, p_receipt_usage JSONB, p_receipt_cost_basis TEXT
)
RETURNS TABLE(
  charged_microusd BIGINT, observed_microusd BIGINT,
  cap_variance BOOLEAN, status TEXT, replay BOOLEAN,
  reserved_microusd BIGINT, operation_id UUID, operation_key TEXT,
  account_id UUID, authority_id UUID, result_schema_version TEXT,
  result_schema TEXT, result_digest TEXT, result_json JSONB,
  receipt_usage JSONB, receipt_cost_basis TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
BEGIN
  PERFORM assert_execution_domain_ack_scope_v1(p_scope_key);
  SELECT * INTO base FROM settle_tool_budget_microusd_v1(
    p_scope_key, p_operation_id, p_observed_microusd,
    p_result_schema_version, p_result_schema, p_result_digest, p_result_json
  );
  IF p_result_json IS NOT NULL THEN
    PERFORM execution_receipt_store_facts_v1(
      p_scope_key, p_operation_id, p_receipt_usage, p_receipt_cost_basis
    );
  ELSIF p_receipt_usage IS NOT NULL OR p_receipt_cost_basis IS NOT NULL THEN
    RAISE EXCEPTION 'DURABLE_EXECUTION_RECEIPT_FACTS_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key AND target."id" = p_operation_id
  FOR UPDATE;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key AND target."id" = operation."account_id"
  FOR UPDATE;
  RETURN QUERY SELECT base.charged_microusd, base.observed_microusd,
    base.cap_variance, base.status, base.replay,
    operation."reserved_microusd", operation."id",
    operation."operation_key", account."id", account."authority_id",
    operation."result_schema_version", operation."result_schema",
    operation."result_digest", operation."result_json",
    operation."receipt_usage", operation."receipt_cost_basis";
END
$$;

CREATE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v1(
  p_scope_key TEXT, p_operation_id UUID, p_observed_cents BIGINT,
  p_manifest JSONB, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN, p_receipt_usage JSONB,
  p_receipt_cost_basis TEXT
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
BEGIN
  PERFORM assert_execution_domain_ack_scope_v1(p_scope_key);
  SELECT * INTO base FROM settle_tool_budget_artifact_manifest_v3(
    p_scope_key, p_operation_id, p_observed_cents, p_manifest,
    p_expected_http_status, p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
  PERFORM execution_receipt_store_facts_v1(
    p_scope_key, p_operation_id, p_receipt_usage, p_receipt_cost_basis
  );
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key" = p_scope_key AND target."id" = p_operation_id
  FOR UPDATE;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key AND target."id" = operation."account_id"
  FOR UPDATE;
  RETURN QUERY SELECT base.charged_cents, base.observed_cents,
    base.cap_variance, base.status, base.replay, operation."reserved_cents",
    operation."id", operation."operation_key", account."id",
    account."authority_id", operation."result_schema_version",
    operation."result_schema", operation."result_digest",
    operation."result_json", operation."receipt_usage",
    operation."receipt_cost_basis";
END
$$;

REVOKE ALL ON FUNCTION
  execution_receipt_facts_valid_v1(TEXT, JSONB, TEXT),
  assert_execution_domain_ack_scope_v1(TEXT),
  execution_receipt_store_facts_v1(TEXT, UUID, JSONB, TEXT),
  apply_execution_domain_ack_v1(TEXT, UUID, TEXT, TEXT, TEXT, TEXT),
  reserve_tool_budget_with_receipt_v1(TEXT, TEXT, TEXT, BIGINT),
  settle_tool_budget_with_receipt_v1(
    TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT
  ),
  reserve_tool_budget_microusd_with_receipt_v1(TEXT, TEXT, TEXT, BIGINT),
  settle_tool_budget_microusd_with_receipt_v1(
    TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT
  ),
  settle_tool_budget_artifact_manifest_with_receipt_v1(
    TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT,
    BOOLEAN, JSONB, TEXT
  )
FROM PUBLIC, app_user, execution_budget_platform_writer;

GRANT EXECUTE ON FUNCTION
  apply_execution_domain_ack_v1(TEXT, UUID, TEXT, TEXT, TEXT, TEXT),
  reserve_tool_budget_with_receipt_v1(TEXT, TEXT, TEXT, BIGINT),
  settle_tool_budget_with_receipt_v1(
    TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT
  ),
  reserve_tool_budget_microusd_with_receipt_v1(TEXT, TEXT, TEXT, BIGINT),
  settle_tool_budget_microusd_with_receipt_v1(
    TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT
  ),
  settle_tool_budget_artifact_manifest_with_receipt_v1(
    TEXT, UUID, BIGINT, JSONB, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT,
    BOOLEAN, JSONB, TEXT
  )
TO app_user, execution_budget_platform_writer;

COMMIT;
