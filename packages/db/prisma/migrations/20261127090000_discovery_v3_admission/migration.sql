ALTER TABLE public.discovery_run
  ADD COLUMN execution_contract_version integer NOT NULL DEFAULT 2,
  ADD COLUMN v3_attempt_id uuid,
  ADD COLUMN v3_request_sha256 varchar(64),
  ADD COLUMN v3_requested_by varchar(256),
  ADD COLUMN v3_first_admission boolean,
  ADD COLUMN v3_task_queue varchar(128),
  ADD COLUMN v3_manufacturer_revision varchar(32),
  ADD COLUMN v3_admitted_at timestamptz(3),
  ADD COLUMN v3_dispatch_expires_at timestamptz(3),
  ADD COLUMN v3_worker_accepted_at timestamptz(3),
  ADD CONSTRAINT discovery_run_execution_contract_check CHECK (
    (execution_contract_version = 2 AND v3_attempt_id IS NULL AND v3_request_sha256 IS NULL
      AND v3_requested_by IS NULL AND v3_first_admission IS NULL AND v3_task_queue IS NULL AND v3_manufacturer_revision IS NULL
      AND v3_admitted_at IS NULL AND v3_dispatch_expires_at IS NULL AND v3_worker_accepted_at IS NULL)
    OR
    (execution_contract_version = 3 AND v3_attempt_id IS NOT NULL AND v3_request_sha256 IS NOT NULL
      AND v3_request_sha256 ~ '^[0-9a-f]{64}$' AND v3_requested_by IS NOT NULL
      AND v3_first_admission IS NOT NULL AND v3_task_queue IS NOT NULL AND length(v3_task_queue) > 0
      AND (v3_manufacturer_revision IS NULL OR v3_manufacturer_revision IN ('manufacturer-network/v1', 'manufacturer-network/v2'))
      AND v3_admitted_at IS NOT NULL AND v3_dispatch_expires_at IS NOT NULL
      AND v3_dispatch_expires_at = v3_admitted_at + interval '180 minutes'
      AND (v3_worker_accepted_at IS NULL OR v3_worker_accepted_at < v3_dispatch_expires_at))
  );

CREATE UNIQUE INDEX discovery_run_v3_attempt_key
  ON public.discovery_run (workspace_id, plan_id, v3_attempt_id);
CREATE UNIQUE INDEX discovery_run_v3_first_key
  ON public.discovery_run (workspace_id, plan_id)
  WHERE v3_first_admission IS TRUE;

CREATE FUNCTION public.attest_discovery_v3_outbox(p_event_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_outbox_relay_worker', 'MEMBER')
    OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'DISCOVERY_V3_OUTBOX_ATTEST_DENIED' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.outbox_event AS event
    JOIN public.discovery_run AS run
      ON run.workspace_id = event.workspace_id AND run.id::text = event.aggregate_id::text
    WHERE event.event_id = p_event_id AND event.event_type = 'DiscoveryRunRequested'
      AND event.schema_version = 3 AND event.aggregate_type = 'DiscoveryRun'
      AND run.execution_contract_version = 3
      AND event.payload->>'workspaceId' = run.workspace_id::text
      AND event.payload->>'runId' = run.id::text
      AND event.payload->>'planId' = run.plan_id::text
      AND event.payload->>'icpId' = run.icp_id::text
      AND event.payload->>'attemptId' = run.v3_attempt_id::text
      AND event.payload->>'requestSha256' = run.v3_request_sha256
      AND event.payload->>'taskQueue' = run.v3_task_queue
      AND (event.payload->>'manufacturerNetworkRevision') IS NOT DISTINCT FROM run.v3_manufacturer_revision
      AND event.payload->>'dispatchExpiresAt' = to_char(run.v3_dispatch_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END
$$;
REVOKE ALL ON FUNCTION public.attest_discovery_v3_outbox(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attest_discovery_v3_outbox(uuid) TO runtime_outbox_relay_worker;

CREATE FUNCTION public.freeze_discovery_v3_admission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.execution_contract_version IS DISTINCT FROM NEW.execution_contract_version
     OR (OLD.execution_contract_version = 3 AND (
       NEW.id, NEW.workspace_id, NEW.plan_id, NEW.icp_id, NEW.task_ref, NEW.v3_attempt_id,
       NEW.v3_request_sha256, NEW.v3_requested_by, NEW.v3_first_admission, NEW.v3_task_queue,
       NEW.v3_manufacturer_revision, NEW.v3_admitted_at, NEW.v3_dispatch_expires_at
     ) IS DISTINCT FROM (
       OLD.id, OLD.workspace_id, OLD.plan_id, OLD.icp_id, OLD.task_ref, OLD.v3_attempt_id,
       OLD.v3_request_sha256, OLD.v3_requested_by, OLD.v3_first_admission, OLD.v3_task_queue,
       OLD.v3_manufacturer_revision, OLD.v3_admitted_at, OLD.v3_dispatch_expires_at
     ))
  THEN
    RAISE EXCEPTION 'DISCOVERY_V3_ADMISSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER freeze_discovery_v3_admission BEFORE UPDATE ON public.discovery_run
  FOR EACH ROW EXECUTE FUNCTION public.freeze_discovery_v3_admission();

CREATE INDEX discovery_run_v3_queued_expiry_idx ON public.discovery_run (v3_dispatch_expires_at)
  WHERE execution_contract_version = 3 AND status = 'QUEUED';

CREATE OR REPLACE FUNCTION public.list_stale_discovery_runs_v1(
  p_stale_after_ms double precision,
  p_limit integer
)
RETURNS TABLE(workspace_id uuid, run_id uuid, plan_id uuid, icp_id uuid, created_at timestamp(3))
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_stale_after_ms IS NULL OR p_stale_after_ms < 0 OR p_stale_after_ms > 604800000
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'DISCOVERY_STALE_RUN_LIST_DENIED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT run.workspace_id, run.id, run.plan_id, run.icp_id, run.created_at
  FROM public.discovery_run AS run
  WHERE (run.execution_contract_version = 2 AND run.status = 'RUNNING'
    AND run.created_at < (statement_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => p_stale_after_ms / 1000.0))
  OR (run.execution_contract_version = 3 AND (
    (run.status = 'QUEUED' AND run.v3_dispatch_expires_at <= statement_timestamp() + interval '10 minutes')
    OR (run.status = 'RUNNING' AND run.created_at <= (statement_timestamp() AT TIME ZONE 'UTC') - interval '215 minutes')
  ))
  ORDER BY run.created_at LIMIT p_limit;
END
$$;
