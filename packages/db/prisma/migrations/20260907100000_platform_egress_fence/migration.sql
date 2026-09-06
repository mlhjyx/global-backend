-- 4D: durable per-schedule generation and linearizable physical-wire send cut.
-- No direct table DML is granted to runtime principals; the writer functions
-- below are the only platform dispatch state transitions.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "platform_egress_attempt_state" AS ENUM (
  'AUTHORIZED', 'SENDING', 'ACKNOWLEDGED', 'UNKNOWN', 'SETTLED', 'BLOCKED'
);

CREATE TABLE "platform_egress_schedule_fence" (
  "schedule_id" VARCHAR(191) PRIMARY KEY,
  "generation" BIGINT NOT NULL DEFAULT 0,
  "state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "platform_egress_schedule_fence_state_check"
    CHECK ("state" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "platform_egress_schedule_fence_generation_check"
    CHECK ("generation" >= 0)
);

INSERT INTO "platform_egress_schedule_fence"("schedule_id") VALUES
  ('acq-sweep'), ('patents-cache-refresh'), ('intent-sweep'), ('sanctions-refresh');

CREATE TABLE "platform_egress_attempt" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "authority_id" UUID NOT NULL,
  "schedule_id" VARCHAR(191) NOT NULL,
  "workflow_id" VARCHAR(200) NOT NULL,
  "workflow_run_id" VARCHAR(36) NOT NULL,
  "operation_key" VARCHAR(200) NOT NULL,
  "policy_revision" VARCHAR(64) NOT NULL,
  "generation" BIGINT NOT NULL,
  "state" "platform_egress_attempt_state" NOT NULL DEFAULT 'AUTHORIZED',
  "authorized_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "sending_at" TIMESTAMPTZ(3),
  "acknowledged_at" TIMESTAMPTZ(3),
  "unknown_at" TIMESTAMPTZ(3),
  "outcome_digest" VARCHAR(64),
  "outcome_meta" JSONB,
  CONSTRAINT "platform_egress_attempt_authority_fkey"
    FOREIGN KEY ("authority_id") REFERENCES "execution_budget_authority"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "platform_egress_attempt_binding_check" CHECK (
    "schedule_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$'
    AND "workflow_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND "workflow_run_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "operation_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND "policy_revision" ~ '^[0-9a-f]{64}$'
    AND "generation" >= 0
  )
);
CREATE UNIQUE INDEX "platform_egress_attempt_authority_operation_key"
  ON "platform_egress_attempt"("authority_id", "operation_key");
CREATE UNIQUE INDEX "platform_egress_attempt_run_operation_key"
  ON "platform_egress_attempt"("schedule_id", "workflow_run_id", "operation_key");
CREATE INDEX "platform_egress_attempt_schedule_generation_state_idx"
  ON "platform_egress_attempt"("schedule_id", "generation", "state");

ALTER TABLE "platform_egress_schedule_fence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_egress_schedule_fence" FORCE ROW LEVEL SECURITY;
ALTER TABLE "platform_egress_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_egress_attempt" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "platform_egress_schedule_fence", "platform_egress_attempt"
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,
       execution_budget_platform_writer;

CREATE FUNCTION authorize_platform_egress_v1(
  p_authority_id UUID,
  p_schedule_id TEXT,
  p_workflow_id TEXT,
  p_workflow_run_id TEXT,
  p_operation_key TEXT,
  p_policy_revision TEXT
)
RETURNS TABLE(attempt_id UUID, generation BIGINT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  authority "execution_budget_authority"%ROWTYPE;
  fence "platform_egress_schedule_fence"%ROWTYPE;
  existing "platform_egress_attempt"%ROWTYPE;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_authority_id IS NULL OR p_schedule_id IS NULL OR p_workflow_id IS NULL OR p_workflow_run_id IS NULL
    OR p_operation_key IS NULL OR p_policy_revision IS NULL
    OR p_schedule_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$'
    OR p_workflow_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    OR p_workflow_run_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    OR p_policy_revision !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_BINDING_INVALID' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO authority FROM "execution_budget_authority"
    WHERE id = p_authority_id AND scope_key = 'platform'
      AND authority_kind = 'PLATFORM_GRANT' FOR UPDATE;
  IF authority.id IS NULL OR authority.revoked_at IS NOT NULL
    OR authority.expires_at <= statement_timestamp()
    OR authority.consumed_at IS NULL OR authority.runs_consumed IS DISTINCT FROM 1
    OR authority.max_runs IS DISTINCT FROM 1
    OR authority.campaign_cap_microusd IS DISTINCT FROM authority.cap_per_run_microusd
    OR authority.schedule_id IS DISTINCT FROM p_schedule_id
    OR authority.workflow_id IS DISTINCT FROM p_workflow_id
    OR authority.workflow_run_id IS DISTINCT FROM p_workflow_run_id
    OR authority.technical_policy_revision IS DISTINCT FROM p_policy_revision
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_NOT_AUTHORIZED' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO fence FROM "platform_egress_schedule_fence"
    WHERE schedule_id = p_schedule_id FOR UPDATE;
  IF fence.schedule_id IS NULL OR fence.state <> 'ACTIVE'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REVOKED' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO existing FROM "platform_egress_attempt"
    WHERE authority_id = p_authority_id AND operation_key = p_operation_key FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    IF existing.schedule_id IS DISTINCT FROM p_schedule_id
      OR existing.workflow_run_id IS DISTINCT FROM p_workflow_run_id
      OR existing.policy_revision IS DISTINCT FROM p_policy_revision
    THEN RAISE EXCEPTION 'PLATFORM_EGRESS_ATTEMPT_REUSED' USING ERRCODE = 'P0001'; END IF;
    RETURN QUERY SELECT existing.id, existing.generation, true; RETURN;
  END IF;

  INSERT INTO "platform_egress_attempt"(
    authority_id, schedule_id, workflow_id, workflow_run_id, operation_key, policy_revision, generation
  ) VALUES (p_authority_id, p_schedule_id, p_workflow_id, p_workflow_run_id, p_operation_key,
            p_policy_revision, fence.generation)
  RETURNING id, platform_egress_attempt.generation, false
  INTO attempt_id, generation, replay;
  RETURN NEXT;
END
$$;

CREATE FUNCTION claim_platform_egress_send_v1(
  p_attempt_id UUID,
  p_authority_id UUID,
  p_schedule_id TEXT,
  p_workflow_id TEXT,
  p_workflow_run_id TEXT,
  p_policy_revision TEXT
)
RETURNS TABLE(attempt_id UUID, generation BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt "platform_egress_attempt"%ROWTYPE;
  authority "execution_budget_authority"%ROWTYPE;
  fence "platform_egress_schedule_fence"%ROWTYPE;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  SELECT * INTO attempt FROM "platform_egress_attempt"
    WHERE id = p_attempt_id AND authority_id = p_authority_id FOR UPDATE;
  SELECT * INTO authority FROM "execution_budget_authority"
    WHERE id = p_authority_id AND scope_key = 'platform' FOR UPDATE;
  SELECT * INTO fence FROM "platform_egress_schedule_fence"
    WHERE schedule_id = p_schedule_id FOR UPDATE;
  IF attempt.id IS NULL OR authority.id IS NULL OR fence.schedule_id IS NULL
    OR attempt.schedule_id IS DISTINCT FROM p_schedule_id
    OR attempt.workflow_id IS DISTINCT FROM p_workflow_id
    OR attempt.workflow_run_id IS DISTINCT FROM p_workflow_run_id
    OR attempt.policy_revision IS DISTINCT FROM p_policy_revision
    OR attempt.generation IS DISTINCT FROM fence.generation
    OR fence.state <> 'ACTIVE'
    OR authority.revoked_at IS NOT NULL
    OR authority.expires_at <= statement_timestamp()
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE = 'P0001'; END IF;
  IF attempt.state <> 'AUTHORIZED'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_ATTEMPT_REUSED' USING ERRCODE = 'P0001'; END IF;
  UPDATE "platform_egress_attempt" SET state = 'SENDING', sending_at = clock_timestamp()
    WHERE id = attempt.id AND state = 'AUTHORIZED'
    RETURNING id, platform_egress_attempt.generation INTO attempt_id, generation;
  IF attempt_id IS NULL THEN RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE = 'P0001'; END IF;
  RETURN NEXT;
END
$$;

CREATE FUNCTION acknowledge_platform_egress_v1(p_attempt_id UUID, p_outcome_digest TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  existing "platform_egress_attempt"%ROWTYPE;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_outcome_digest IS NOT NULL AND p_outcome_digest !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_OUTCOME_INVALID' USING ERRCODE = 'P0001'; END IF;
  UPDATE "platform_egress_attempt"
    SET state = 'ACKNOWLEDGED', acknowledged_at = clock_timestamp(), outcome_digest = p_outcome_digest
    WHERE id = p_attempt_id AND state = 'SENDING';
  IF FOUND THEN RETURN true; END IF;
  SELECT * INTO existing FROM "platform_egress_attempt" WHERE id = p_attempt_id;
  IF existing.state = 'ACKNOWLEDGED' AND existing.outcome_digest IS NOT DISTINCT FROM p_outcome_digest
  THEN RETURN true; END IF;
  IF existing.state = 'ACKNOWLEDGED'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_OUTCOME_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  RETURN false;
END
$$;

CREATE FUNCTION mark_unknown_platform_egress_v1(p_attempt_id UUID, p_reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  existing "platform_egress_attempt"%ROWTYPE;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 80
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_UNKNOWN_REASON_INVALID' USING ERRCODE = 'P0001'; END IF;
  UPDATE "platform_egress_attempt"
    SET state = 'UNKNOWN', unknown_at = clock_timestamp(), outcome_meta = jsonb_build_object('reason', p_reason)
    WHERE id = p_attempt_id AND state = 'SENDING';
  IF FOUND THEN RETURN true; END IF;
  SELECT * INTO existing FROM "platform_egress_attempt" WHERE id = p_attempt_id;
  IF existing.state = 'UNKNOWN' AND existing.outcome_meta->>'reason' = p_reason
  THEN RETURN true; END IF;
  IF existing.state = 'UNKNOWN'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_OUTCOME_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  RETURN false;
END
$$;

CREATE FUNCTION fence_platform_schedule_v1(p_schedule_id TEXT, p_reason TEXT)
RETURNS TABLE(generation BIGINT, blocked_attempts BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  next_generation BIGINT;
BEGIN
  IF p_schedule_id IS NULL OR p_schedule_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$'
    OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 80
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_FENCE_INPUT_INVALID' USING ERRCODE = 'P0001'; END IF;
  UPDATE "platform_egress_schedule_fence"
    SET generation = platform_egress_schedule_fence.generation + 1,
        state = 'DISABLED', updated_at = clock_timestamp()
    WHERE schedule_id = p_schedule_id
    RETURNING platform_egress_schedule_fence.generation INTO next_generation;
  IF next_generation IS NULL THEN RAISE EXCEPTION 'PLATFORM_EGRESS_SCHEDULE_UNKNOWN' USING ERRCODE = 'P0001'; END IF;
  UPDATE "platform_egress_attempt" SET state = 'BLOCKED', outcome_meta = jsonb_build_object('reason', p_reason)
    WHERE platform_egress_attempt.schedule_id = p_schedule_id
      AND platform_egress_attempt.generation < next_generation
      AND platform_egress_attempt.state = 'AUTHORIZED';
  GET DIAGNOSTICS blocked_attempts = ROW_COUNT;
  generation := next_generation;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION authorize_platform_egress_v1(UUID, TEXT, TEXT, TEXT, TEXT, TEXT),
  claim_platform_egress_send_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT),
  acknowledge_platform_egress_v1(UUID, TEXT),
  mark_unknown_platform_egress_v1(UUID, TEXT)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION authorize_platform_egress_v1(UUID, TEXT, TEXT, TEXT, TEXT, TEXT),
  claim_platform_egress_send_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT),
  acknowledge_platform_egress_v1(UUID, TEXT),
  mark_unknown_platform_egress_v1(UUID, TEXT)
  TO execution_budget_platform_writer;

COMMIT;
