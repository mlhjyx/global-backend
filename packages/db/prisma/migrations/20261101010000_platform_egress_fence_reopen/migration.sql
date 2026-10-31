-- Audited, receipt-paired reopen of a DISABLED platform egress schedule fence.
--
-- A signed revocation disables a schedule's egress fence and advances its
-- generation. Until this migration there was no product transition back to
-- ACTIVE: install_platform_egress_policy_v2 and both send stages require
-- ACTIVE, so the only recovery was an out-of-band owner UPDATE (2026-10-31
-- dev incident). This migration adds the bounded operator transition.
--
-- The fenced automation must never lift its own fence. The function is
-- owner-only (same boundary as policy installation) and no runtime role,
-- including execution_budget_platform_writer, receives EXECUTE. The audit
-- row is append-only and structurally paired to the revocation receipt whose
-- fence event it reverses. Reopen is not revocation rollback: the receipt is
-- never modified, fence_sequence never moves, and a later revocation always
-- wins. Reopen is also not schedule resume; Temporal schedules stay paused.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.platform_egress_fence_reopen_receipt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reopen_jti UUID NOT NULL CHECK (
    reopen_jti::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  operator VARCHAR(200) NOT NULL CHECK (
    char_length(operator) BETWEEN 1 AND 200
    AND operator = btrim(operator)
    AND operator !~ '[[:cntrl:]]'),
  db_principal VARCHAR(200) NOT NULL CHECK (
    char_length(db_principal) BETWEEN 1 AND 200
    AND db_principal !~ '[[:cntrl:]]'),
  schedule_id VARCHAR(191) NOT NULL CHECK (
    schedule_id IN ('acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh')),
  fence_sequence BIGINT NOT NULL CHECK (fence_sequence > 0),
  revocation_receipt_id UUID NOT NULL,
  revocation_issuer VARCHAR(2048) NOT NULL CHECK (
    char_length(revocation_issuer) BETWEEN 1 AND 2048
    AND revocation_issuer !~ '[[:space:][:cntrl:]]'),
  revocation_jti UUID NOT NULL CHECK (
    revocation_jti::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  prior_generation BIGINT NOT NULL CHECK (
    prior_generation > 0 AND prior_generation < 9223372036854775807),
  generation BIGINT NOT NULL CHECK (generation = prior_generation + 1),
  reason_code VARCHAR(80) NOT NULL CHECK (
    reason_code IN ('POLICY_REENABLED','SECURITY_CLEARED','HOLD_RELEASED')),
  policy_artifact_sha256 VARCHAR(64),
  execution_envelope_sha256 VARCHAR(64),
  required_cap_microusd BIGINT,
  committed_at TIMESTAMPTZ(6) NOT NULL CHECK (isfinite(committed_at)),
  in_flight_attempts BIGINT NOT NULL CHECK (in_flight_attempts >= 0),
  blocked_attempts BIGINT NOT NULL CHECK (blocked_attempts >= 0),
  CONSTRAINT platform_egress_fence_reopen_receipt_revocation_fkey
    FOREIGN KEY (revocation_receipt_id) REFERENCES public.platform_revocation_receipt(id)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT platform_egress_fence_reopen_receipt_reopen_jti_key UNIQUE (reopen_jti),
  -- One revocation fence event can be reopened at most once. A later fence
  -- must carry a higher fence_sequence and therefore a new receipt.
  CONSTRAINT platform_egress_fence_reopen_receipt_schedule_sequence_key
    UNIQUE (schedule_id, fence_sequence),
  CONSTRAINT platform_egress_fence_reopen_receipt_policy_binding_check CHECK (
    num_nonnulls(policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd) = 0
    OR (num_nonnulls(policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd) = 3
      AND policy_artifact_sha256 ~ '^[0-9a-f]{64}$'
      AND execution_envelope_sha256 ~ '^[0-9a-f]{64}$'
      AND required_cap_microusd > 0))
);
COMMENT ON TABLE public.platform_egress_fence_reopen_receipt IS
  'Immutable audit of operator-approved, receipt-paired egress fence reopens. Direct DML is a policy violation; only reopen_platform_egress_fence_v1 may insert.';
COMMENT ON COLUMN public.platform_egress_fence_reopen_receipt.committed_at IS
  'Time of reopen facts inside the transaction, not PostgreSQL commit timestamp. Expose only after the caller transaction commits.';
COMMENT ON COLUMN public.platform_egress_fence_reopen_receipt.operator IS
  'Approver reference asserted by the authenticated control plane (for example an operator session plus ticket). Not a cryptographic identity proof.';
COMMENT ON COLUMN public.platform_egress_fence_reopen_receipt.db_principal IS
  'session_user that executed the transition (owner boundary fact).';

ALTER TABLE public.platform_egress_fence_reopen_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_egress_fence_reopen_receipt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_egress_fence_reopen_receipt
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,
       execution_budget_platform_writer, runtime_platform_worker;

CREATE FUNCTION public.reject_platform_egress_fence_reopen_mutation_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_RECEIPT_IMMUTABLE' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER platform_egress_fence_reopen_receipt_immutable
  BEFORE UPDATE OR DELETE ON public.platform_egress_fence_reopen_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_platform_egress_fence_reopen_mutation_v1();
CREATE TRIGGER platform_egress_fence_reopen_receipt_no_truncate
  BEFORE TRUNCATE ON public.platform_egress_fence_reopen_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_egress_fence_reopen_mutation_v1();
REVOKE ALL ON FUNCTION public.reject_platform_egress_fence_reopen_mutation_v1() FROM PUBLIC;

-- Owner-only operator transition. JOSE/identity authentication, if any, lives
-- in the control plane that calls this function; SQL independently enforces
-- the revocation pairing, the generation CAS and the append-only audit.
CREATE FUNCTION public.reopen_platform_egress_fence_v1(
  p_schedule_id TEXT,
  p_expected_generation BIGINT,
  p_fence_sequence BIGINT,
  p_revocation_issuer TEXT,
  p_revocation_jti UUID,
  p_reopen_jti UUID,
  p_operator TEXT,
  p_reason_code TEXT
)
RETURNS TABLE(
  reopen_receipt_id UUID,
  generation BIGINT,
  committed_at TIMESTAMPTZ,
  in_flight_attempts BIGINT,
  blocked_attempts BIGINT,
  replay BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  fence public.platform_egress_schedule_fence%ROWTYPE;
  revocation public.platform_revocation_receipt%ROWTYPE;
  prior public.platform_egress_fence_reopen_receipt%ROWTYPE;
  expected_reason TEXT;
  fact_time TIMESTAMPTZ;
  next_generation BIGINT;
  blocked_count BIGINT;
  inflight_count BIGINT;
BEGIN
  -- Same owner boundary as install_platform_egress_policy_v2. A runtime
  -- principal must never be able to lift the fence that constrains it.
  IF current_setting('role', true) IS DISTINCT FROM 'none'
    OR session_user IS DISTINCT FROM (
      SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
      WHERE p.oid = 'public.reopen_platform_egress_fence_v1(text,bigint,bigint,text,uuid,uuid,text,text)'::regprocedure)
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_PRINCIPAL_INVALID' USING ERRCODE = 'P0001'; END IF;

  IF p_schedule_id IS NULL
    OR p_schedule_id NOT IN ('acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh')
    OR p_expected_generation IS NULL OR p_expected_generation <= 0
    OR p_fence_sequence IS NULL OR p_fence_sequence <= 0
    OR p_revocation_issuer IS NULL OR char_length(p_revocation_issuer) NOT BETWEEN 1 AND 2048
    OR p_revocation_issuer ~ '[[:space:][:cntrl:]]'
    OR p_revocation_jti IS NULL
    OR p_revocation_jti::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_reopen_jti IS NULL
    OR p_reopen_jti::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_operator IS NULL OR char_length(p_operator) NOT BETWEEN 1 AND 200
    OR p_operator IS DISTINCT FROM btrim(p_operator)
    OR p_operator ~ '[[:cntrl:]]'
    OR p_reason_code IS NULL
    OR p_reason_code NOT IN ('POLICY_REENABLED','SECURITY_CLEARED','HOLD_RELEASED')
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_INVALID' USING ERRCODE = 'P0001'; END IF;

  -- Serialize duplicate delivery of the same command identity even if the
  -- caller binds it to different facts; exact identity is still checked below.
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-egress-fence-reopen/v1:' || p_reopen_jti::text, 0));
  SELECT * INTO prior FROM public.platform_egress_fence_reopen_receipt r
    WHERE r.reopen_jti = p_reopen_jti;
  IF prior.id IS NOT NULL THEN
    IF prior.operator IS DISTINCT FROM p_operator
      OR prior.schedule_id IS DISTINCT FROM p_schedule_id
      OR prior.fence_sequence IS DISTINCT FROM p_fence_sequence
      OR prior.revocation_issuer IS DISTINCT FROM p_revocation_issuer
      OR prior.revocation_jti IS DISTINCT FROM p_revocation_jti
      OR prior.prior_generation IS DISTINCT FROM p_expected_generation
      OR prior.reason_code IS DISTINCT FROM p_reason_code
    THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_REUSED' USING ERRCODE = 'P0001'; END IF;
    RETURN QUERY SELECT prior.id, prior.generation, prior.committed_at,
      prior.in_flight_attempts, prior.blocked_attempts, true;
    RETURN;
  END IF;

  -- Lock order: command identity -> schedule fence -> immutable receipt facts.
  SELECT * INTO fence FROM public.platform_egress_schedule_fence f
    WHERE f.schedule_id = p_schedule_id FOR UPDATE;
  IF fence.schedule_id IS NULL
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_SCHEDULE_UNKNOWN' USING ERRCODE = 'P0001'; END IF;
  IF fence.state <> 'DISABLED'
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_NOT_DISABLED' USING ERRCODE = 'P0001'; END IF;
  IF fence.generation IS DISTINCT FROM p_expected_generation
    OR fence.generation = 9223372036854775807
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_GENERATION_CONFLICT' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO revocation FROM public.platform_revocation_receipt r
    WHERE r.issuer = p_revocation_issuer AND r.revocation_jti = p_revocation_jti;
  -- The receipt must be the exact fence event that produced the current
  -- disabled state: same schedule, same sequence, same generation. A legacy
  -- unsigned fence (or any later fence) advanced generation without moving
  -- fence_sequence and therefore never matches.
  IF revocation.id IS NULL
    OR revocation.schedule_id IS DISTINCT FROM p_schedule_id
    OR revocation.fence_sequence IS DISTINCT FROM p_fence_sequence
    OR revocation.fence_sequence IS DISTINCT FROM fence.fence_sequence
    OR revocation.generation IS DISTINCT FROM fence.generation
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE' USING ERRCODE = 'P0001'; END IF;

  expected_reason := CASE revocation.reason
    WHEN 'POLICY_DISABLED' THEN 'POLICY_REENABLED'
    WHEN 'SECURITY_RESPONSE' THEN 'SECURITY_CLEARED'
    WHEN 'OPERATOR_HOLD' THEN 'HOLD_RELEASED'
  END;
  IF expected_reason IS NULL OR expected_reason IS DISTINCT FROM p_reason_code
  THEN RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_REASON_MISMATCH' USING ERRCODE = 'P0001'; END IF;

  -- Reopen does not require a published policy. authorize/claim v2 still
  -- reject a null or drifted policy, so this cannot open egress by itself;
  -- it only avoids a deadlock with install_platform_egress_policy_v2, which
  -- requires ACTIVE.
  fact_time := clock_timestamp();
  UPDATE public.platform_egress_schedule_fence f
    SET generation = f.generation + 1,
        state = 'ACTIVE',
        updated_at = fact_time
    WHERE f.schedule_id = p_schedule_id
    RETURNING f.generation INTO next_generation;

  UPDATE public.platform_egress_attempt a
    SET state = 'BLOCKED',
        outcome_meta = jsonb_build_object('reason', 'REOPEN_GENERATION_ADVANCED')
    WHERE a.schedule_id = p_schedule_id
      AND a.generation < next_generation
      AND a.state = 'AUTHORIZED';
  GET DIAGNOSTICS blocked_count = ROW_COUNT;
  SELECT count(*) INTO inflight_count FROM public.platform_egress_attempt a
    WHERE a.schedule_id = p_schedule_id AND a.state = 'SENDING';

  INSERT INTO public.platform_egress_fence_reopen_receipt(
    reopen_jti, operator, db_principal, schedule_id, fence_sequence,
    revocation_receipt_id, revocation_issuer, revocation_jti,
    prior_generation, generation, reason_code,
    policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd,
    committed_at, in_flight_attempts, blocked_attempts)
  VALUES (
    p_reopen_jti, p_operator, session_user, p_schedule_id, p_fence_sequence,
    revocation.id, revocation.issuer, revocation.revocation_jti,
    p_expected_generation, next_generation, p_reason_code,
    fence.policy_artifact_sha256, fence.execution_envelope_sha256, fence.required_cap_microusd,
    fact_time, inflight_count, blocked_count)
  RETURNING * INTO prior;

  RETURN QUERY SELECT prior.id, prior.generation, prior.committed_at,
    prior.in_flight_attempts, prior.blocked_attempts, false;
END $$;

-- No GRANT: only the function owner may execute. This is deliberately the
-- same operator boundary as install_platform_egress_policy_v2.
REVOKE ALL ON FUNCTION public.reopen_platform_egress_fence_v1(TEXT,BIGINT,BIGINT,TEXT,UUID,UUID,TEXT,TEXT)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,
       execution_budget_platform_writer, runtime_platform_worker;

-- Precise GRANT means no grant at all. The explicit list above covers the
-- known runtime principals; this loop also removes any deployment-specific
-- default or direct grant on the new function, trigger helper and table.
DO $$
DECLARE
  role_row RECORD;
  fn_signature CONSTANT TEXT :=
    'public.reopen_platform_egress_fence_v1(text,bigint,bigint,text,uuid,uuid,text,text)';
BEGIN
  FOR role_row IN
    SELECT r.rolname FROM pg_roles r
    WHERE r.rolname <> current_user AND r.rolname !~ '^pg_'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn_signature, role_row.rolname);
    EXECUTE format('REVOKE ALL ON FUNCTION public.reject_platform_egress_fence_reopen_mutation_v1() FROM %I', role_row.rolname);
    EXECUTE format('REVOKE ALL ON TABLE public.platform_egress_fence_reopen_receipt FROM %I', role_row.rolname);
  END LOOP;
END $$;

-- Migration-time self-check: any privilege drift, missing trigger or an owner
-- that cannot bypass the FORCE RLS tables fails the migration, never runtime.
DO $$
DECLARE
  fn_signature CONSTANT TEXT :=
    'public.reopen_platform_egress_fence_v1(text,bigint,bigint,text,uuid,uuid,text,text)';
  owner_bypasses_rls BOOLEAN;
  role_name TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = fn_signature::regprocedure
      AND p.prosecdef
      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_FUNCTION_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT r.rolsuper OR r.rolbypassrls INTO owner_bypasses_rls FROM pg_roles r
    WHERE r.rolname = (
      SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
      WHERE p.oid = fn_signature::regprocedure);
  IF owner_bypasses_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_OWNER_RLS_INVALID' USING ERRCODE = 'P0001';
  END IF;

  FOREACH role_name IN ARRAY ARRAY[
    'public','app_user','runtime_api','runtime_worker','runtime_outbox_relay',
    'execution_budget_platform_writer','runtime_platform_worker'
  ] LOOP
    IF has_function_privilege(role_name, fn_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_PRIVILEGE_DRIFT: %', role_name USING ERRCODE = 'P0001';
    END IF;
    IF has_table_privilege(role_name, 'public.platform_egress_fence_reopen_receipt',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_TABLE_PRIVILEGE_DRIFT: %', role_name USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = 'public.platform_egress_fence_reopen_receipt'::regclass
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_RLS_INVALID' USING ERRCODE = 'P0001';
  END IF;

  -- Enabled BEFORE UPDATE OR DELETE FOR EACH ROW (tgtype 27) and enabled
  -- BEFORE TRUNCATE FOR EACH STATEMENT (tgtype 34), both attached to the
  -- rejecting helper. A disabled or repointed trigger fails the migration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.platform_egress_fence_reopen_receipt'::regclass
      AND t.tgname = 'platform_egress_fence_reopen_receipt_immutable'
      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 27
      AND t.tgfoid = 'public.reject_platform_egress_fence_reopen_mutation_v1()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.platform_egress_fence_reopen_receipt'::regclass
      AND t.tgname = 'platform_egress_fence_reopen_receipt_no_truncate'
      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 34
      AND t.tgfoid = 'public.reject_platform_egress_fence_reopen_mutation_v1()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_TRIGGER_INVALID' USING ERRCODE = 'P0001';
  END IF;

  IF (SELECT count(*) FROM public.platform_egress_schedule_fence f
      WHERE f.schedule_id IN (
        'acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh')) <> 4 THEN
    RAISE EXCEPTION 'PLATFORM_EGRESS_REOPEN_FENCE_ROWS_INVALID' USING ERRCODE = 'P0001';
  END IF;
END $$;

COMMIT;
