-- P4-P4a: channel-crawl platform egress fence, parallel to the 4-schedule fence.
-- A capability-scoped fence row ('channel-crawl') plus a dedicated attempt table
-- and SECURITY DEFINER transitions. The schedule fence, its attempt table and
-- every schedule function stay byte-identical; channel crawl is fail-closed
-- until the operator publishes the reviewed-v3 policy fingerprints through the
-- owner-only installer, and every physical wire re-checks authority revocation,
-- expiry, policy generation and already-reserved budget at both send stages.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "platform_egress_capability_fence" (
  "capability_id" VARCHAR(64) PRIMARY KEY,
  "generation" BIGINT NOT NULL DEFAULT 0,
  "state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "policy_artifact_sha256" VARCHAR(64),
  "execution_envelope_sha256" VARCHAR(64),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "platform_egress_capability_fence_id_check"
    CHECK ("capability_id" IN ('channel-crawl')),
  CONSTRAINT "platform_egress_capability_fence_state_check"
    CHECK ("state" IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT "platform_egress_capability_fence_generation_check"
    CHECK ("generation" >= 0),
  CONSTRAINT "platform_egress_capability_fence_policy_check" CHECK (
    num_nonnulls("policy_artifact_sha256", "execution_envelope_sha256") = 0
    OR (num_nonnulls("policy_artifact_sha256", "execution_envelope_sha256") = 2
      AND "policy_artifact_sha256" ~ '^[0-9a-f]{64}$'
      AND "execution_envelope_sha256" ~ '^[0-9a-f]{64}$')
  )
);

INSERT INTO "platform_egress_capability_fence"("capability_id") VALUES ('channel-crawl');

CREATE TABLE "platform_channel_crawl_egress_attempt" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "authority_id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "crawl_run_id" UUID NOT NULL,
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
  "account_id" UUID,
  "account_generation" INTEGER,
  "budget_operation_id" UUID,
  "budget_operation_key" VARCHAR(200),
  "reserved_microusd" BIGINT,
  CONSTRAINT "platform_channel_crawl_egress_attempt_authority_fkey"
    FOREIGN KEY ("authority_id") REFERENCES "execution_budget_authority"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "platform_channel_crawl_egress_attempt_account_fkey"
    FOREIGN KEY ("account_id") REFERENCES "tool_budget_account"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "platform_channel_crawl_egress_attempt_budget_operation_fkey"
    FOREIGN KEY ("budget_operation_id") REFERENCES "tool_budget_operation"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "platform_channel_crawl_egress_attempt_binding_check" CHECK (
    "operation_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND "policy_revision" ~ '^[0-9a-f]{64}$'
    AND "generation" >= 0
    AND num_nonnulls("account_id","account_generation","budget_operation_id","budget_operation_key","reserved_microusd") = 5
    AND "account_generation" > 0
    AND "reserved_microusd" >= 0
    AND "budget_operation_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  )
);
CREATE UNIQUE INDEX "platform_channel_crawl_attempt_authority_operation_key"
  ON "platform_channel_crawl_egress_attempt"("authority_id", "operation_key");
CREATE UNIQUE INDEX "platform_channel_crawl_attempt_run_operation_key"
  ON "platform_channel_crawl_egress_attempt"("crawl_run_id", "operation_key");
CREATE INDEX "platform_channel_crawl_attempt_run_generation_state_idx"
  ON "platform_channel_crawl_egress_attempt"("crawl_run_id", "generation", "state");

ALTER TABLE "platform_egress_capability_fence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_egress_capability_fence" FORCE ROW LEVEL SECURITY;
ALTER TABLE "platform_channel_crawl_egress_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_channel_crawl_egress_attempt" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "platform_egress_capability_fence", "platform_channel_crawl_egress_attempt"
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,
       execution_budget_platform_writer;

CREATE FUNCTION inspect_platform_egress_capability_policy_v1(p_capability_id TEXT)
RETURNS TABLE(capability_id TEXT, state TEXT, generation BIGINT,
  policy_artifact_sha256 TEXT, execution_envelope_sha256 TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_capability_id IS DISTINCT FROM 'channel-crawl' THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_BINDING_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT f.capability_id::text, f.state::text, f.generation,
    f.policy_artifact_sha256::text, f.execution_envelope_sha256::text
    FROM platform_egress_capability_fence f WHERE f.capability_id = p_capability_id;
END $$;

-- Owner-only compare-and-set publication, mirroring install_platform_egress_policy_v2.
CREATE FUNCTION install_platform_egress_capability_policy_v1(
  p_capability_id TEXT, p_expected_generation BIGINT,
  p_policy_artifact_sha256 TEXT, p_execution_envelope_sha256 TEXT)
RETURNS TABLE(generation BIGINT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE fence platform_egress_capability_fence%ROWTYPE;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'none' OR session_user IS DISTINCT FROM (
    SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
    WHERE p.oid = 'public.install_platform_egress_capability_policy_v1(text,bigint,text,text)'::regprocedure
  ) THEN RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_INSTALL_PRINCIPAL_INVALID' USING ERRCODE = 'P0001'; END IF;
  IF p_capability_id IS DISTINCT FROM 'channel-crawl'
    OR p_expected_generation IS NULL OR p_expected_generation < 0
    OR p_policy_artifact_sha256 IS NULL OR p_policy_artifact_sha256 !~ '^[0-9a-f]{64}$'
    OR p_execution_envelope_sha256 IS NULL OR p_execution_envelope_sha256 !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_BINDING_INVALID' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO fence FROM platform_egress_capability_fence f
    WHERE f.capability_id = p_capability_id FOR UPDATE;
  IF fence.capability_id IS NULL OR fence.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_DISABLED' USING ERRCODE = 'P0001';
  END IF;
  IF fence.generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_GENERATION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF fence.policy_artifact_sha256 = p_policy_artifact_sha256
    AND fence.execution_envelope_sha256 = p_execution_envelope_sha256 THEN
    RETURN QUERY SELECT fence.generation, true; RETURN;
  END IF;
  IF fence.generation = 9223372036854775807 THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_GENERATION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  UPDATE platform_egress_capability_fence f SET generation = f.generation + 1,
    policy_artifact_sha256 = p_policy_artifact_sha256,
    execution_envelope_sha256 = p_execution_envelope_sha256,
    updated_at = clock_timestamp()
    WHERE f.capability_id = p_capability_id RETURNING * INTO fence;
  UPDATE platform_channel_crawl_egress_attempt a SET state = 'BLOCKED',
    outcome_meta = jsonb_build_object('reason', 'POLICY_GENERATION_CHANGED')
    WHERE a.generation < fence.generation AND a.state = 'AUTHORIZED';
  RETURN QUERY SELECT fence.generation, false;
END $$;

-- Private shared check for both crawl send stages. Same lock order as the
-- schedule path: account advisory -> account -> operation; authority first.
CREATE FUNCTION lock_platform_channel_crawl_egress_budget_v1(
  p_authority_id UUID, p_channel_id UUID, p_crawl_run_id UUID, p_request_sha256 TEXT,
  p_operation_key TEXT, p_policy_revision TEXT, p_account_key TEXT,
  p_budget_operation_id UUID, p_budget_operation_key TEXT, p_reserved_microusd BIGINT,
  p_required_cap_microusd BIGINT, p_expected_operation_microusd BIGINT,
  p_policy_artifact_sha256 TEXT, p_execution_envelope_sha256 TEXT)
RETURNS TABLE(fence_generation BIGINT, account_id UUID, account_generation INTEGER, authority_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  fence platform_egress_capability_fence%ROWTYPE;
  authority execution_budget_authority%ROWTYPE;
  account tool_budget_account%ROWTYPE;
  operation tool_budget_operation%ROWTYPE;
  checked_at TIMESTAMPTZ;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_authority_id IS NULL OR p_budget_operation_id IS NULL
    OR p_channel_id IS NULL OR p_crawl_run_id IS NULL
    OR p_request_sha256 IS NULL OR p_request_sha256 !~ '^[0-9a-f]{64}$'
    OR p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    OR p_account_key IS NULL OR char_length(p_account_key) NOT BETWEEN 1 AND 200
    OR p_budget_operation_key IS NULL OR p_budget_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    OR p_policy_revision IS NULL OR p_policy_revision !~ '^[0-9a-f]{64}$'
    OR p_policy_artifact_sha256 IS NULL OR p_policy_artifact_sha256 !~ '^[0-9a-f]{64}$'
    OR p_execution_envelope_sha256 IS NULL OR p_execution_envelope_sha256 !~ '^[0-9a-f]{64}$'
    OR p_reserved_microusd IS NULL OR p_reserved_microusd < 0
    OR p_expected_operation_microusd IS NULL OR p_expected_operation_microusd < 0
    OR p_required_cap_microusd IS NULL OR p_required_cap_microusd <= 0
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_BINDING_INVALID' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO fence FROM platform_egress_capability_fence f
    WHERE f.capability_id = 'channel-crawl' FOR UPDATE;
  SELECT * INTO authority FROM execution_budget_authority a
    WHERE a.id = p_authority_id AND a.scope_key = 'platform' AND a.authority_kind = 'PLATFORM_GRANT' FOR UPDATE;
  IF authority.id IS NULL OR authority.request_sha256 IS NULL OR authority.crawl_run_id IS NULL
    OR p_account_key IS DISTINCT FROM 'platform:' || authority.request_sha256 || ':' || authority.crawl_run_id
    OR authority.request_sha256 IS DISTINCT FROM p_request_sha256
    OR authority.crawl_run_id IS DISTINCT FROM p_crawl_run_id::text
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_NOT_AUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tool-budget-account:platform:' || p_account_key, 0));
  SELECT * INTO account FROM tool_budget_account a
    WHERE a.scope_key = 'platform' AND a.account_key = p_account_key FOR UPDATE;
  SELECT * INTO operation FROM tool_budget_operation o
    WHERE o.id = p_budget_operation_id AND o.scope_key = 'platform' AND o.account_id = account.id FOR UPDATE;
  checked_at := clock_timestamp();
  IF fence.capability_id IS NULL OR fence.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE = 'P0001';
  END IF;
  IF fence.policy_artifact_sha256 IS NULL OR fence.execution_envelope_sha256 IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF fence.policy_artifact_sha256 IS DISTINCT FROM p_policy_artifact_sha256
    OR fence.execution_envelope_sha256 IS DISTINCT FROM p_execution_envelope_sha256
    OR authority.technical_policy_revision IS DISTINCT FROM p_policy_revision
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_DRIFT' USING ERRCODE = 'P0001'; END IF;
  IF authority.revoked_at IS NOT NULL OR authority.expires_at <= checked_at OR authority.not_before > checked_at
    OR authority.issued_at > checked_at OR authority.consumed_at IS NULL
    OR authority.runs_consumed IS DISTINCT FROM 1
    OR authority.max_runs IS DISTINCT FROM 1
    OR authority.cap_per_run_microusd IS DISTINCT FROM p_required_cap_microusd
    OR authority.campaign_cap_microusd < authority.cap_per_run_microusd
    OR authority.subject_type IS DISTINCT FROM 'source_channel'
    OR authority.subject_id IS DISTINCT FROM p_channel_id::text
    OR authority.purpose::text IS DISTINCT FROM 'platform.channel_crawl'
    OR EXISTS (SELECT 1 FROM execution_budget_authority_revocation r WHERE r.authority_id = authority.id)
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_NOT_AUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF account.id IS NULL OR account.authority_id IS DISTINCT FROM authority.id OR account.generation < 1
    OR account.ref_count IS DISTINCT FROM 1 OR account.closed_at IS NOT NULL OR account.exhausted
    OR account.authorized_cap_microusd IS DISTINCT FROM p_required_cap_microusd
    OR account.cap_cents IS DISTINCT FROM 0 OR account.reserved_cents IS DISTINCT FROM 0
    OR account.charged_cents IS DISTINCT FROM 0
    OR account.reserved_microusd < 0 OR account.charged_microusd < 0
    OR account.reserved_microusd::numeric + account.charged_microusd::numeric > p_required_cap_microusd::numeric
    OR operation.id IS NULL OR operation.account_id IS DISTINCT FROM account.id
    OR operation.generation IS DISTINCT FROM account.generation
    OR operation.operation_key IS DISTINCT FROM p_budget_operation_key
    OR operation.amount_unit IS DISTINCT FROM 'microusd' OR operation.reserved_cents IS DISTINCT FROM 0
    OR operation.status IS DISTINCT FROM 'RESERVED' OR operation.settled_at IS NOT NULL
    OR operation.reserved_microusd IS DISTINCT FROM p_reserved_microusd
    OR operation.reserved_microusd IS DISTINCT FROM p_expected_operation_microusd
    OR account.reserved_microusd < operation.reserved_microusd
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_BUDGET_NOT_AUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT fence.generation, account.id, account.generation, authority.expires_at;
END $$;

CREATE FUNCTION authorize_platform_channel_crawl_egress_v1(
  p_authority_id UUID, p_channel_id UUID, p_crawl_run_id UUID, p_request_sha256 TEXT,
  p_operation_key TEXT, p_policy_revision TEXT, p_account_key TEXT,
  p_budget_operation_id UUID, p_budget_operation_key TEXT, p_reserved_microusd BIGINT,
  p_required_cap_microusd BIGINT, p_expected_operation_microusd BIGINT,
  p_policy_artifact_sha256 TEXT, p_execution_envelope_sha256 TEXT)
RETURNS TABLE(attempt_id UUID, generation BIGINT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE locked RECORD; existing platform_channel_crawl_egress_attempt%ROWTYPE;
BEGIN
  SELECT * INTO locked FROM lock_platform_channel_crawl_egress_budget_v1(
    p_authority_id, p_channel_id, p_crawl_run_id, p_request_sha256, p_operation_key,
    p_policy_revision, p_account_key, p_budget_operation_id, p_budget_operation_key,
    p_reserved_microusd, p_required_cap_microusd, p_expected_operation_microusd,
    p_policy_artifact_sha256, p_execution_envelope_sha256);
  SELECT * INTO existing FROM platform_channel_crawl_egress_attempt a
    WHERE a.authority_id = p_authority_id AND a.operation_key = p_operation_key FOR UPDATE;
  IF locked.authority_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  IF existing.id IS NOT NULL THEN
    IF existing.channel_id IS DISTINCT FROM p_channel_id
      OR existing.crawl_run_id IS DISTINCT FROM p_crawl_run_id
      OR existing.policy_revision IS DISTINCT FROM p_policy_revision
      OR existing.generation IS DISTINCT FROM locked.fence_generation
      OR existing.account_id IS DISTINCT FROM locked.account_id
      OR existing.account_generation IS DISTINCT FROM locked.account_generation
      OR existing.budget_operation_id IS DISTINCT FROM p_budget_operation_id
      OR existing.budget_operation_key IS DISTINCT FROM p_budget_operation_key
      OR existing.reserved_microusd IS DISTINCT FROM p_reserved_microusd
    THEN RAISE EXCEPTION 'PLATFORM_EGRESS_ATTEMPT_REUSED' USING ERRCODE = 'P0001'; END IF;
    RETURN QUERY SELECT existing.id, existing.generation, true; RETURN;
  END IF;
  INSERT INTO platform_channel_crawl_egress_attempt(
    authority_id, channel_id, crawl_run_id, operation_key, policy_revision, generation,
    account_id, account_generation, budget_operation_id, budget_operation_key, reserved_microusd)
  VALUES (p_authority_id, p_channel_id, p_crawl_run_id, p_operation_key, p_policy_revision,
    locked.fence_generation, locked.account_id, locked.account_generation,
    p_budget_operation_id, p_budget_operation_key, p_reserved_microusd)
    RETURNING id, platform_channel_crawl_egress_attempt.generation, false
    INTO attempt_id, generation, replay;
  RETURN NEXT;
END $$;

CREATE FUNCTION claim_platform_channel_crawl_egress_send_v1(
  p_attempt_id UUID, p_authority_id UUID, p_channel_id UUID, p_crawl_run_id UUID,
  p_request_sha256 TEXT, p_operation_key TEXT, p_policy_revision TEXT, p_account_key TEXT,
  p_budget_operation_id UUID, p_budget_operation_key TEXT, p_reserved_microusd BIGINT,
  p_required_cap_microusd BIGINT, p_expected_operation_microusd BIGINT,
  p_policy_artifact_sha256 TEXT, p_execution_envelope_sha256 TEXT)
RETURNS TABLE(attempt_id UUID, generation BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE locked RECORD; attempt platform_channel_crawl_egress_attempt%ROWTYPE;
BEGIN
  SELECT * INTO locked FROM lock_platform_channel_crawl_egress_budget_v1(
    p_authority_id, p_channel_id, p_crawl_run_id, p_request_sha256, p_operation_key,
    p_policy_revision, p_account_key, p_budget_operation_id, p_budget_operation_key,
    p_reserved_microusd, p_required_cap_microusd, p_expected_operation_microusd,
    p_policy_artifact_sha256, p_execution_envelope_sha256);
  SELECT * INTO attempt FROM platform_channel_crawl_egress_attempt a
    WHERE a.id = p_attempt_id AND a.authority_id = p_authority_id FOR UPDATE;
  IF attempt.id IS NULL
    OR attempt.channel_id IS DISTINCT FROM p_channel_id
    OR attempt.crawl_run_id IS DISTINCT FROM p_crawl_run_id
    OR attempt.operation_key IS DISTINCT FROM p_operation_key
    OR attempt.policy_revision IS DISTINCT FROM p_policy_revision
    OR attempt.generation IS DISTINCT FROM locked.fence_generation
    OR attempt.account_id IS DISTINCT FROM locked.account_id
    OR attempt.account_generation IS DISTINCT FROM locked.account_generation
    OR attempt.budget_operation_id IS DISTINCT FROM p_budget_operation_id
    OR attempt.budget_operation_key IS DISTINCT FROM p_budget_operation_key
    OR attempt.reserved_microusd IS DISTINCT FROM p_reserved_microusd
    OR locked.authority_expires_at <= clock_timestamp()
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE = 'P0001'; END IF;
  IF attempt.state <> 'AUTHORIZED' THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_ATTEMPT_REUSED' USING ERRCODE = 'P0001';
  END IF;
  UPDATE platform_channel_crawl_egress_attempt a
    SET state = 'SENDING', sending_at = clock_timestamp()
    WHERE a.id = attempt.id AND a.state = 'AUTHORIZED'
    RETURNING a.id, a.generation INTO attempt_id, generation;
  IF attempt_id IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEXT;
END $$;

CREATE FUNCTION acknowledge_platform_channel_crawl_egress_v1(p_attempt_id UUID, p_outcome_digest TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE existing platform_channel_crawl_egress_attempt%ROWTYPE;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_outcome_digest IS NOT NULL AND p_outcome_digest !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_OUTCOME_INVALID' USING ERRCODE = 'P0001'; END IF;
  UPDATE platform_channel_crawl_egress_attempt
    SET state = 'ACKNOWLEDGED', acknowledged_at = clock_timestamp(), outcome_digest = p_outcome_digest
    WHERE id = p_attempt_id AND state = 'SENDING';
  IF FOUND THEN RETURN true; END IF;
  SELECT * INTO existing FROM platform_channel_crawl_egress_attempt WHERE id = p_attempt_id;
  IF existing.state = 'ACKNOWLEDGED' AND existing.outcome_digest IS NOT DISTINCT FROM p_outcome_digest
  THEN RETURN true; END IF;
  IF existing.state = 'ACKNOWLEDGED'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_OUTCOME_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  RETURN false;
END $$;

CREATE FUNCTION mark_unknown_platform_channel_crawl_egress_v1(p_attempt_id UUID, p_reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE existing platform_channel_crawl_egress_attempt%ROWTYPE;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 80
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_UNKNOWN_REASON_INVALID' USING ERRCODE = 'P0001'; END IF;
  UPDATE platform_channel_crawl_egress_attempt
    SET state = 'UNKNOWN', unknown_at = clock_timestamp(), outcome_meta = jsonb_build_object('reason', p_reason)
    WHERE id = p_attempt_id AND state = 'SENDING';
  IF FOUND THEN RETURN true; END IF;
  SELECT * INTO existing FROM platform_channel_crawl_egress_attempt WHERE id = p_attempt_id;
  IF existing.state = 'UNKNOWN' AND existing.outcome_meta->>'reason' = p_reason
  THEN RETURN true; END IF;
  IF existing.state = 'UNKNOWN'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_OUTCOME_CONFLICT' USING ERRCODE = 'P0001'; END IF;
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION install_platform_egress_capability_policy_v1(TEXT,BIGINT,TEXT,TEXT),
  lock_platform_channel_crawl_egress_budget_v1(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay, execution_budget_platform_writer;
REVOKE ALL ON FUNCTION inspect_platform_egress_capability_policy_v1(TEXT),
  authorize_platform_channel_crawl_egress_v1(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT),
  claim_platform_channel_crawl_egress_send_v1(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT),
  acknowledge_platform_channel_crawl_egress_v1(UUID,TEXT),
  mark_unknown_platform_channel_crawl_egress_v1(UUID,TEXT)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION inspect_platform_egress_capability_policy_v1(TEXT),
  authorize_platform_channel_crawl_egress_v1(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT),
  claim_platform_channel_crawl_egress_send_v1(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT),
  acknowledge_platform_channel_crawl_egress_v1(UUID,TEXT),
  mark_unknown_platform_channel_crawl_egress_v1(UUID,TEXT)
  TO execution_budget_platform_writer;

COMMIT;
