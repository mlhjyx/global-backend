-- Approved Task 4: current policy + already-reserved budget at both send stages.
-- N-1 INCOMPATIBLE: v1 writer EXECUTE is revoked below. Deployment must drain
-- old workers and use a forward fix, never restore a mutable predecessor service.
-- This migration does NOT publish policy fingerprints, reopen a disabled fence,
-- or assert runtime readiness. Exact source/quote comparison is a separate gate.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE platform_egress_schedule_fence
  ADD COLUMN policy_artifact_sha256 VARCHAR(64),
  ADD COLUMN execution_envelope_sha256 VARCHAR(64),
  ADD COLUMN required_cap_microusd BIGINT,
  ADD CONSTRAINT platform_egress_schedule_policy_binding_check CHECK (
    num_nonnulls(policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd) = 0
    OR (num_nonnulls(policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd) = 3
      AND policy_artifact_sha256 ~ '^[0-9a-f]{64}$' AND execution_envelope_sha256 ~ '^[0-9a-f]{64}$'
      AND required_cap_microusd > 0));
ALTER TABLE platform_egress_attempt
  ADD COLUMN account_id UUID,
  ADD COLUMN account_generation INTEGER,
  ADD COLUMN budget_operation_id UUID,
  ADD COLUMN budget_operation_key VARCHAR(200),
  ADD COLUMN reserved_microusd BIGINT,
  ADD CONSTRAINT platform_egress_attempt_account_fkey FOREIGN KEY (account_id)
    REFERENCES tool_budget_account(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT platform_egress_attempt_budget_operation_fkey FOREIGN KEY (budget_operation_id)
    REFERENCES tool_budget_operation(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT platform_egress_attempt_budget_binding_check CHECK (
    num_nonnulls(account_id,account_generation,budget_operation_id,budget_operation_key,reserved_microusd) = 0
    OR (num_nonnulls(account_id,account_generation,budget_operation_id,budget_operation_key,reserved_microusd) = 5
      AND account_generation > 0 AND reserved_microusd >= 0
      AND budget_operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'));

CREATE FUNCTION inspect_platform_egress_policy_v2(p_schedule_id TEXT)
RETURNS TABLE(schedule_id TEXT,state TEXT,generation BIGINT,fence_sequence BIGINT,
  policy_artifact_sha256 TEXT,execution_envelope_sha256 TEXT,required_cap_microusd BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_schedule_id IS NULL OR p_schedule_id NOT IN ('acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh') THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_BINDING_INVALID' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT f.schedule_id::text,f.state::text,f.generation,f.fence_sequence,
    f.policy_artifact_sha256::text,f.execution_envelope_sha256::text,f.required_cap_microusd
    FROM platform_egress_schedule_fence f WHERE f.schedule_id=p_schedule_id;
END $$;

-- Owner-only compare-and-set publication. Inputs are not approval evidence:
-- a separately authorized deployment must derive them from the existing quote
-- implementation and runtime readiness must independently compare that source.
CREATE FUNCTION install_platform_egress_policy_v2(p_schedule_id TEXT,p_expected_generation BIGINT,
  p_policy_artifact_sha256 TEXT,p_execution_envelope_sha256 TEXT,p_required_cap_microusd BIGINT)
RETURNS TABLE(generation BIGINT,replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE fence platform_egress_schedule_fence%ROWTYPE;
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'none' OR session_user IS DISTINCT FROM (
    SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
    WHERE p.oid='public.install_platform_egress_policy_v2(text,bigint,text,text,bigint)'::regprocedure
  ) THEN RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_INSTALL_PRINCIPAL_INVALID' USING ERRCODE='P0001'; END IF;
  IF p_schedule_id IS NULL OR p_schedule_id NOT IN ('acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh')
    OR p_expected_generation IS NULL OR p_expected_generation < 0
    OR p_policy_artifact_sha256 IS NULL OR p_policy_artifact_sha256 !~ '^[0-9a-f]{64}$'
    OR p_execution_envelope_sha256 IS NULL OR p_execution_envelope_sha256 !~ '^[0-9a-f]{64}$'
    OR p_required_cap_microusd IS NULL OR p_required_cap_microusd <= 0
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_BINDING_INVALID' USING ERRCODE='P0001'; END IF;
  SELECT * INTO fence FROM platform_egress_schedule_fence f WHERE f.schedule_id=p_schedule_id FOR UPDATE;
  IF fence.schedule_id IS NULL OR fence.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_DISABLED' USING ERRCODE='P0001';
  END IF;
  IF fence.generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_GENERATION_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF fence.policy_artifact_sha256=p_policy_artifact_sha256 AND fence.execution_envelope_sha256=p_execution_envelope_sha256
    AND fence.required_cap_microusd=p_required_cap_microusd THEN
    RETURN QUERY SELECT fence.generation,true; RETURN;
  END IF;
  IF fence.generation=9223372036854775807 THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_GENERATION_CONFLICT' USING ERRCODE='P0001';
  END IF;
  UPDATE platform_egress_schedule_fence f SET generation=f.generation+1,
    policy_artifact_sha256=p_policy_artifact_sha256,execution_envelope_sha256=p_execution_envelope_sha256,
    required_cap_microusd=p_required_cap_microusd,updated_at=clock_timestamp()
    WHERE f.schedule_id=p_schedule_id RETURNING * INTO fence;
  UPDATE platform_egress_attempt a SET state='BLOCKED',outcome_meta=jsonb_build_object('reason','POLICY_GENERATION_CHANGED')
    WHERE a.schedule_id=p_schedule_id AND a.generation<fence.generation AND a.state='AUTHORIZED';
  RETURN QUERY SELECT fence.generation,false;
END $$;

-- Private shared check, called by both public stages. The account advisory is
-- the EXISTING budget lifecycle mutex, needed before account -> operation row
-- locks because settle/release internally use operation -> account under it.
CREATE FUNCTION lock_platform_egress_budget_v2(
  p_authority_id UUID,p_schedule_id TEXT,p_workflow_id TEXT,p_workflow_run_id TEXT,
  p_operation_key TEXT,p_policy_revision TEXT,p_account_key TEXT,p_budget_operation_id UUID,
  p_budget_operation_key TEXT,p_reserved_microusd BIGINT,p_required_cap_microusd BIGINT,
  p_expected_operation_microusd BIGINT,p_policy_artifact_sha256 TEXT,p_execution_envelope_sha256 TEXT)
RETURNS TABLE(fence_generation BIGINT,account_id UUID,account_generation INTEGER,authority_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  fence platform_egress_schedule_fence%ROWTYPE;
  authority execution_budget_authority%ROWTYPE;
  account tool_budget_account%ROWTYPE;
  operation tool_budget_operation%ROWTYPE;
  checked_at TIMESTAMPTZ;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_authority_id IS NULL OR p_budget_operation_id IS NULL
    OR p_schedule_id IS NULL OR p_schedule_id NOT IN ('acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh')
    OR p_workflow_id IS NULL OR p_workflow_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    OR p_workflow_run_id IS NULL OR p_workflow_run_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    OR p_account_key IS NULL OR char_length(p_account_key) NOT BETWEEN 1 AND 200
    OR p_budget_operation_key IS NULL OR p_budget_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    OR p_policy_revision IS NULL OR p_policy_revision !~ '^[0-9a-f]{64}$'
    OR p_policy_artifact_sha256 IS NULL OR p_policy_artifact_sha256 !~ '^[0-9a-f]{64}$'
    OR p_execution_envelope_sha256 IS NULL OR p_execution_envelope_sha256 !~ '^[0-9a-f]{64}$'
    OR p_reserved_microusd IS NULL OR p_reserved_microusd < 0
    OR p_expected_operation_microusd IS NULL OR p_expected_operation_microusd < 0
    OR p_required_cap_microusd IS NULL OR p_required_cap_microusd <= 0
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_BINDING_INVALID' USING ERRCODE='P0001'; END IF;
  SELECT * INTO fence FROM platform_egress_schedule_fence f WHERE f.schedule_id=p_schedule_id FOR UPDATE;
  SELECT * INTO authority FROM execution_budget_authority a
    WHERE a.id=p_authority_id AND a.scope_key='platform' AND a.authority_kind='PLATFORM_GRANT' FOR UPDATE;
  -- Validate the immutable account identity before choosing its mutex.
  IF authority.id IS NULL OR authority.schedule_request_sha256 IS NULL
    OR p_account_key IS DISTINCT FROM 'platform:'||authority.schedule_request_sha256||':'||authority.workflow_run_id
    OR authority.schedule_id IS DISTINCT FROM p_schedule_id OR authority.workflow_id IS DISTINCT FROM p_workflow_id
    OR authority.workflow_run_id IS DISTINCT FROM p_workflow_run_id THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_NOT_AUTHORIZED' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tool-budget-account:platform:'||p_account_key,0));
  SELECT * INTO account FROM tool_budget_account a WHERE a.scope_key='platform' AND a.account_key=p_account_key FOR UPDATE;
  SELECT * INTO operation FROM tool_budget_operation o WHERE o.id=p_budget_operation_id AND o.scope_key='platform'
    AND o.account_id=account.id FOR UPDATE;
  checked_at := clock_timestamp();
  IF fence.schedule_id IS NULL OR fence.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE='P0001';
  END IF;
  IF fence.policy_artifact_sha256 IS NULL OR fence.execution_envelope_sha256 IS NULL OR fence.required_cap_microusd IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_UNAVAILABLE' USING ERRCODE='P0001';
  END IF;
  IF fence.policy_artifact_sha256 IS DISTINCT FROM p_policy_artifact_sha256
    OR fence.execution_envelope_sha256 IS DISTINCT FROM p_execution_envelope_sha256
    OR fence.required_cap_microusd IS DISTINCT FROM p_required_cap_microusd
    OR authority.technical_policy_revision IS DISTINCT FROM p_policy_revision THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_POLICY_DRIFT' USING ERRCODE='P0001';
  END IF;
  IF authority.revoked_at IS NOT NULL OR authority.expires_at<=checked_at OR authority.not_before>checked_at
    OR authority.issued_at>checked_at OR authority.consumed_at IS NULL OR authority.runs_consumed IS DISTINCT FROM 1
    OR authority.max_runs IS DISTINCT FROM 1 OR authority.cap_per_run_microusd IS DISTINCT FROM p_required_cap_microusd
    OR authority.campaign_cap_microusd IS DISTINCT FROM authority.cap_per_run_microusd
    OR authority.subject_type IS DISTINCT FROM 'schedule' OR authority.subject_id IS DISTINCT FROM p_schedule_id
    OR authority.purpose::text IS DISTINCT FROM (CASE p_schedule_id WHEN 'intent-sweep' THEN 'platform.intent_watch'
      WHEN 'sanctions-refresh' THEN 'platform.sanctions' ELSE 'platform.acquisition' END)
    OR EXISTS (SELECT 1 FROM execution_budget_authority_revocation r WHERE r.authority_id=authority.id) THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_NOT_AUTHORIZED' USING ERRCODE='P0001';
  END IF;
  IF account.id IS NULL OR account.authority_id IS DISTINCT FROM authority.id OR account.generation < 1
    OR account.ref_count IS DISTINCT FROM 1 OR account.closed_at IS NOT NULL OR account.exhausted
    OR account.authorized_cap_microusd IS DISTINCT FROM p_required_cap_microusd
    OR account.cap_cents IS DISTINCT FROM 0 OR account.reserved_cents IS DISTINCT FROM 0 OR account.charged_cents IS DISTINCT FROM 0
    OR account.reserved_microusd<0 OR account.charged_microusd<0
    OR account.reserved_microusd::numeric+account.charged_microusd::numeric>p_required_cap_microusd::numeric
    OR operation.id IS NULL OR operation.account_id IS DISTINCT FROM account.id
    OR operation.generation IS DISTINCT FROM account.generation OR operation.operation_key IS DISTINCT FROM p_budget_operation_key
    OR operation.amount_unit IS DISTINCT FROM 'microusd' OR operation.reserved_cents IS DISTINCT FROM 0
    OR operation.status IS DISTINCT FROM 'RESERVED' OR operation.settled_at IS NOT NULL
    OR operation.reserved_microusd IS DISTINCT FROM p_reserved_microusd
    OR operation.reserved_microusd IS DISTINCT FROM p_expected_operation_microusd
    OR account.reserved_microusd<operation.reserved_microusd THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_BUDGET_NOT_AUTHORIZED' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT fence.generation,account.id,account.generation,authority.expires_at;
END $$;

CREATE FUNCTION authorize_platform_egress_v2(
  p_authority_id UUID,p_schedule_id TEXT,p_workflow_id TEXT,p_workflow_run_id TEXT,
  p_operation_key TEXT,p_policy_revision TEXT,p_account_key TEXT,p_budget_operation_id UUID,
  p_budget_operation_key TEXT,p_reserved_microusd BIGINT,p_required_cap_microusd BIGINT,
  p_expected_operation_microusd BIGINT,p_policy_artifact_sha256 TEXT,p_execution_envelope_sha256 TEXT)
RETURNS TABLE(attempt_id UUID,generation BIGINT,replay BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE locked RECORD; existing platform_egress_attempt%ROWTYPE;
BEGIN
  SELECT * INTO locked FROM lock_platform_egress_budget_v2(p_authority_id,p_schedule_id,p_workflow_id,p_workflow_run_id,
    p_operation_key,p_policy_revision,p_account_key,p_budget_operation_id,p_budget_operation_key,p_reserved_microusd,
    p_required_cap_microusd,p_expected_operation_microusd,p_policy_artifact_sha256,p_execution_envelope_sha256);
  SELECT * INTO existing FROM platform_egress_attempt a
    WHERE a.authority_id=p_authority_id AND a.operation_key=p_operation_key FOR UPDATE;
  IF locked.authority_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_NOT_AUTHORIZED' USING ERRCODE='P0001';
  END IF;
  IF existing.id IS NOT NULL THEN
    IF existing.schedule_id IS DISTINCT FROM p_schedule_id OR existing.workflow_id IS DISTINCT FROM p_workflow_id
      OR existing.workflow_run_id IS DISTINCT FROM p_workflow_run_id OR existing.policy_revision IS DISTINCT FROM p_policy_revision
      OR existing.generation IS DISTINCT FROM locked.fence_generation OR existing.account_id IS DISTINCT FROM locked.account_id
      OR existing.account_generation IS DISTINCT FROM locked.account_generation
      OR existing.budget_operation_id IS DISTINCT FROM p_budget_operation_id OR existing.budget_operation_key IS DISTINCT FROM p_budget_operation_key
      OR existing.reserved_microusd IS DISTINCT FROM p_reserved_microusd THEN
      RAISE EXCEPTION 'PLATFORM_EGRESS_ATTEMPT_REUSED' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT existing.id,existing.generation,true; RETURN;
  END IF;
  INSERT INTO platform_egress_attempt(authority_id,schedule_id,workflow_id,workflow_run_id,operation_key,policy_revision,generation,
    account_id,account_generation,budget_operation_id,budget_operation_key,reserved_microusd)
  VALUES (p_authority_id,p_schedule_id,p_workflow_id,p_workflow_run_id,p_operation_key,p_policy_revision,locked.fence_generation,
    locked.account_id,locked.account_generation,p_budget_operation_id,p_budget_operation_key,p_reserved_microusd)
    RETURNING id,platform_egress_attempt.generation,false INTO attempt_id,generation,replay;
  RETURN NEXT;
END $$;

CREATE FUNCTION claim_platform_egress_send_v2(
  p_attempt_id UUID,p_authority_id UUID,p_schedule_id TEXT,p_workflow_id TEXT,p_workflow_run_id TEXT,
  p_operation_key TEXT,p_policy_revision TEXT,p_account_key TEXT,p_budget_operation_id UUID,
  p_budget_operation_key TEXT,p_reserved_microusd BIGINT,p_required_cap_microusd BIGINT,
  p_expected_operation_microusd BIGINT,p_policy_artifact_sha256 TEXT,p_execution_envelope_sha256 TEXT)
RETURNS TABLE(attempt_id UUID,generation BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE locked RECORD; attempt platform_egress_attempt%ROWTYPE;
BEGIN
  SELECT * INTO locked FROM lock_platform_egress_budget_v2(p_authority_id,p_schedule_id,p_workflow_id,p_workflow_run_id,
    p_operation_key,p_policy_revision,p_account_key,p_budget_operation_id,p_budget_operation_key,p_reserved_microusd,
    p_required_cap_microusd,p_expected_operation_microusd,p_policy_artifact_sha256,p_execution_envelope_sha256);
  SELECT * INTO attempt FROM platform_egress_attempt a
    WHERE a.id=p_attempt_id AND a.authority_id=p_authority_id FOR UPDATE;
  IF attempt.id IS NULL OR attempt.schedule_id IS DISTINCT FROM p_schedule_id OR attempt.workflow_id IS DISTINCT FROM p_workflow_id
    OR attempt.workflow_run_id IS DISTINCT FROM p_workflow_run_id OR attempt.operation_key IS DISTINCT FROM p_operation_key
    OR attempt.policy_revision IS DISTINCT FROM p_policy_revision OR attempt.generation IS DISTINCT FROM locked.fence_generation
    OR attempt.account_id IS DISTINCT FROM locked.account_id OR attempt.account_generation IS DISTINCT FROM locked.account_generation
    OR attempt.budget_operation_id IS DISTINCT FROM p_budget_operation_id OR attempt.budget_operation_key IS DISTINCT FROM p_budget_operation_key
    OR attempt.reserved_microusd IS DISTINCT FROM p_reserved_microusd OR locked.authority_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE='P0001';
  END IF;
  IF attempt.state <> 'AUTHORIZED' THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_ATTEMPT_REUSED' USING ERRCODE='P0001';
  END IF;
  UPDATE platform_egress_attempt a SET state='SENDING',sending_at=clock_timestamp()
    WHERE a.id=attempt.id AND a.state='AUTHORIZED' RETURNING a.id,a.generation INTO attempt_id,generation;
  IF attempt_id IS NULL THEN RAISE EXCEPTION 'PLATFORM_EGRESS_SEND_CAS_REJECTED' USING ERRCODE='P0001'; END IF;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION install_platform_egress_policy_v2(TEXT,BIGINT,TEXT,TEXT,BIGINT),
  lock_platform_egress_budget_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT)
  FROM PUBLIC,app_user,runtime_api,runtime_worker,runtime_outbox_relay,execution_budget_platform_writer;
REVOKE ALL ON FUNCTION inspect_platform_egress_policy_v2(TEXT),
  authorize_platform_egress_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT),
  claim_platform_egress_send_v2(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT)
  FROM PUBLIC,app_user,runtime_api,runtime_worker,runtime_outbox_relay,execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION inspect_platform_egress_policy_v2(TEXT),
  authorize_platform_egress_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT),
  claim_platform_egress_send_v2(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT)
  TO execution_budget_platform_writer;
REVOKE EXECUTE ON FUNCTION authorize_platform_egress_v1(UUID,TEXT,TEXT,TEXT,TEXT,TEXT),
  claim_platform_egress_send_v1(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT)
  FROM PUBLIC,app_user,runtime_api,runtime_worker,runtime_outbox_relay,execution_budget_platform_writer;
COMMIT;
