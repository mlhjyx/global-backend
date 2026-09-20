-- Additive, forward-only. Historical leases stay unbound and never prove readiness.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

ALTER TABLE public.runtime_process_lease
  ADD COLUMN temporal_cluster_id VARCHAR(191),
  ADD COLUMN temporal_namespace VARCHAR(191),
  ADD COLUMN workload_kind VARCHAR(32),
  ADD COLUMN temporal_cluster_proof_digest VARCHAR(71),
  ADD COLUMN writer_principal VARCHAR(63);
ALTER TABLE public.runtime_process_lease DROP CONSTRAINT runtime_process_lease_queue_check;
ALTER TABLE public.runtime_process_lease ADD CONSTRAINT runtime_process_lease_queue_check CHECK (
  (role IN ('WORKER','PLATFORM_WORKER') AND task_queue IS NOT NULL AND char_length(task_queue) BETWEEN 1 AND 191)
  OR (role IN ('API','OUTBOX_RELAY') AND task_queue IS NULL)
);
ALTER TABLE public.runtime_process_lease ADD CONSTRAINT runtime_process_lease_namespace_shape CHECK (
  (role IN ('API','OUTBOX_RELAY','WORKER') AND temporal_cluster_id IS NULL AND temporal_namespace IS NULL
    AND workload_kind IS NULL AND temporal_cluster_proof_digest IS NULL AND writer_principal IS NULL)
  OR (role IN ('WORKER','PLATFORM_WORKER') AND temporal_cluster_id IS NOT NULL AND temporal_namespace IS NOT NULL
    AND workload_kind IS NOT NULL AND temporal_cluster_proof_digest IS NOT NULL AND writer_principal IS NOT NULL
    AND temporal_cluster_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$'
    AND temporal_cluster_proof_digest ~ '^sha256:[0-9a-f]{64}$' AND task_queue='understanding'
    AND ((role='WORKER' AND temporal_namespace='default' AND workload_kind='customer-worker')
      OR (role='PLATFORM_WORKER' AND temporal_namespace='platform-automation' AND workload_kind='platform-worker')))
);
CREATE INDEX runtime_process_lease_namespace_queue_seen_idx ON public.runtime_process_lease
  (temporal_cluster_id,temporal_namespace,task_queue,state,last_seen_at);
REVOKE ALL ON public.runtime_process_lease FROM runtime_platform_worker;
GRANT SELECT ON public.runtime_process_lease TO runtime_platform_worker;

CREATE FUNCTION public.assert_bound_worker_lease_principal(p_role public.runtime_process_role)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE principal pg_catalog.pg_roles%ROWTYPE;
DECLARE expected TEXT;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('WORKER','PLATFORM_WORKER') THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED';
  END IF;
  expected := CASE WHEN p_role='WORKER' THEN 'runtime_worker' ELSE 'runtime_platform_worker' END;
  SELECT * INTO principal FROM pg_catalog.pg_roles WHERE rolname=session_user;
  IF principal.oid IS NULL OR NOT principal.rolcanlogin OR NOT principal.rolinherit
    OR principal.rolsuper OR principal.rolbypassrls OR principal.rolcreatedb OR principal.rolcreaterole OR principal.rolreplication
    OR NOT pg_catalog.pg_has_role(session_user,expected,'member')
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=principal.oid) <> 1
  THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED'; END IF;
END $$;

CREATE FUNCTION public.lock_bound_worker_lease_queue(
  p_cluster TEXT,p_namespace TEXT,p_queue TEXT,p_instance UUID,
  p_build TEXT,p_image TEXT,p_artifact TEXT,p_proof TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.json_build_array(p_cluster,p_namespace,p_queue)::TEXT,0));
  IF EXISTS (SELECT 1 FROM public.runtime_process_lease
    WHERE instance_id<>p_instance AND temporal_cluster_id=p_cluster AND temporal_namespace=p_namespace AND task_queue=p_queue
      AND state IN ('STARTING','READY','DRAINING') AND last_seen_at>=clock_timestamp()-INTERVAL '30 seconds'
      AND (build_sha IS DISTINCT FROM p_build OR image_digest IS DISTINCT FROM p_image
        OR artifact_digest IS DISTINCT FROM p_artifact OR temporal_cluster_proof_digest IS DISTINCT FROM p_proof))
  THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_MIXED_DIGEST'; END IF;
END $$;

CREATE FUNCTION public.write_bound_worker_runtime_process_lease_v2(
  p_role public.runtime_process_role,p_instance_id UUID,p_task_queue TEXT,p_build_sha TEXT,p_image_digest TEXT,
  p_artifact_digest TEXT,p_migration_revision TEXT,p_started_at TIMESTAMPTZ,
  p_cluster TEXT,p_namespace TEXT,p_workload TEXT,p_proof TEXT,p_stopped_at TIMESTAMPTZ
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.runtime_process_lease%ROWTYPE;
DECLARE started TIMESTAMPTZ := date_trunc('milliseconds',p_started_at);
DECLARE stopped TIMESTAMPTZ := LEAST(p_stopped_at,clock_timestamp());
BEGIN
  PERFORM public.assert_bound_worker_lease_principal(p_role);
  IF p_instance_id IS NULL OR p_task_queue IS DISTINCT FROM 'understanding'
    OR p_cluster IS NULL OR p_cluster !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$'
    OR p_proof IS NULL OR p_proof !~ '^sha256:[0-9a-f]{64}$'
    OR p_namespace IS DISTINCT FROM (CASE WHEN p_role='WORKER' THEN 'default' ELSE 'platform-automation' END)
    OR p_workload IS DISTINCT FROM (CASE WHEN p_role='WORKER' THEN 'customer-worker' ELSE 'platform-worker' END)
    OR p_started_at IS NULL OR p_build_sha IS NULL OR p_image_digest IS NULL OR p_artifact_digest IS NULL
    OR p_migration_revision IS NULL OR char_length(p_migration_revision) NOT BETWEEN 1 AND 191
  THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_IDENTITY_INVALID'; END IF;
  IF started>clock_timestamp()+INTERVAL '1 minute'
    OR (p_stopped_at IS NOT NULL AND (p_stopped_at<started OR p_stopped_at>clock_timestamp()+INTERVAL '1 minute'))
  THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID'; END IF;
  IF p_stopped_at IS NULL THEN
    PERFORM public.lock_bound_worker_lease_queue(p_cluster,p_namespace,p_task_queue,p_instance_id,p_build_sha,p_image_digest,p_artifact_digest,p_proof);
  END IF;
  INSERT INTO public.runtime_process_lease(instance_id,role,state,task_queue,build_sha,image_digest,artifact_digest,migration_revision,
    started_at,last_seen_at,stopped_at,temporal_cluster_id,temporal_namespace,workload_kind,temporal_cluster_proof_digest,writer_principal)
  VALUES(p_instance_id,p_role,CASE WHEN p_stopped_at IS NULL THEN 'STARTING' ELSE 'STOPPED' END::public.runtime_process_state,
    p_task_queue,p_build_sha,p_image_digest,p_artifact_digest,p_migration_revision,started,
    CASE WHEN p_stopped_at IS NULL THEN started ELSE stopped END,CASE WHEN p_stopped_at IS NULL THEN NULL ELSE stopped END,
    p_cluster,p_namespace,p_workload,p_proof,session_user)
  ON CONFLICT(instance_id) DO NOTHING;
  SELECT * INTO v FROM public.runtime_process_lease WHERE instance_id=p_instance_id FOR UPDATE;
  IF v.role IS DISTINCT FROM p_role OR v.task_queue IS DISTINCT FROM p_task_queue
    OR v.build_sha IS DISTINCT FROM p_build_sha OR v.image_digest IS DISTINCT FROM p_image_digest
    OR v.artifact_digest IS DISTINCT FROM p_artifact_digest OR v.migration_revision IS DISTINCT FROM p_migration_revision
    OR v.started_at IS DISTINCT FROM started OR v.temporal_cluster_id IS DISTINCT FROM p_cluster
    OR v.temporal_namespace IS DISTINCT FROM p_namespace OR v.workload_kind IS DISTINCT FROM p_workload
    OR v.temporal_cluster_proof_digest IS DISTINCT FROM p_proof OR v.writer_principal IS DISTINCT FROM session_user::TEXT
  THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_IDENTITY_MISMATCH'; END IF;
  IF p_stopped_at IS NULL AND v.state='STOPPED' THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_STOPPED'; END IF;
  IF p_stopped_at IS NOT NULL AND v.state<>'STOPPED' THEN
    IF stopped<v.last_seen_at THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID'; END IF;
    UPDATE public.runtime_process_lease SET state='STOPPED',last_seen_at=stopped,stopped_at=stopped WHERE id=v.id;
  END IF;
  RETURN v.id;
END $$;

CREATE FUNCTION public.register_worker_runtime_process_lease_v2(
  p_instance_id UUID,p_task_queue TEXT,p_build_sha TEXT,p_image_digest TEXT,p_artifact_digest TEXT,p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ,p_cluster TEXT,p_namespace TEXT,p_workload TEXT,p_proof TEXT
) RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.write_bound_worker_runtime_process_lease_v2('WORKER',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)
$$;
CREATE FUNCTION public.register_platform_worker_runtime_process_lease_v2(
  p_instance_id UUID,p_task_queue TEXT,p_build_sha TEXT,p_image_digest TEXT,p_artifact_digest TEXT,p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ,p_cluster TEXT,p_namespace TEXT,p_workload TEXT,p_proof TEXT
) RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.write_bound_worker_runtime_process_lease_v2('PLATFORM_WORKER',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)
$$;
CREATE FUNCTION public.terminalize_worker_runtime_process_lease_v2(
  p_instance_id UUID,p_task_queue TEXT,p_build_sha TEXT,p_image_digest TEXT,p_artifact_digest TEXT,p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ,p_stopped_at TIMESTAMPTZ,p_cluster TEXT,p_namespace TEXT,p_workload TEXT,p_proof TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_stopped_at IS NULL THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID'; END IF;
  RETURN public.write_bound_worker_runtime_process_lease_v2('WORKER',$1,$2,$3,$4,$5,$6,$7,$9,$10,$11,$12,$8);
END
$$;
CREATE FUNCTION public.terminalize_platform_worker_runtime_process_lease_v2(
  p_instance_id UUID,p_task_queue TEXT,p_build_sha TEXT,p_image_digest TEXT,p_artifact_digest TEXT,p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ,p_stopped_at TIMESTAMPTZ,p_cluster TEXT,p_namespace TEXT,p_workload TEXT,p_proof TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_stopped_at IS NULL THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID'; END IF;
  RETURN public.write_bound_worker_runtime_process_lease_v2('PLATFORM_WORKER',$1,$2,$3,$4,$5,$6,$7,$9,$10,$11,$12,$8);
END
$$;

CREATE FUNCTION public.heartbeat_bound_worker_runtime_process_lease(
  p_role public.runtime_process_role,p_instance_id UUID,p_state public.runtime_process_state,p_last_seen_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.runtime_process_lease%ROWTYPE;
BEGIN
  PERFORM public.assert_bound_worker_lease_principal(p_role);
  SELECT * INTO v FROM public.runtime_process_lease WHERE instance_id=p_instance_id;
  IF v.id IS NULL OR v.role IS DISTINCT FROM p_role OR v.temporal_cluster_id IS NULL OR v.temporal_namespace IS NULL
    OR v.workload_kind IS NULL OR v.temporal_cluster_proof_digest IS NULL OR v.writer_principal IS DISTINCT FROM session_user::TEXT
  THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_UNBOUND_ROLE_DENIED'; END IF;
  IF p_state IS NULL OR p_last_seen_at IS NULL THEN RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID'; END IF;
  IF p_state<>'STOPPED' THEN
    PERFORM public.lock_bound_worker_lease_queue(v.temporal_cluster_id,v.temporal_namespace,v.task_queue,v.instance_id,
      v.build_sha,v.image_digest,v.artifact_digest,v.temporal_cluster_proof_digest);
  END IF;
  PERFORM public.heartbeat_runtime_process_lease(p_instance_id,p_state,p_last_seen_at);
END $$;
CREATE OR REPLACE FUNCTION public.heartbeat_worker_runtime_process_lease(
  p_instance_id UUID,p_state public.runtime_process_state,p_last_seen_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.heartbeat_bound_worker_runtime_process_lease('WORKER',$1,$2,$3)
$$;
CREATE FUNCTION public.heartbeat_platform_worker_runtime_process_lease(
  p_instance_id UUID,p_state public.runtime_process_state,p_last_seen_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.heartbeat_bound_worker_runtime_process_lease('PLATFORM_WORKER',$1,$2,$3)
$$;

REVOKE ALL ON FUNCTION public.assert_bound_worker_lease_principal(public.runtime_process_role),
  public.lock_bound_worker_lease_queue(TEXT,TEXT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT),
  public.write_bound_worker_runtime_process_lease_v2(public.runtime_process_role,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ),
  public.heartbeat_bound_worker_runtime_process_lease(public.runtime_process_role,UUID,public.runtime_process_state,TIMESTAMPTZ),
  public.register_worker_runtime_process_lease_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT),
  public.register_platform_worker_runtime_process_lease_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT),
  public.terminalize_worker_runtime_process_lease_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT),
  public.terminalize_platform_worker_runtime_process_lease_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT),
  public.heartbeat_worker_runtime_process_lease(UUID,public.runtime_process_state,TIMESTAMPTZ),
  public.heartbeat_platform_worker_runtime_process_lease(UUID,public.runtime_process_state,TIMESTAMPTZ)
FROM PUBLIC,app_user,runtime_api,runtime_worker,runtime_outbox_relay,runtime_platform_worker;
GRANT EXECUTE ON FUNCTION
  public.register_worker_runtime_process_lease_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT),
  public.terminalize_worker_runtime_process_lease_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT),
  public.heartbeat_worker_runtime_process_lease(UUID,public.runtime_process_state,TIMESTAMPTZ)
TO runtime_worker;
GRANT EXECUTE ON FUNCTION
  public.register_platform_worker_runtime_process_lease_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT),
  public.terminalize_platform_worker_runtime_process_lease_v2(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TEXT,TEXT),
  public.heartbeat_platform_worker_runtime_process_lease(UUID,public.runtime_process_state,TIMESTAMPTZ)
TO runtime_platform_worker;
-- Historical rows/functions remain, but the old worker signatures cannot bypass v2 bindings.
REVOKE ALL ON FUNCTION
  public.register_worker_runtime_process_lease(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ),
  public.terminalize_worker_runtime_process_lease(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ)
FROM PUBLIC,app_user,runtime_api,runtime_worker,runtime_outbox_relay,runtime_platform_worker;
COMMIT;
