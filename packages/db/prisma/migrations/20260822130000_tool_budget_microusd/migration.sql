BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Task 1 is additive. Existing cents columns/functions remain the product
-- path until the atomic cutover. These columns are an independent native
-- microusd ledger for legacy unbound accounts only.
ALTER TABLE "tool_budget_account"
  ADD COLUMN "reserved_microusd" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "charged_microusd" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "tool_budget_operation"
  ADD COLUMN "amount_unit" VARCHAR(16) NOT NULL DEFAULT 'cent',
  ADD COLUMN "reserved_microusd" BIGINT,
  ADD COLUMN "observed_microusd" BIGINT,
  ADD COLUMN "charged_microusd" BIGINT;

ALTER TABLE "tool_budget_account"
  ADD CONSTRAINT "tool_budget_account_microusd_nonnegative_check" CHECK (
    "reserved_microusd" >= 0 AND "charged_microusd" >= 0
  );

ALTER TABLE "tool_budget_operation"
  ADD CONSTRAINT "tool_budget_operation_amount_unit_check" CHECK (
    (
      "amount_unit" = 'cent'
      AND "reserved_microusd" IS NULL
      AND "observed_microusd" IS NULL
      AND "charged_microusd" IS NULL
    ) OR (
      "amount_unit" = 'microusd'
      AND "reserved_cents" = 0
      AND "observed_cents" IS NULL
      AND "charged_cents" IS NULL
      AND "reserved_microusd" IS NOT NULL
      AND "reserved_microusd" >= 0
      AND ("observed_microusd" IS NULL OR "observed_microusd" >= 0)
      AND ("charged_microusd" IS NULL OR (
        "charged_microusd" >= 0
        AND "charged_microusd" <= "reserved_microusd"
      ))
    )
  );

ALTER TABLE "tool_budget_operation"
  DROP CONSTRAINT "tool_budget_operation_status_shape_check",
  ADD CONSTRAINT "tool_budget_operation_status_shape_check" CHECK (
    (
      "status" IN ('RESERVED', 'RESULT_UNKNOWN')
      AND "observed_cents" IS NULL
      AND "charged_cents" IS NULL
      AND "observed_microusd" IS NULL
      AND "charged_microusd" IS NULL
      AND "settled_at" IS NULL
    ) OR (
      "status" IN ('SETTLED', 'RELEASED')
      AND "settled_at" IS NOT NULL
      AND (
        (
          "amount_unit" = 'cent'
          AND "observed_cents" IS NOT NULL
          AND "charged_cents" IS NOT NULL
          AND "observed_microusd" IS NULL
          AND "charged_microusd" IS NULL
        ) OR (
          "amount_unit" = 'microusd'
          AND "observed_cents" IS NULL
          AND "charged_cents" IS NULL
          AND "observed_microusd" IS NOT NULL
          AND "charged_microusd" IS NOT NULL
        )
      )
    )
  );

CREATE FUNCTION reset_tool_budget_microusd_generation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."generation" IS DISTINCT FROM OLD."generation"
    AND EXISTS (
      SELECT 1 FROM "tool_budget_operation" unresolved
      WHERE unresolved."account_id" = OLD."id"
        AND unresolved."generation" = OLD."generation"
        AND unresolved."status" IN ('RESERVED', 'RESULT_UNKNOWN')
    )
  THEN
    RAISE EXCEPTION 'TOOL_BUDGET_UNSETTLED_OPERATIONS';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."generation" IS DISTINCT FROM OLD."generation" THEN
    NEW."reserved_microusd" := 0;
    NEW."charged_microusd" := 0;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "tool_budget_account_microusd_generation_reset"
BEFORE INSERT OR UPDATE OF "generation" ON "tool_budget_account"
FOR EACH ROW EXECUTE FUNCTION reset_tool_budget_microusd_generation_v1();

CREATE FUNCTION guard_tool_budget_operation_amount_unit_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "tool_budget_operation" sibling
    WHERE sibling."account_id" = NEW."account_id"
      AND sibling."generation" = NEW."generation"
      AND sibling."id" IS DISTINCT FROM NEW."id"
      AND sibling."amount_unit" IS DISTINCT FROM NEW."amount_unit"
  ) THEN
    RAISE EXCEPTION 'TOOL_BUDGET_AMOUNT_UNIT_CONFLICT';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "tool_budget_operation_amount_unit_guard"
BEFORE INSERT OR UPDATE OF "amount_unit" ON "tool_budget_operation"
FOR EACH ROW EXECUTE FUNCTION guard_tool_budget_operation_amount_unit_v1();

CREATE FUNCTION tool_budget_unbound_cap_microusd_v1(
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
  SELECT target.* INTO account
  FROM "tool_budget_account" target
  WHERE target."id"=p_account_id AND target."scope_key"=p_scope_key
  FOR SHARE;
  IF account."id" IS NULL THEN
    RAISE EXCEPTION 'TOOL_BUDGET_ACCOUNT_UNAVAILABLE';
  END IF;
  IF account."authority_id" IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE='P0001';
  END IF;
  -- A legacy BIGINT-cent cap can exceed BIGINT microusd after multiplication.
  -- Clamp to the largest amount the new ledger can represent; never divide an
  -- authority cap and never wrap or truncate.
  RETURN LEAST(
    account."cap_cents"::numeric * 10000::numeric,
    9223372036854775807::numeric
  )::bigint;
END
$$;

CREATE FUNCTION reserve_tool_budget_microusd_v1(
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
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
    OR char_length(p_operation_key) NOT BETWEEN 1 AND 200
    OR p_reservation_microusd IS NULL OR p_reservation_microusd < 0
  THEN RAISE EXCEPTION 'invalid tool budget microusd reservation'; END IF;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key AND target."account_key"=p_account_key
  FOR UPDATE;
  IF account."id" IS NULL OR account."ref_count"=0 THEN
    RAISE EXCEPTION 'TOOL_BUDGET_ACCOUNT_UNAVAILABLE';
  END IF;
  cap_microusd := tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  IF EXISTS (
    SELECT 1 FROM "tool_budget_operation" legacy
    WHERE legacy."account_id"=account."id"
      AND legacy."generation"=account."generation"
      AND legacy."amount_unit"='cent'
  ) THEN RAISE EXCEPTION 'TOOL_BUDGET_AMOUNT_UNIT_CONFLICT'; END IF;
  IF account."charged_microusd">cap_microusd
    OR account."reserved_microusd">cap_microusd-account."charged_microusd"
  THEN RAISE EXCEPTION 'TOOL_BUDGET_MICROUSD_INVARIANT'; END IF;
  remaining := cap_microusd-account."reserved_microusd"-account."charged_microusd";
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."account_id"=account."id"
    AND target."generation"=account."generation"
    AND target."operation_key"=p_operation_key
  FOR UPDATE;
  IF operation."id" IS NOT NULL THEN
    IF operation."amount_unit"<>'microusd' THEN
      RAISE EXCEPTION 'TOOL_BUDGET_AMOUNT_UNIT_CONFLICT';
    END IF;
    RETURN QUERY SELECT 'REPLAY',operation."id",operation."reserved_microusd",
      remaining,operation."status"::text,operation."result_json";
    RETURN;
  END IF;
  IF account."exhausted" OR p_reservation_microusd>remaining THEN
    UPDATE "tool_budget_account" target
    SET "exhausted"=true,"updated_at"=clock_timestamp()
    WHERE target."id"=account."id";
    RETURN QUERY SELECT 'DENIED',NULL::UUID,0::BIGINT,remaining,
      'EXHAUSTED',NULL::JSONB;
    RETURN;
  END IF;
  INSERT INTO "tool_budget_operation"(
    "scope_key","account_id","generation","operation_key",
    "amount_unit","reserved_cents","reserved_microusd"
  ) VALUES (
    p_scope_key,account."id",account."generation",p_operation_key,
    'microusd',0,p_reservation_microusd
  ) RETURNING * INTO operation;
  UPDATE "tool_budget_account" target
  SET "reserved_microusd"=target."reserved_microusd"+p_reservation_microusd,
      "updated_at"=clock_timestamp()
  WHERE target."id"=account."id" RETURNING target.* INTO account;
  RETURN QUERY SELECT 'EXECUTE',operation."id",operation."reserved_microusd",
    cap_microusd-account."reserved_microusd"-account."charged_microusd",
    operation."status"::text,NULL::JSONB;
END
$$;

CREATE FUNCTION settle_tool_budget_microusd_v1(
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
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
    OR p_observed_microusd IS NULL OR p_observed_microusd<0
  THEN RAISE EXCEPTION 'invalid tool budget microusd settlement'; END IF;
  IF NOT (
    (p_result_json IS NULL AND p_result_schema_version IS NULL AND p_result_schema IS NULL AND p_result_digest IS NULL)
    OR
    (p_result_json IS NOT NULL AND p_result_schema_version IS NOT NULL AND p_result_schema IS NOT NULL AND p_result_digest IS NOT NULL)
  ) THEN RAISE EXCEPTION 'GENERIC_OPERATION_PROJECTION_INVALID'; END IF;
  IF p_result_json IS NOT NULL AND (
    jsonb_typeof(p_result_json)<>'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_result_json))<>5
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
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."id"=p_operation_id AND target."scope_key"=p_scope_key
  FOR UPDATE;
  IF operation."id" IS NULL OR operation."amount_unit"<>'microusd' THEN
    RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE';
  END IF;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."id"=operation."account_id" AND target."scope_key"=p_scope_key
  FOR UPDATE;
  PERFORM tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  IF operation."status"<>'RESERVED' THEN
    IF operation."status"<>'SETTLED'
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
  UPDATE "tool_budget_operation" target
  SET "observed_microusd"=p_observed_microusd,"charged_microusd"=charge,
      "status"='SETTLED',"result_schema_version"=p_result_schema_version,
      "result_schema"=p_result_schema,"result_digest"=p_result_digest,
      "result_json"=p_result_json,"settled_at"=clock_timestamp()
  WHERE target."id"=operation."id" RETURNING target.* INTO operation;
  UPDATE "tool_budget_account" target
  SET "reserved_microusd"=target."reserved_microusd"-operation."reserved_microusd",
      "charged_microusd"=target."charged_microusd"+charge,
      "exhausted"=target."exhausted" OR p_observed_microusd>operation."reserved_microusd",
      "updated_at"=clock_timestamp()
  WHERE target."id"=account."id";
  RETURN QUERY SELECT charge,p_observed_microusd,
    p_observed_microusd>operation."reserved_microusd",
    operation."status"::text,false;
END
$$;

CREATE FUNCTION release_tool_budget_microusd_v1(
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
DECLARE account "tool_budget_account"%ROWTYPE; operation "tool_budget_operation"%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN RAISE EXCEPTION 'workspace scope mismatch'; END IF;
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."id"=p_operation_id AND target."scope_key"=p_scope_key FOR UPDATE;
  IF operation."id" IS NULL OR operation."amount_unit"<>'microusd' THEN
    RAISE EXCEPTION 'TOOL_BUDGET_OPERATION_UNAVAILABLE';
  END IF;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."id"=operation."account_id" AND target."scope_key"=p_scope_key FOR UPDATE;
  PERFORM tool_budget_unbound_cap_microusd_v1(account."id", p_scope_key);
  IF operation."status"='RESERVED' THEN
    UPDATE "tool_budget_operation" target
    SET "observed_microusd"=0,"charged_microusd"=0,
        "status"='RELEASED',"settled_at"=clock_timestamp()
    WHERE target."id"=operation."id" RETURNING target.* INTO operation;
    UPDATE "tool_budget_account" target
    SET "reserved_microusd"=target."reserved_microusd"-operation."reserved_microusd",
        "updated_at"=clock_timestamp()
    WHERE target."id"=account."id";
    RETURN QUERY SELECT 0::BIGINT,0::BIGINT,false,operation."status"::text,false;
    RETURN;
  END IF;
  RETURN QUERY SELECT operation."charged_microusd",operation."observed_microusd",
    false,operation."status"::text,true;
END
$$;

CREATE FUNCTION tool_budget_status_microusd_v1(
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
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN RAISE EXCEPTION 'workspace scope mismatch'; END IF;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key AND target."account_key"=p_account_key
  FOR SHARE;
  IF account."id" IS NULL THEN RETURN; END IF;
  cap_microusd := tool_budget_unbound_cap_microusd_v1(account."id",p_scope_key);
  IF account."charged_microusd">cap_microusd
    OR account."reserved_microusd">cap_microusd-account."charged_microusd"
  THEN RAISE EXCEPTION 'TOOL_BUDGET_MICROUSD_INVARIANT'; END IF;
  RETURN QUERY SELECT cap_microusd-account."reserved_microusd"-account."charged_microusd",
    account."exhausted",account."ref_count",account."generation";
END
$$;

CREATE FUNCTION close_tool_budget_microusd_v1(
  p_scope_key TEXT, p_account_key TEXT, p_force BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE account "tool_budget_account"%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_scope_key IS DISTINCT FROM current_workspace_id()::text
  THEN RAISE EXCEPTION 'workspace scope mismatch'; END IF;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key AND target."account_key"=p_account_key FOR UPDATE;
  IF account."id" IS NULL THEN RETURN false; END IF;
  PERFORM tool_budget_unbound_cap_microusd_v1(account."id",p_scope_key);
  UPDATE "tool_budget_account" target
  SET "ref_count"=CASE WHEN p_force THEN 0 ELSE GREATEST(0,target."ref_count"-1) END,
      "closed_at"=CASE WHEN p_force OR target."ref_count"<=1 THEN clock_timestamp() ELSE NULL END,
      "updated_at"=clock_timestamp()
  WHERE target."id"=account."id";
  RETURN true;
END
$$;

-- Preserve the legacy signature and cents behavior, but fail closed if an old
-- binary reuses the exact operation key of a microusd operation. The insert
-- trigger already fences different-key mixing; replay returns before INSERT,
-- so the same-key check must live in the legacy function itself.
CREATE OR REPLACE FUNCTION reserve_tool_budget(
  p_scope_key TEXT,
  p_account_key TEXT,
  p_operation_key TEXT,
  p_reservation_cents BIGINT
)
RETURNS TABLE(
  kind TEXT, operation_id UUID, reserved_cents BIGINT,
  remaining_cents BIGINT, status TEXT, result_json JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  account "tool_budget_account"%ROWTYPE;
  operation "tool_budget_operation"%ROWTYPE;
BEGIN
  IF ((p_scope_key='platform' AND session_user='app_user')
      OR (p_scope_key<>'platform' AND p_scope_key IS DISTINCT FROM current_workspace_id()::text))
    OR char_length(p_operation_key) NOT BETWEEN 1 AND 200
    OR p_reservation_cents<0
  THEN RAISE EXCEPTION 'invalid tool budget reservation'; END IF;
  SELECT target.* INTO account FROM "tool_budget_account" target
  WHERE target."scope_key"=p_scope_key AND target."account_key"=p_account_key
  FOR UPDATE;
  IF account."id" IS NULL OR account."ref_count"=0 THEN
    RAISE EXCEPTION 'TOOL_BUDGET_ACCOUNT_UNAVAILABLE';
  END IF;
  IF account."authority_id" IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE'
      USING ERRCODE='P0001';
  END IF;
  SELECT target.* INTO operation FROM "tool_budget_operation" target
  WHERE target."account_id"=account."id"
    AND target."generation"=account."generation"
    AND target."operation_key"=p_operation_key
  FOR UPDATE;
  IF operation."id" IS NOT NULL THEN
    IF operation."amount_unit"<>'cent' THEN
      RAISE EXCEPTION 'TOOL_BUDGET_AMOUNT_UNIT_CONFLICT';
    END IF;
    RETURN QUERY SELECT 'REPLAY',operation."id",operation."reserved_cents",
      account."cap_cents"-account."reserved_cents"-account."charged_cents",
      operation."status"::text,operation."result_json";
    RETURN;
  END IF;
  IF account."exhausted" THEN
    RETURN QUERY SELECT 'DENIED',NULL::UUID,0::BIGINT,
      account."cap_cents"-account."reserved_cents"-account."charged_cents",
      'EXHAUSTED',NULL::JSONB;
    RETURN;
  END IF;
  IF p_reservation_cents>
    account."cap_cents"-account."reserved_cents"-account."charged_cents"
  THEN
    UPDATE "tool_budget_account" target
    SET "exhausted"=true,"updated_at"=clock_timestamp()
    WHERE target."id"=account."id";
    RETURN QUERY SELECT 'DENIED',NULL::UUID,0::BIGINT,
      account."cap_cents"-account."reserved_cents"-account."charged_cents",
      'EXHAUSTED',NULL::JSONB;
    RETURN;
  END IF;
  INSERT INTO "tool_budget_operation"(
    "scope_key","account_id","generation","operation_key","reserved_cents"
  ) VALUES (
    p_scope_key,account."id",account."generation",p_operation_key,
    p_reservation_cents
  ) RETURNING * INTO operation;
  UPDATE "tool_budget_account" target
  SET "reserved_cents"=target."reserved_cents"+p_reservation_cents,
      "updated_at"=clock_timestamp()
  WHERE target."id"=account."id" RETURNING target.* INTO account;
  RETURN QUERY SELECT 'EXECUTE',operation."id",operation."reserved_cents",
    account."cap_cents"-account."reserved_cents"-account."charged_cents",
    operation."status"::text,NULL::JSONB;
END
$$;

REVOKE ALL ON FUNCTION
  reset_tool_budget_microusd_generation_v1(),
  guard_tool_budget_operation_amount_unit_v1(),
  tool_budget_unbound_cap_microusd_v1(UUID,TEXT),
  reserve_tool_budget_microusd_v1(TEXT,TEXT,TEXT,BIGINT),
  settle_tool_budget_microusd_v1(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,JSONB),
  release_tool_budget_microusd_v1(TEXT,UUID),
  tool_budget_status_microusd_v1(TEXT,TEXT),
  close_tool_budget_microusd_v1(TEXT,TEXT,BOOLEAN)
FROM PUBLIC, app_user, execution_budget_platform_writer;

GRANT EXECUTE ON FUNCTION
  reserve_tool_budget_microusd_v1(TEXT,TEXT,TEXT,BIGINT),
  settle_tool_budget_microusd_v1(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,JSONB),
  release_tool_budget_microusd_v1(TEXT,UUID),
  tool_budget_status_microusd_v1(TEXT,TEXT),
  close_tool_budget_microusd_v1(TEXT,TEXT,BOOLEAN)
TO app_user;

COMMIT;
