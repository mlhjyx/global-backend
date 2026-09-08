-- Forward-only signed-command persistence. JOSE verification belongs to the
-- authenticated receiver; these functions independently enforce DB bindings.
-- Rollback is a new forward migration: never delete revocation/receipt history.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE platform_egress_schedule_fence
  ADD COLUMN fence_sequence BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT platform_egress_schedule_fence_sequence_check CHECK (fence_sequence >= 0);

CREATE TABLE platform_revocation_receipt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer VARCHAR(2048) NOT NULL,
  revocation_jti UUID NOT NULL CHECK (revocation_jti::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  token_sha256 VARCHAR(64) NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  target_issuer VARCHAR(2048) NOT NULL,
  target_jti UUID NOT NULL CHECK (target_jti::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  schedule_id VARCHAR(191) NOT NULL CHECK (schedule_id IN ('acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh')),
  workflow_run_id VARCHAR(36) NOT NULL CHECK (workflow_run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  fence_sequence BIGINT NOT NULL CHECK (fence_sequence > 0),
  reason VARCHAR(80) NOT NULL CHECK (reason IN ('POLICY_DISABLED','SECURITY_RESPONSE','OPERATOR_HOLD')),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at)),
  generation BIGINT NOT NULL CHECK (generation > 0),
  committed_at TIMESTAMPTZ NOT NULL,
  in_flight_attempts BIGINT NOT NULL CHECK (in_flight_attempts >= 0),
  CONSTRAINT platform_revocation_receipt_issuer_jti_key UNIQUE (issuer, revocation_jti),
  CONSTRAINT platform_revocation_receipt_schedule_sequence_key UNIQUE (schedule_id, fence_sequence),
  CONSTRAINT platform_revocation_receipt_issuer_check CHECK (
    issuer = target_issuer AND char_length(issuer) BETWEEN 1 AND 2048
    AND issuer !~ '[[:space:][:cntrl:]]')
);
COMMENT ON COLUMN platform_revocation_receipt.committed_at IS
  'Time of fence facts inside the transaction, not PostgreSQL commit timestamp. Expose only after caller transaction commits.';
ALTER TABLE platform_revocation_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_revocation_receipt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_revocation_receipt FROM PUBLIC, app_user, runtime_api,
  runtime_worker, runtime_outbox_relay, execution_budget_platform_writer;

CREATE FUNCTION reject_platform_revocation_receipt_mutation_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'PLATFORM_REVOCATION_RECEIPT_IMMUTABLE' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER platform_revocation_receipt_immutable
  BEFORE UPDATE OR DELETE ON platform_revocation_receipt
  FOR EACH ROW EXECUTE FUNCTION reject_platform_revocation_receipt_mutation_v1();
CREATE TRIGGER platform_revocation_receipt_no_truncate
  BEFORE TRUNCATE ON platform_revocation_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_revocation_receipt_mutation_v1();
REVOKE ALL ON FUNCTION reject_platform_revocation_receipt_mutation_v1() FROM PUBLIC;

CREATE FUNCTION apply_platform_revocation_fence_v1(
  p_issuer TEXT, p_revocation_jti UUID, p_token_sha256 TEXT,
  p_target_issuer TEXT, p_target_jti UUID, p_schedule_id TEXT,
  p_workflow_run_id TEXT, p_fence_sequence BIGINT, p_reason TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE(receipt_id UUID, generation BIGINT, committed_at TIMESTAMPTZ,
  in_flight_attempts BIGINT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  prior platform_revocation_receipt%ROWTYPE;
  authority execution_budget_authority%ROWTYPE;
  fence platform_egress_schedule_fence%ROWTYPE;
  fact_time TIMESTAMPTZ;
  inflight BIGINT;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_issuer IS NULL OR char_length(p_issuer) NOT BETWEEN 1 AND 2048
    OR p_issuer ~ '[[:space:][:cntrl:]]'
    OR p_issuer IS DISTINCT FROM p_target_issuer
    OR p_revocation_jti IS NULL OR p_target_jti IS NULL
    OR p_revocation_jti::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_target_jti::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$'
    OR p_schedule_id IS NULL OR p_schedule_id NOT IN ('acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh')
    OR p_workflow_run_id IS NULL OR p_workflow_run_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_fence_sequence IS NULL OR p_fence_sequence <= 0
    OR p_reason IS NULL OR p_reason NOT IN ('POLICY_DISABLED','SECURITY_RESPONSE','OPERATOR_HOLD')
    OR p_expires_at IS NULL OR NOT isfinite(p_expires_at)
  THEN RAISE EXCEPTION 'PLATFORM_REVOCATION_INVALID' USING ERRCODE = 'P0001'; END IF;

  -- Serialize even a malicious same-JTI request that names a different schedule.
  -- Hash collisions merely serialize unrelated commands; identity is still exact.
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-revocation/v1:' || p_issuer || ':' || p_revocation_jti::text, 0));
  SELECT * INTO prior FROM platform_revocation_receipt r
    WHERE r.issuer = p_issuer AND r.revocation_jti = p_revocation_jti;
  IF prior.id IS NOT NULL THEN
    IF prior.token_sha256 IS DISTINCT FROM p_token_sha256
      OR prior.target_issuer IS DISTINCT FROM p_target_issuer OR prior.target_jti IS DISTINCT FROM p_target_jti
      OR prior.schedule_id IS DISTINCT FROM p_schedule_id OR prior.workflow_run_id IS DISTINCT FROM p_workflow_run_id
      OR prior.fence_sequence IS DISTINCT FROM p_fence_sequence OR prior.reason IS DISTINCT FROM p_reason
      OR prior.expires_at IS DISTINCT FROM p_expires_at
    THEN RAISE EXCEPTION 'PLATFORM_REVOCATION_REUSED' USING ERRCODE = 'P0001'; END IF;
    -- Only an exact durable receipt can survive expiry. Never re-fence on replay.
    RETURN QUERY SELECT prior.id, prior.generation, prior.committed_at, prior.in_flight_attempts, true;
    RETURN;
  END IF;

  -- Common dispatch/revocation order: schedule -> authority -> attempt.
  SELECT * INTO fence FROM platform_egress_schedule_fence f
    WHERE f.schedule_id = p_schedule_id FOR UPDATE;
  IF fence.schedule_id IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_REVOCATION_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO authority FROM execution_budget_authority a
    WHERE a.scope_key = 'platform' AND a.authority_kind = 'PLATFORM_GRANT'
      AND a.issuer = p_target_issuer AND a.jti = p_target_jti FOR UPDATE;
  IF authority.id IS NULL OR authority.schedule_id IS DISTINCT FROM p_schedule_id
    OR authority.workflow_run_id IS DISTINCT FROM p_workflow_run_id THEN
    RAISE EXCEPTION 'PLATFORM_REVOCATION_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  -- Recheck wall-clock expiry after waiting for all authoritative row locks.
  fact_time := clock_timestamp();
  IF p_expires_at <= fact_time THEN
    RAISE EXCEPTION 'PLATFORM_REVOCATION_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF p_fence_sequence <= fence.fence_sequence OR fence.generation = 9223372036854775807 THEN
    RAISE EXCEPTION 'PLATFORM_REVOCATION_SEQUENCE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  IF authority.issued_at > fact_time THEN
    RAISE EXCEPTION 'PLATFORM_REVOCATION_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- Existing append-only revocation is preserved; its trigger marks the locked
  -- authority. An already-revoked authority still permits a newer schedule fence.
  INSERT INTO execution_budget_authority_revocation(scope_key, authority_id, reason, revoked_at)
    VALUES ('platform', authority.id, p_reason, fact_time)
    ON CONFLICT (authority_id) DO NOTHING;
  UPDATE platform_egress_schedule_fence f
    SET state = 'DISABLED', generation = f.generation + 1,
      fence_sequence = p_fence_sequence, updated_at = fact_time
    WHERE f.schedule_id = p_schedule_id RETURNING * INTO fence;
  UPDATE platform_egress_attempt a
    SET state = 'BLOCKED', outcome_meta = jsonb_build_object('reason', p_reason)
    WHERE a.schedule_id = p_schedule_id AND a.state = 'AUTHORIZED';
  SELECT count(*) INTO inflight FROM platform_egress_attempt a
    WHERE a.schedule_id = p_schedule_id AND a.state = 'SENDING';

  INSERT INTO platform_revocation_receipt(issuer, revocation_jti, token_sha256,
    target_issuer, target_jti, schedule_id, workflow_run_id, fence_sequence, reason,
    expires_at, generation, committed_at, in_flight_attempts)
  VALUES (p_issuer, p_revocation_jti, p_token_sha256, p_target_issuer, p_target_jti,
    p_schedule_id, p_workflow_run_id, p_fence_sequence, p_reason, p_expires_at,
    fence.generation, fact_time, inflight) RETURNING * INTO prior;
  RETURN QUERY SELECT prior.id, prior.generation, prior.committed_at, prior.in_flight_attempts, false;
END $$;
REVOKE ALL ON FUNCTION apply_platform_revocation_fence_v1(TEXT,UUID,TEXT,TEXT,UUID,TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION apply_platform_revocation_fence_v1(TEXT,UUID,TEXT,TEXT,UUID,TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ)
  TO execution_budget_platform_writer;

-- Reorder existing locks, retaining every predecessor validation and checking
-- wall-clock expiry after those waits rather than the stale statement start. Legacy fence
-- locks schedule then attempts; legacy revoke locks authority only. ACK/UNKNOWN
-- lock only an attempt. None can introduce an authority -> schedule inversion.
CREATE OR REPLACE FUNCTION authorize_platform_egress_v1(
  p_authority_id UUID, p_schedule_id TEXT, p_workflow_id TEXT,
  p_workflow_run_id TEXT, p_operation_key TEXT, p_policy_revision TEXT
)
RETURNS TABLE(attempt_id UUID, generation BIGINT, replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  authority execution_budget_authority%ROWTYPE;
  fence platform_egress_schedule_fence%ROWTYPE;
  existing platform_egress_attempt%ROWTYPE;
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
  SELECT * INTO fence FROM platform_egress_schedule_fence
    WHERE schedule_id = p_schedule_id FOR UPDATE;
  SELECT * INTO authority FROM execution_budget_authority
    WHERE id = p_authority_id AND scope_key = 'platform'
      AND authority_kind = 'PLATFORM_GRANT' FOR UPDATE;
  SELECT * INTO existing FROM platform_egress_attempt
    WHERE authority_id = p_authority_id AND operation_key = p_operation_key FOR UPDATE;
  IF authority.id IS NULL OR authority.revoked_at IS NOT NULL
    OR authority.expires_at <= clock_timestamp()
    OR authority.consumed_at IS NULL OR authority.runs_consumed IS DISTINCT FROM 1
    OR authority.max_runs IS DISTINCT FROM 1
    OR authority.campaign_cap_microusd IS DISTINCT FROM authority.cap_per_run_microusd
    OR authority.schedule_id IS DISTINCT FROM p_schedule_id
    OR authority.workflow_id IS DISTINCT FROM p_workflow_id
    OR authority.workflow_run_id IS DISTINCT FROM p_workflow_run_id
    OR authority.technical_policy_revision IS DISTINCT FROM p_policy_revision
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_NOT_AUTHORIZED' USING ERRCODE = 'P0001'; END IF;
  IF fence.schedule_id IS NULL OR fence.state <> 'ACTIVE'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REVOKED' USING ERRCODE = 'P0001'; END IF;
  IF existing.id IS NOT NULL THEN
    IF existing.schedule_id IS DISTINCT FROM p_schedule_id
      OR existing.workflow_run_id IS DISTINCT FROM p_workflow_run_id
      OR existing.policy_revision IS DISTINCT FROM p_policy_revision
    THEN RAISE EXCEPTION 'PLATFORM_EGRESS_ATTEMPT_REUSED' USING ERRCODE = 'P0001'; END IF;
    RETURN QUERY SELECT existing.id, existing.generation, true; RETURN;
  END IF;
  INSERT INTO platform_egress_attempt(
    authority_id, schedule_id, workflow_id, workflow_run_id, operation_key, policy_revision, generation
  ) VALUES (p_authority_id, p_schedule_id, p_workflow_id, p_workflow_run_id, p_operation_key,
            p_policy_revision, fence.generation)
  RETURNING id, platform_egress_attempt.generation, false INTO attempt_id, generation, replay;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION claim_platform_egress_send_v1(
  p_attempt_id UUID, p_authority_id UUID, p_schedule_id TEXT, p_workflow_id TEXT,
  p_workflow_run_id TEXT, p_operation_key TEXT, p_policy_revision TEXT
)
RETURNS TABLE(attempt_id UUID, generation BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt platform_egress_attempt%ROWTYPE;
  authority execution_budget_authority%ROWTYPE;
  fence platform_egress_schedule_fence%ROWTYPE;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  SELECT * INTO fence FROM platform_egress_schedule_fence
    WHERE schedule_id = p_schedule_id FOR UPDATE;
  SELECT * INTO authority FROM execution_budget_authority
    WHERE id = p_authority_id AND scope_key = 'platform' FOR UPDATE;
  SELECT * INTO attempt FROM platform_egress_attempt
    WHERE id = p_attempt_id AND authority_id = p_authority_id FOR UPDATE;
  IF attempt.id IS NULL OR authority.id IS NULL OR fence.schedule_id IS NULL
    OR attempt.schedule_id IS DISTINCT FROM p_schedule_id
    OR attempt.workflow_id IS DISTINCT FROM p_workflow_id
    OR attempt.operation_key IS DISTINCT FROM p_operation_key
    OR attempt.workflow_run_id IS DISTINCT FROM p_workflow_run_id
    OR attempt.policy_revision IS DISTINCT FROM p_policy_revision
    OR attempt.generation IS DISTINCT FROM fence.generation
    OR fence.state <> 'ACTIVE'
    OR authority.revoked_at IS NOT NULL
    OR authority.expires_at <= clock_timestamp()
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE = 'P0001'; END IF;
  IF attempt.state <> 'AUTHORIZED'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_ATTEMPT_REUSED' USING ERRCODE = 'P0001'; END IF;
  UPDATE platform_egress_attempt SET state = 'SENDING', sending_at = clock_timestamp()
    WHERE id = attempt.id AND state = 'AUTHORIZED'
    RETURNING id, platform_egress_attempt.generation INTO attempt_id, generation;
  IF attempt_id IS NULL THEN RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE = 'P0001'; END IF;
  RETURN NEXT;
END $$;
COMMIT;
