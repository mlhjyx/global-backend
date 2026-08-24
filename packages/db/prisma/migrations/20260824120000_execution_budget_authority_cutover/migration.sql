-- Task 6 atomic authority-only cutover. Historical closed/unbound accounts are
-- retained for audit reads; every account that can execute is authority-bound.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "tool_budget_account" account
    WHERE account."authority_id" IS NULL
      AND (account."ref_count" <> 0 OR account."closed_at" IS NULL)
  ) THEN
    RAISE EXCEPTION 'TOOL_BUDGET_ACTIVE_UNAUTHORIZED_ACCOUNTS'
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

ALTER TABLE "tool_budget_account"
  DROP CONSTRAINT IF EXISTS "tool_budget_account_authority_pair_check";
ALTER TABLE "tool_budget_account"
  ADD CONSTRAINT "tool_budget_account_authority_cutover_check" CHECK (
    (
      "authority_id" IS NOT NULL
      AND "authorized_cap_microusd" IS NOT NULL
      AND "authorized_cap_microusd" > 0
      AND "cap_cents" = 0
      AND "reserved_cents" = 0
      AND "charged_cents" = 0
    ) OR (
      "authority_id" IS NULL
      AND "authorized_cap_microusd" IS NULL
      AND "ref_count" = 0
      AND "closed_at" IS NOT NULL
    )
  ) NOT VALID;
ALTER TABLE "tool_budget_account"
  VALIDATE CONSTRAINT "tool_budget_account_authority_cutover_check";

-- Shared binding helper for settle/release/status. Expiry is deliberately not
-- rechecked here: work validly reserved before expiry must remain settleable.
CREATE OR REPLACE FUNCTION tool_budget_unbound_cap_microusd_v1(
  p_account_id UUID,
  p_scope_key TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE account "tool_budget_account"%ROWTYPE;
BEGIN
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target.* INTO account
  FROM "tool_budget_account" target
  WHERE target."id" = p_account_id AND target."scope_key" = p_scope_key
  FOR SHARE;
  IF account."id" IS NULL THEN
    RAISE EXCEPTION 'TOOL_BUDGET_ACCOUNT_UNAVAILABLE';
  END IF;
  IF account."authority_id" IS NULL THEN
    RAISE EXCEPTION 'TOOL_BUDGET_HISTORICAL_TERMINAL'
      USING ERRCODE = 'P0001';
  END IF;
  IF account."authorized_cap_microusd" IS NULL
    OR account."authorized_cap_microusd" < 1
    OR account."cap_cents" <> 0
    OR account."reserved_cents" <> 0
    OR account."charged_cents" <> 0
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN account."authorized_cap_microusd";
END
$$;

-- Reserve is the spend boundary and therefore re-attests expiry/revocation.
CREATE OR REPLACE FUNCTION reserve_tool_budget_microusd_v1(
  p_scope_key TEXT,
  p_account_key TEXT,
  p_operation_key TEXT,
  p_reservation_microusd BIGINT
)
RETURNS TABLE(
  kind TEXT, operation_id UUID, reserved_microusd BIGINT,
  remaining_microusd BIGINT, status TEXT, result_json JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account "tool_budget_account"%ROWTYPE;
  operation "tool_budget_operation"%ROWTYPE;
  cap_microusd BIGINT;
  remaining BIGINT;
BEGIN
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  IF char_length(p_operation_key) NOT BETWEEN 1 AND 200
    OR p_reservation_microusd IS NULL OR p_reservation_microusd < 0
  THEN RAISE EXCEPTION 'invalid tool budget microusd reservation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||p_account_key,0));
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key" = p_scope_key
    AND target."account_key" = p_account_key
  FOR UPDATE;
  IF account."id" IS NULL OR account."ref_count" = 0 THEN
    IF account."id" IS NOT NULL AND account."authority_id" IS NULL THEN
      RAISE EXCEPTION 'TOOL_BUDGET_HISTORICAL_TERMINAL'
        USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'TOOL_BUDGET_ACCOUNT_UNAVAILABLE';
  END IF;
  cap_microusd := tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  IF account."exhausted" THEN
    RETURN QUERY SELECT 'DENIED', NULL::UUID, 0::BIGINT,
      GREATEST(0::BIGINT, cap_microusd-account."reserved_microusd"-account."charged_microusd"),
      'EXHAUSTED', NULL::JSONB;
    RETURN;
  END IF;
  PERFORM * FROM attest_authorized_tool_budget_v1(
    p_scope_key, account."authority_id", p_account_key
  );
  IF account."charged_microusd" > cap_microusd
    OR account."reserved_microusd" > cap_microusd-account."charged_microusd"
  THEN RAISE EXCEPTION 'TOOL_BUDGET_MICROUSD_INVARIANT'; END IF;
  remaining := cap_microusd-account."reserved_microusd"-account."charged_microusd";
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."account_id" = account."id"
    AND target."generation" = account."generation"
    AND target."operation_key" = p_operation_key
  FOR UPDATE;
  IF operation."id" IS NOT NULL THEN
    IF operation."amount_unit" <> 'microusd' THEN
      RAISE EXCEPTION 'TOOL_BUDGET_AMOUNT_UNIT_CONFLICT';
    END IF;
    RETURN QUERY SELECT 'REPLAY', operation."id", operation."reserved_microusd",
      remaining, operation."status"::text, operation."result_json";
    RETURN;
  END IF;
  IF p_reservation_microusd > remaining THEN
    UPDATE "tool_budget_account" target
    SET "exhausted" = true, "updated_at" = clock_timestamp()
    WHERE target."id" = account."id";
    RETURN QUERY SELECT 'DENIED', NULL::UUID, 0::BIGINT, remaining,
      'EXHAUSTED', NULL::JSONB;
    RETURN;
  END IF;
  INSERT INTO "tool_budget_operation"(
    "scope_key", "account_id", "generation", "operation_key",
    "amount_unit", "reserved_cents", "reserved_microusd"
  ) VALUES (
    p_scope_key, account."id", account."generation", p_operation_key,
    'microusd', 0, p_reservation_microusd
  ) RETURNING * INTO operation;
  UPDATE "tool_budget_account" target
  SET "reserved_microusd" = target."reserved_microusd"+p_reservation_microusd,
      "updated_at" = clock_timestamp()
  WHERE target."id" = account."id" RETURNING target.* INTO account;
  RETURN QUERY SELECT 'EXECUTE', operation."id", operation."reserved_microusd",
    cap_microusd-account."reserved_microusd"-account."charged_microusd",
    operation."status"::text, NULL::JSONB;
END
$$;

CREATE OR REPLACE FUNCTION settle_tool_budget_microusd_v1(
  p_scope_key TEXT, p_operation_id UUID, p_observed_microusd BIGINT,
  p_result_schema_version TEXT, p_result_schema TEXT, p_result_digest TEXT,
  p_result_json JSONB
)
RETURNS TABLE(
  charged_microusd BIGINT, observed_microusd BIGINT,
  cap_variance BOOLEAN, status TEXT, replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account "tool_budget_account"%ROWTYPE;
  operation "tool_budget_operation"%ROWTYPE;
  charge BIGINT;
  lock_account_key TEXT;
BEGIN
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_observed_microusd IS NULL OR p_observed_microusd < 0 THEN
    RAISE EXCEPTION 'invalid tool budget microusd settlement';
  END IF;
  IF NOT (
    (p_result_json IS NULL AND p_result_schema_version IS NULL
      AND p_result_schema IS NULL AND p_result_digest IS NULL)
    OR
    (p_result_json IS NOT NULL AND p_result_schema_version IS NOT NULL
      AND p_result_schema IS NOT NULL AND p_result_digest IS NOT NULL)
  ) THEN RAISE EXCEPTION 'GENERIC_OPERATION_PROJECTION_INVALID'; END IF;
  IF p_result_json IS NOT NULL AND (
    jsonb_typeof(p_result_json) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_result_json)) <> 5
    OR p_result_schema_version IS DISTINCT FROM 'generic-operation-projection/v1'
    OR COALESCE(p_result_schema !~ '^[a-z][a-z0-9_-]{1,63}/v[1-9][0-9]{0,3}$',true)
    OR COALESCE(p_result_digest !~ '^[0-9a-f]{64}$',true)
    OR p_result_json->>'schemaVersion' IS DISTINCT FROM p_result_schema_version
    OR p_result_json->>'schema' IS DISTINCT FROM p_result_schema
    OR p_result_json->>'digest' IS DISTINCT FROM p_result_digest
    OR COALESCE(p_result_json->>'kind' NOT IN ('model','tool'),true)
    OR NOT (p_result_json ? 'data')
    OR p_result_digest IS DISTINCT FROM generic_operation_projection_digest(p_result_json)
    OR jsonb_path_exists(
      p_result_json,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(authorization|headers|prompt|rawresponse|token)$" flag "i")'
    )
  ) THEN RAISE EXCEPTION 'GENERIC_OPERATION_PROJECTION_INVALID'; END IF;
  SELECT target."account_key" INTO lock_account_key
  FROM "tool_budget_operation" operation_key_source
  JOIN "tool_budget_account" target ON target."id"=operation_key_source."account_id"
  WHERE operation_key_source."id"=p_operation_id
    AND operation_key_source."scope_key"=p_scope_key;
  IF lock_account_key IS NULL THEN
    RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||lock_account_key,0));
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."id"=p_operation_id AND target."scope_key"=p_scope_key
  FOR UPDATE;
  IF operation."id" IS NULL OR operation."amount_unit" <> 'microusd' THEN
    RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE';
  END IF;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."id"=operation."account_id" AND target."scope_key"=p_scope_key
  FOR UPDATE;
  PERFORM tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  IF operation."status" <> 'RESERVED' THEN
    IF operation."status" <> 'SETTLED'
      OR operation."observed_microusd" IS DISTINCT FROM p_observed_microusd
      OR operation."result_schema_version" IS DISTINCT FROM p_result_schema_version
      OR operation."result_schema" IS DISTINCT FROM p_result_schema
      OR operation."result_digest" IS DISTINCT FROM p_result_digest
      OR operation."result_json" IS DISTINCT FROM p_result_json
    THEN RAISE EXCEPTION 'GENERIC_OPERATION_SETTLEMENT_CONFLICT'; END IF;
    RETURN QUERY SELECT operation."charged_microusd",operation."observed_microusd",
      operation."observed_microusd">operation."reserved_microusd",
      operation."status"::text,true;
    RETURN;
  END IF;
  charge := LEAST(p_observed_microusd,operation."reserved_microusd");
  UPDATE "tool_budget_operation" target SET
    "observed_microusd"=p_observed_microusd,"charged_microusd"=charge,
    "status"='SETTLED',"result_schema_version"=p_result_schema_version,
    "result_schema"=p_result_schema,"result_digest"=p_result_digest,
    "result_json"=p_result_json,"settled_at"=clock_timestamp()
  WHERE target."id"=operation."id" RETURNING target.* INTO operation;
  UPDATE "tool_budget_account" target SET
    "reserved_microusd"=target."reserved_microusd"-operation."reserved_microusd",
    "charged_microusd"=target."charged_microusd"+charge,
    "exhausted"=target."exhausted" OR p_observed_microusd>operation."reserved_microusd",
    "updated_at"=clock_timestamp()
  WHERE target."id"=account."id";
  RETURN QUERY SELECT charge,p_observed_microusd,
    p_observed_microusd>operation."reserved_microusd",
    operation."status"::text,false;
END
$$;

CREATE OR REPLACE FUNCTION release_tool_budget_microusd_v1(
  p_scope_key TEXT, p_operation_id UUID
)
RETURNS TABLE(
  charged_microusd BIGINT, observed_microusd BIGINT,
  cap_variance BOOLEAN, status TEXT, replay BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account "tool_budget_account"%ROWTYPE;
  operation "tool_budget_operation"%ROWTYPE;
  lock_account_key TEXT;
BEGIN
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' USING ERRCODE='P0001'; END IF;
  SELECT target."account_key" INTO lock_account_key
  FROM "tool_budget_operation" operation_key_source
  JOIN "tool_budget_account" target ON target."id"=operation_key_source."account_id"
  WHERE operation_key_source."id"=p_operation_id
    AND operation_key_source."scope_key"=p_scope_key;
  IF lock_account_key IS NULL THEN
    RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||lock_account_key,0));
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."id"=p_operation_id AND target."scope_key"=p_scope_key FOR UPDATE;
  IF operation."id" IS NULL OR operation."amount_unit" <> 'microusd' THEN
    RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE';
  END IF;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."id"=operation."account_id" AND target."scope_key"=p_scope_key FOR UPDATE;
  PERFORM tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  IF operation."status"='RESERVED' THEN
    UPDATE "tool_budget_operation" target SET
      "observed_microusd"=0,"charged_microusd"=0,
      "status"='RELEASED',"settled_at"=clock_timestamp()
    WHERE target."id"=operation."id" RETURNING target.* INTO operation;
    UPDATE "tool_budget_account" target SET
      "reserved_microusd"=target."reserved_microusd"-operation."reserved_microusd",
      "updated_at"=clock_timestamp()
    WHERE target."id"=account."id";
    RETURN QUERY SELECT 0::BIGINT,0::BIGINT,false,operation."status"::text,false;
    RETURN;
  END IF;
  RETURN QUERY SELECT operation."charged_microusd",operation."observed_microusd",
    false,operation."status"::text,true;
END
$$;

CREATE OR REPLACE FUNCTION tool_budget_status_microusd_v1(
  p_scope_key TEXT, p_account_key TEXT
)
RETURNS TABLE(
  remaining_microusd BIGINT, exhausted BOOLEAN,
  ref_count INTEGER, generation INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE account "tool_budget_account"%ROWTYPE; cap_microusd BIGINT;
BEGIN
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||p_account_key,0));
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key AND target."account_key"=p_account_key FOR SHARE;
  IF account."id" IS NULL THEN RETURN; END IF;
  cap_microusd := tool_budget_unbound_cap_microusd_v1(account."id",p_scope_key);
  IF account."charged_microusd">cap_microusd
    OR account."reserved_microusd">cap_microusd-account."charged_microusd"
  THEN RAISE EXCEPTION 'TOOL_BUDGET_MICROUSD_INVARIANT'; END IF;
  RETURN QUERY SELECT cap_microusd-account."reserved_microusd"-account."charged_microusd",
    account."exhausted",account."ref_count",account."generation";
END
$$;

CREATE OR REPLACE FUNCTION close_tool_budget_microusd_v1(
  p_scope_key TEXT, p_account_key TEXT, p_force BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE account "tool_budget_account"%ROWTYPE;
BEGIN
  IF p_scope_key = 'platform' THEN
    PERFORM assert_execution_budget_platform_writer_principal();
  ELSIF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN RAISE EXCEPTION 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||p_account_key,0));
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key AND target."account_key"=p_account_key FOR UPDATE;
  IF account."id" IS NULL THEN RETURN false; END IF;
  PERFORM tool_budget_unbound_cap_microusd_v1(account."id",p_scope_key);
  UPDATE "tool_budget_account" target SET
    "ref_count"=CASE WHEN p_force THEN 0 ELSE GREATEST(0,target."ref_count"-1) END,
    "closed_at"=CASE WHEN p_force OR target."ref_count"<=1 THEN clock_timestamp() ELSE NULL END,
    "updated_at"=clock_timestamp()
  WHERE target."id"=account."id";
  RETURN true;
END
$$;

-- Remove the old caller-authored cap/cents entrypoints.
DROP FUNCTION open_tool_budget(TEXT, TEXT, BIGINT, BOOLEAN);
DROP FUNCTION reserve_tool_budget(TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION settle_tool_budget(TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION release_tool_budget(TEXT, UUID);
DROP FUNCTION tool_budget_status(TEXT, TEXT);
DROP FUNCTION close_tool_budget(TEXT, TEXT, BOOLEAN);

CREATE FUNCTION open_tool_budget(
  p_scope_key TEXT, p_authority_id UUID, p_account_key TEXT,
  p_replay_scope BOOLEAN DEFAULT false
)
RETURNS TABLE(
  account_id UUID, generation INTEGER, authority_id UUID,
  authorized_cap_microusd BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||p_account_key,0));
  RETURN QUERY SELECT * FROM open_authorized_tool_budget_v1(
    p_scope_key, p_authority_id, p_account_key, p_replay_scope
  );
END
$$;

CREATE FUNCTION reserve_tool_budget(
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM reserve_tool_budget_microusd_with_receipt_v1(
    p_scope_key, p_account_key, p_operation_key, p_reservation_microusd
  )
$$;

CREATE FUNCTION settle_tool_budget(
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM settle_tool_budget_microusd_with_receipt_v1(
    p_scope_key, p_operation_id, p_observed_microusd,
    p_result_schema_version, p_result_schema, p_result_digest, p_result_json,
    p_receipt_usage, p_receipt_cost_basis
  )
$$;

CREATE FUNCTION release_tool_budget(p_scope_key TEXT, p_operation_id UUID)
RETURNS TABLE(
  charged_microusd BIGINT, observed_microusd BIGINT,
  cap_variance BOOLEAN, status TEXT, replay BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT * FROM release_tool_budget_microusd_v1(p_scope_key,p_operation_id) $$;

CREATE FUNCTION tool_budget_status(p_scope_key TEXT, p_account_key TEXT)
RETURNS TABLE(
  remaining_microusd BIGINT, exhausted BOOLEAN,
  ref_count INTEGER, generation INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT * FROM tool_budget_status_microusd_v1(p_scope_key,p_account_key) $$;

CREATE FUNCTION close_tool_budget(
  p_scope_key TEXT, p_account_key TEXT, p_force BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT close_tool_budget_microusd_v1(p_scope_key,p_account_key,p_force) $$;

-- Microusd artifact settlement with expected facts, subject index and receipt.
CREATE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v2(
  p_scope_key TEXT, p_operation_id UUID, p_observed_microusd BIGINT,
  p_manifest JSONB, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN, p_receipt_usage JSONB,
  p_receipt_cost_basis TEXT, p_subject_type TEXT, p_subject_id UUID
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
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
  account "tool_budget_account"%ROWTYPE;
  artifact "generic_operation_artifact"%ROWTYPE;
  appended RECORD;
  reference JSONB;
  charge BIGINT;
  replayed BOOLEAN := false;
  privacy_class TEXT := p_manifest->>'privacyClass';
  lock_account_key TEXT;
BEGIN
  PERFORM assert_execution_domain_ack_scope_v1(p_scope_key);
  PERFORM assert_generic_operation_artifact_expected_facts_v1(
    p_manifest->>'resultSchema', p_expected_http_status,
    p_expected_http_ok, p_expected_sanitized_url,
    p_expected_content_hash, p_expected_blocked_code,
    p_expected_robots_blocked
  );
  IF (p_subject_type IS NULL) IS DISTINCT FROM (p_subject_id IS NULL)
    OR (privacy_class = 'PERSONAL_DATA') IS DISTINCT FROM
      (p_subject_type IS NOT NULL AND p_subject_id IS NOT NULL)
    OR (p_subject_type IS NOT NULL AND p_subject_type NOT IN ('contact','company'))
    OR (privacy_class = 'PERSONAL_DATA' AND p_scope_key = 'platform')
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR NOT COALESCE((p_manifest->>'sha256') ~ '^[0-9a-f]{64}$', false)
    OR p_observed_microusd IS NULL OR p_observed_microusd < 0
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT target."account_key" INTO lock_account_key
  FROM "tool_budget_operation" operation_key_source
  JOIN "tool_budget_account" target ON target."id"=operation_key_source."account_id"
  WHERE operation_key_source."id"=p_operation_id
    AND operation_key_source."scope_key"=p_scope_key;
  IF lock_account_key IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||lock_account_key,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-operation:'||p_scope_key||':'||p_operation_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-object:'||(p_manifest->>'sha256'),0));
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key"=p_scope_key AND target."id"=p_operation_id FOR UPDATE;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key AND target."id"=operation."account_id" FOR UPDATE;
  IF operation."id" IS NULL OR operation."amount_unit" <> 'microusd'
    OR account."id" IS NULL OR account."authority_id" IS NULL
    OR operation."generation" IS DISTINCT FROM account."generation"
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  PERFORM assert_generic_operation_artifact_manifest_v2(
    p_scope_key, operation."id", account."authority_id", p_manifest
  );
  reference := jsonb_build_object(
    'schemaVersion','generic-operation-artifact-ref/v1',
    'artifactId',p_manifest->>'artifactId','operationId',p_manifest->>'operationId',
    'resultSchema',p_manifest->>'resultSchema','sha256',p_manifest->>'sha256',
    'sizeBytes',p_manifest->>'sizeBytes','mediaType',p_manifest->>'mediaType',
    'expiresAt',p_manifest->>'expiresAt'
  );
  IF operation."status"='SETTLED' THEN
    IF operation."observed_microusd" IS DISTINCT FROM p_observed_microusd
      OR operation."result_json" IS DISTINCT FROM reference
      OR operation."result_digest" IS DISTINCT FROM p_manifest->>'sha256'
    THEN RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001'; END IF;
    replayed := true;
  ELSE
    IF operation."status" NOT IN ('RESERVED','RESULT_UNKNOWN') THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
    END IF;
    IF operation."status"='RESULT_UNKNOWN' AND (
      operation."expected_artifact" IS NULL
      OR operation."expected_artifact"->'manifest' IS DISTINCT FROM p_manifest
      OR operation."expected_artifact_subject_type" IS DISTINCT FROM p_subject_type
      OR operation."expected_artifact_subject_id" IS DISTINCT FROM p_subject_id
    ) THEN RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001'; END IF;
    SELECT * INTO appended FROM append_generic_operation_artifact_internal_v2(
      p_scope_key,(p_manifest->>'workspaceId')::UUID,
      (p_manifest->>'artifactId')::UUID,account."authority_id",operation."id",
      p_manifest->>'resultSchema',p_manifest->>'objectKey',p_manifest->>'sha256',
      (p_manifest->>'sizeBytes')::BIGINT,p_manifest->>'mediaType',privacy_class,
      p_manifest->>'sourceDigest',(p_manifest->>'createdAt')::TIMESTAMPTZ,
      (p_manifest->>'expiresAt')::TIMESTAMPTZ,p_expected_http_status,
      p_expected_http_ok,p_expected_sanitized_url,p_expected_content_hash,
      p_expected_blocked_code,p_expected_robots_blocked
    );
    IF appended.artifact_id IS NULL THEN
      RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
    END IF;
    IF privacy_class='PERSONAL_DATA' THEN
      PERFORM * FROM bind_workspace_generic_operation_artifact_subject_v1(
        (p_manifest->>'workspaceId')::UUID,(p_manifest->>'artifactId')::UUID,
        p_subject_type,p_subject_id
      );
    END IF;
    charge := LEAST(p_observed_microusd, operation."reserved_microusd");
    UPDATE "tool_budget_operation" target SET
      "observed_microusd"=p_observed_microusd,"charged_microusd"=charge,
      "status"='SETTLED',"result_schema_version"='generic-operation-artifact-ref/v1',
      "result_schema"=p_manifest->>'resultSchema',"result_digest"=p_manifest->>'sha256',
      "result_json"=reference,"expected_http_status"=p_expected_http_status,
      "expected_http_ok"=p_expected_http_ok,"expected_sanitized_url"=p_expected_sanitized_url,
      "expected_content_hash"=p_expected_content_hash,"expected_blocked_code"=p_expected_blocked_code,
      "expected_robots_blocked"=p_expected_robots_blocked,"settled_at"=clock_timestamp()
    WHERE target."scope_key"=p_scope_key AND target."id"=p_operation_id
    RETURNING target.* INTO operation;
    UPDATE "tool_budget_account" target SET
      "reserved_microusd"=target."reserved_microusd"-operation."reserved_microusd",
      "charged_microusd"=target."charged_microusd"+charge,
      "exhausted"=target."exhausted" OR p_observed_microusd>operation."reserved_microusd",
      "updated_at"=clock_timestamp()
    WHERE target."scope_key"=p_scope_key AND target."id"=account."id";
  END IF;
  PERFORM execution_receipt_store_facts_v1(
    p_scope_key,p_operation_id,p_receipt_usage,p_receipt_cost_basis,NOT replayed
  );
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key"=p_scope_key AND target."id"=p_operation_id FOR UPDATE;
  SELECT target.* INTO artifact FROM "generic_operation_artifact" target
  WHERE target."scope_key"=p_scope_key AND target."operation_id"=p_operation_id FOR SHARE;
  IF artifact."id" IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT operation."charged_microusd",operation."observed_microusd",
    operation."observed_microusd">operation."reserved_microusd",
    operation."status"::text,replayed,operation."reserved_microusd",operation."id",
    operation."operation_key"::TEXT,account."id",account."authority_id",
    operation."result_schema_version"::TEXT,operation."result_schema"::TEXT,
    operation."result_digest"::TEXT,operation."result_json",operation."receipt_usage",
    operation."receipt_cost_basis"::TEXT;
END
$$;

-- Microusd-compatible unknown transition preserving Task5 subject binding.
CREATE FUNCTION mark_tool_budget_result_unknown_v5(
  p_scope_key TEXT, p_operation_id UUID, p_expected_manifest JSONB,
  p_expected_http_status SMALLINT, p_expected_http_ok BOOLEAN,
  p_expected_sanitized_url TEXT, p_expected_content_hash TEXT,
  p_expected_blocked_code TEXT, p_expected_robots_blocked BOOLEAN,
  p_subject_type TEXT, p_subject_id UUID
)
RETURNS TABLE(
  reserved_microusd BIGINT, status TEXT, replay BOOLEAN, recoverable BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  base RECORD;
  operation "tool_budget_operation"%ROWTYPE;
  lock_account_key TEXT;
BEGIN
  SELECT target."account_key" INTO lock_account_key
  FROM "tool_budget_operation" operation_key_source
  JOIN "tool_budget_account" target ON target."id"=operation_key_source."account_id"
  WHERE operation_key_source."id"=p_operation_id
    AND operation_key_source."scope_key"=p_scope_key;
  IF lock_account_key IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||lock_account_key,0));
  SELECT * INTO base FROM mark_tool_budget_result_unknown_v4(
    p_scope_key,p_operation_id,p_expected_manifest,p_expected_http_status,
    p_expected_http_ok,p_expected_sanitized_url,p_expected_content_hash,
    p_expected_blocked_code,p_expected_robots_blocked,p_subject_type,p_subject_id
  );
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key"=p_scope_key AND target."id"=p_operation_id FOR SHARE;
  IF operation."amount_unit" <> 'microusd' THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT operation."reserved_microusd",base.status,base.replay,base.recoverable;
END
$$;

-- Final read surface: reject historical cents operations before delegating to
-- the Task 5 subject/tombstone validator. The v4 function remains owner-only
-- because v5 and the artifact service use it internally.
CREATE FUNCTION load_tool_budget_result_unknown_artifact_v5(
  p_scope_key TEXT, p_operation_id UUID, p_authority_id UUID,
  p_subject_type TEXT, p_subject_id UUID
)
RETURNS TABLE(
  expected_manifest JSONB, expected_http_status SMALLINT,
  expected_http_ok BOOLEAN, expected_sanitized_url VARCHAR(2000),
  expected_content_hash CHAR(24), expected_blocked_code VARCHAR(80),
  expected_robots_blocked BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  operation "tool_budget_operation"%ROWTYPE;
  lock_account_key TEXT;
BEGIN
  SELECT target."account_key" INTO lock_account_key
  FROM "tool_budget_operation" operation_key_source
  JOIN "tool_budget_account" target ON target."id"=operation_key_source."account_id"
  WHERE operation_key_source."id"=p_operation_id
    AND operation_key_source."scope_key"=p_scope_key;
  IF lock_account_key IS NULL THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'tool-budget-account:'||p_scope_key||':'||lock_account_key,0));
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."scope_key"=p_scope_key AND target."id"=p_operation_id
  FOR SHARE;
  IF operation."id" IS NULL OR operation."amount_unit" <> 'microusd' THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT * FROM load_tool_budget_result_unknown_artifact_v4(
    p_scope_key,p_operation_id,p_authority_id,p_subject_type,p_subject_id
  );
END
$$;

REVOKE ALL ON FUNCTION
  open_authorized_tool_budget_v1(TEXT,UUID,TEXT,BOOLEAN),
  reserve_tool_budget_with_receipt_v1(TEXT,TEXT,TEXT,BIGINT),
  settle_tool_budget_with_receipt_v1(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT),
  reserve_tool_budget_microusd_v1(TEXT,TEXT,TEXT,BIGINT),
  settle_tool_budget_microusd_v1(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,JSONB),
  release_tool_budget_microusd_v1(TEXT,UUID),
  tool_budget_status_microusd_v1(TEXT,TEXT),
  close_tool_budget_microusd_v1(TEXT,TEXT,BOOLEAN),
  reserve_tool_budget_microusd_with_receipt_v1(TEXT,TEXT,TEXT,BIGINT),
  settle_tool_budget_microusd_with_receipt_v1(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT),
  settle_tool_budget_artifact_manifest_with_receipt_v1(TEXT,UUID,BIGINT,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,JSONB,TEXT)
FROM PUBLIC, app_user, execution_budget_platform_writer;

-- Task 5's v4 functions were additive compatibility entrypoints. They are
-- unsafe after the unit cutover because callers could still transition a
-- microusd operation through the predecessor API and observe cents fields.
-- Final v5/v2 SECURITY DEFINER wrappers remain able to call them as owner.
REVOKE ALL ON FUNCTION
  mark_tool_budget_result_unknown_v4(TEXT,UUID,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,TEXT,UUID),
  load_tool_budget_result_unknown_artifact_v4(TEXT,UUID,UUID,TEXT,UUID),
  settle_tool_budget_artifact_manifest_v4(TEXT,UUID,BIGINT,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,TEXT,UUID)
FROM PUBLIC, app_user, execution_budget_platform_writer;

REVOKE ALL ON FUNCTION
  open_tool_budget(TEXT,UUID,TEXT,BOOLEAN),
  reserve_tool_budget(TEXT,TEXT,TEXT,BIGINT),
  settle_tool_budget(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT),
  release_tool_budget(TEXT,UUID),
  tool_budget_status(TEXT,TEXT),
  close_tool_budget(TEXT,TEXT,BOOLEAN),
  settle_tool_budget_artifact_manifest_with_receipt_v2(TEXT,UUID,BIGINT,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,JSONB,TEXT,TEXT,UUID),
  mark_tool_budget_result_unknown_v5(TEXT,UUID,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,TEXT,UUID),
  load_tool_budget_result_unknown_artifact_v5(TEXT,UUID,UUID,TEXT,UUID)
FROM PUBLIC, app_user, execution_budget_platform_writer;

GRANT EXECUTE ON FUNCTION
  open_tool_budget(TEXT,UUID,TEXT,BOOLEAN),
  reserve_tool_budget(TEXT,TEXT,TEXT,BIGINT),
  settle_tool_budget(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT),
  release_tool_budget(TEXT,UUID),
  tool_budget_status(TEXT,TEXT),
  close_tool_budget(TEXT,TEXT,BOOLEAN),
  settle_tool_budget_artifact_manifest_with_receipt_v2(TEXT,UUID,BIGINT,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,JSONB,TEXT,TEXT,UUID),
  mark_tool_budget_result_unknown_v5(TEXT,UUID,JSONB,SMALLINT,BOOLEAN,TEXT,TEXT,TEXT,BOOLEAN,TEXT,UUID),
  load_tool_budget_result_unknown_artifact_v5(TEXT,UUID,UUID,TEXT,UUID)
TO app_user, execution_budget_platform_writer;

COMMIT;
