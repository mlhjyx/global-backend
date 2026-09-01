BEGIN;

CREATE FUNCTION terminalize_runtime_process_lease(
  p_instance_id UUID,
  p_role "runtime_process_role",
  p_task_queue TEXT,
  p_build_sha TEXT,
  p_image_digest TEXT,
  p_artifact_digest TEXT,
  p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ,
  p_stopped_at TIMESTAMPTZ
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v "runtime_process_lease"%ROWTYPE;
DECLARE terminal_time TIMESTAMPTZ;
BEGIN
  IF p_stopped_at < p_started_at OR p_stopped_at > clock_timestamp() + INTERVAL '1 minute' THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID';
  END IF;
  terminal_time := LEAST(p_stopped_at, clock_timestamp());
  INSERT INTO "runtime_process_lease"(
    "instance_id","role","state","task_queue","build_sha","image_digest",
    "artifact_digest","migration_revision","started_at","last_seen_at","stopped_at"
  ) VALUES(
    p_instance_id,p_role,'STOPPED',p_task_queue,p_build_sha,p_image_digest,
    p_artifact_digest,p_migration_revision,p_started_at,terminal_time,terminal_time
  ) ON CONFLICT ("instance_id") DO NOTHING;
  SELECT * INTO v
    FROM "runtime_process_lease"
   WHERE "instance_id" = p_instance_id
   FOR UPDATE;
  IF v."role" IS DISTINCT FROM p_role
    OR v."task_queue" IS DISTINCT FROM p_task_queue
    OR v."build_sha" IS DISTINCT FROM p_build_sha
    OR v."image_digest" IS DISTINCT FROM p_image_digest
    OR v."artifact_digest" IS DISTINCT FROM p_artifact_digest
    OR v."migration_revision" IS DISTINCT FROM p_migration_revision
    OR v."started_at" IS DISTINCT FROM p_started_at
  THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_IDENTITY_MISMATCH';
  ELSIF v."state" <> 'STOPPED' THEN
    IF terminal_time < v."last_seen_at" THEN
      RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_TIME_INVALID';
    END IF;
    UPDATE "runtime_process_lease"
       SET "state" = 'STOPPED',
           "last_seen_at" = terminal_time,
           "stopped_at" = terminal_time
     WHERE "id" = v."id"
     RETURNING * INTO v;
  END IF;
  RETURN v."id";
END $$;

CREATE FUNCTION terminalize_api_runtime_process_lease(
  p_instance_id UUID, p_task_queue TEXT, p_build_sha TEXT,
  p_image_digest TEXT, p_artifact_digest TEXT, p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ, p_stopped_at TIMESTAMPTZ
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_api', 'member') OR p_task_queue IS NOT NULL THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED';
  END IF;
  RETURN terminalize_runtime_process_lease(
    p_instance_id,'API',NULL,p_build_sha,p_image_digest,p_artifact_digest,
    p_migration_revision,p_started_at,p_stopped_at
  );
END $$;

CREATE FUNCTION terminalize_worker_runtime_process_lease(
  p_instance_id UUID, p_task_queue TEXT, p_build_sha TEXT,
  p_image_digest TEXT, p_artifact_digest TEXT, p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ, p_stopped_at TIMESTAMPTZ
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_worker', 'member') OR p_task_queue IS NULL THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED';
  END IF;
  RETURN terminalize_runtime_process_lease(
    p_instance_id,'WORKER',p_task_queue,p_build_sha,p_image_digest,p_artifact_digest,
    p_migration_revision,p_started_at,p_stopped_at
  );
END $$;

CREATE FUNCTION terminalize_outbox_relay_runtime_process_lease(
  p_instance_id UUID, p_task_queue TEXT, p_build_sha TEXT,
  p_image_digest TEXT, p_artifact_digest TEXT, p_migration_revision TEXT,
  p_started_at TIMESTAMPTZ, p_stopped_at TIMESTAMPTZ
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'runtime_outbox_relay', 'member') OR p_task_queue IS NOT NULL THEN
    RAISE EXCEPTION 'RUNTIME_PROCESS_LEASE_ROLE_DENIED';
  END IF;
  RETURN terminalize_runtime_process_lease(
    p_instance_id,'OUTBOX_RELAY',NULL,p_build_sha,p_image_digest,p_artifact_digest,
    p_migration_revision,p_started_at,p_stopped_at
  );
END $$;

REVOKE ALL ON FUNCTION terminalize_runtime_process_lease(
  UUID,"runtime_process_role",TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION terminalize_api_runtime_process_lease(
  UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ
), terminalize_worker_runtime_process_lease(
  UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ
), terminalize_outbox_relay_runtime_process_lease(
  UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION terminalize_runtime_process_lease(
  UUID,"runtime_process_role",TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ
) FROM app_user, runtime_api, runtime_worker, runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION terminalize_api_runtime_process_lease(
  UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ
) TO runtime_api;
GRANT EXECUTE ON FUNCTION terminalize_worker_runtime_process_lease(
  UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ
) TO runtime_worker;
GRANT EXECUTE ON FUNCTION terminalize_outbox_relay_runtime_process_lease(
  UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TIMESTAMPTZ
) TO runtime_outbox_relay;

COMMIT;
