BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The key remains discoverable when storage accepts a write but the operation
-- receipt transaction rolls back. Only the exact storage VersionId can settle it.
CREATE TABLE public.discovery_v3_artifact_promotion (
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('company', 'company_profile', 'contact')),
  subject_id uuid NOT NULL,
  object_key varchar(200) NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  projection jsonb NOT NULL,
  object_version_id varchar(1024) CHECK (object_version_id ~ '^[A-Za-z0-9._~+/=-]+$'),
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES public.discovery_v3_operation(workspace_id, id)
    ON DELETE CASCADE,
  CHECK (object_key = 'generic-operation-results/v1/final/personal-data/ws/' || workspace_id::text
    || '/sha256/' || left(sha256, 2) || '/' || sha256)
);
CREATE INDEX discovery_v3_artifact_promotion_subject_idx
  ON public.discovery_v3_artifact_promotion(workspace_id, subject_type, subject_id);
CREATE INDEX discovery_v3_artifact_promotion_key_idx
  ON public.discovery_v3_artifact_promotion(object_key);
ALTER TABLE public.discovery_v3_artifact_promotion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_v3_artifact_promotion FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_v3_artifact_promotion_workspace ON public.discovery_v3_artifact_promotion
  USING (workspace_id = current_workspace_id()) WITH CHECK (workspace_id = current_workspace_id());
REVOKE ALL ON TABLE public.discovery_v3_artifact_promotion FROM PUBLIC, app_user;

CREATE FUNCTION public.lock_discovery_v3_artifact_promotion_v1(
  p_workspace uuid, p_operation uuid, p_request_digest text, p_subject_type text,
  p_subject uuid, p_projection jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  reference jsonb := p_projection->'data';
  run_id uuid;
  schema_name text;
  expected_media text;
  maximum_size integer;
  body_sha256 text := reference->>'sha256';
  bound_key text;
  hold record;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user' OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace IS NULL OR p_workspace IS DISTINCT FROM current_workspace_id()
    OR p_operation IS NULL OR p_request_digest IS NULL OR p_subject IS NULL
    OR p_subject_type IS NULL OR p_subject_type NOT IN ('company', 'company_profile', 'contact')
    OR jsonb_typeof(p_projection) IS DISTINCT FROM 'object'
    OR p_projection - ARRAY['schemaVersion', 'kind', 'schema', 'data', 'digest'] <> '{}'::jsonb
    OR p_projection->>'schemaVersion' IS DISTINCT FROM 'generic-operation-projection/v1'
    OR p_projection->>'kind' IS DISTINCT FROM 'tool'
    OR p_projection->>'schema' IS DISTINCT FROM 'discovery-v3-artifact-reference/v1'
    OR NOT coalesce(p_projection->>'digest' ~ '^[0-9a-f]{64}$', false)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT operation.run_id INTO run_id FROM public.discovery_v3_operation operation
  WHERE operation.workspace_id = p_workspace AND operation.id = p_operation;
  PERFORM 1 FROM public.discovery_run run
  WHERE run.workspace_id = p_workspace AND run.id = run_id AND run.status = 'RUNNING' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT discovery_v3_artifact_result_schema_v1(operation.action) INTO schema_name
  FROM public.discovery_v3_operation operation
  WHERE operation.workspace_id = p_workspace AND operation.id = p_operation
    AND operation.request_sha256 = p_request_digest AND operation.kind = 'TOOL'
    AND operation.method = 'invoke' AND operation.provider = operation.action
    AND operation.status = 'IN_FLIGHT' AND operation.send_authorized_at IS NOT NULL
  FOR SHARE;
  SELECT supported.media, supported.maximum_size INTO expected_media, maximum_size
  FROM (VALUES
    ('crawl4ai-fetch/v1', 'text/markdown', 300000),
    ('crawl4ai-render/v1', 'text/html', 3000000),
    ('http-get/v1', 'text/plain', 3000000),
    ('contact-email-find-hunter/v1', 'application/octet-stream', 16384),
    ('contact-email-find-prospeo/v1', 'application/octet-stream', 16384)
  ) AS supported(schema, media, maximum_size) WHERE supported.schema = schema_name;
  IF maximum_size IS NULL OR (expected_media = 'application/octet-stream' AND p_subject_type <> 'contact')
    OR jsonb_typeof(reference) IS DISTINCT FROM 'object'
    OR reference - ARRAY['schemaVersion', 'artifactId', 'operationId', 'resultSchema',
      'sha256', 'sizeBytes', 'mediaType', 'expiresAt'] <> '{}'::jsonb
    OR reference->>'schemaVersion' IS DISTINCT FROM 'generic-operation-artifact-ref/v1'
    OR NOT coalesce(reference->>'artifactId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
    OR reference->>'operationId' IS DISTINCT FROM p_operation::text
    OR reference->>'resultSchema' IS DISTINCT FROM schema_name
    OR reference->>'mediaType' IS DISTINCT FROM expected_media
    OR NOT coalesce(body_sha256 ~ '^[0-9a-f]{64}$', false)
    OR NOT coalesce(reference->>'sizeBytes' ~ '^(0|[1-9][0-9]{0,6})$', false)
    OR NOT coalesce(reference->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$', false)
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF (reference->>'sizeBytes')::bigint > maximum_size
    OR (reference->>'expiresAt')::timestamptz <= clock_timestamp()
    OR (reference->>'expiresAt')::timestamptz > clock_timestamp() + interval '24 hours'
  THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-subject:' || p_workspace::text || ':' || p_subject_type || ':' || p_subject::text, 0
  ));
  PERFORM assert_workspace_generic_operation_artifact_subject_v1(p_workspace, p_subject_type, p_subject);
  SELECT * INTO hold FROM find_workspace_generic_operation_artifact_subject_execution_hold_v1(
    p_workspace, p_subject_type, p_subject);
  IF NOT FOUND OR hold.tombstoned OR hold.suppressed THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  bound_key := 'generic-operation-results/v1/final/personal-data/ws/' || p_workspace::text
    || '/sha256/' || left(body_sha256, 2) || '/' || body_sha256;
  PERFORM pg_advisory_xact_lock(hashtextextended('generic-operation-artifact-object:' || bound_key, 0));
  IF EXISTS (SELECT 1 FROM public.personal_artifact_cleanup_command cleanup WHERE cleanup.object_key = bound_key) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED' USING ERRCODE = 'P0001';
  END IF;
  RETURN bound_key;
END;
$$;

CREATE FUNCTION public.register_discovery_v3_artifact_promotion_v1(
  p_workspace uuid, p_operation uuid, p_request_digest text, p_subject_type text,
  p_subject uuid, p_projection jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE bound_key text;
BEGIN
  bound_key := lock_discovery_v3_artifact_promotion_v1(
    p_workspace, p_operation, p_request_digest, p_subject_type, p_subject, p_projection);
  INSERT INTO public.discovery_v3_artifact_promotion (
    workspace_id, operation_id, subject_type, subject_id, object_key, sha256, projection
  ) VALUES (
    p_workspace, p_operation, p_subject_type, p_subject, bound_key, p_projection#>>'{data,sha256}', p_projection
  ) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE FUNCTION public.authorize_discovery_v3_artifact_promotion_v1(
  p_workspace uuid, p_operation uuid, p_request_digest text, p_subject_type text,
  p_subject uuid, p_projection jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE bound_key text;
BEGIN
  bound_key := lock_discovery_v3_artifact_promotion_v1(
    p_workspace, p_operation, p_request_digest, p_subject_type, p_subject, p_projection);
  PERFORM 1 FROM public.discovery_v3_artifact_promotion intent
  WHERE intent.workspace_id = p_workspace AND intent.operation_id = p_operation
    AND intent.subject_type = p_subject_type AND intent.subject_id = p_subject
    AND intent.object_key = bound_key AND intent.projection = p_projection AND intent.object_version_id IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE FUNCTION public.confirm_discovery_v3_artifact_promotion_v1(
  p_workspace uuid, p_operation uuid, p_request_digest text, p_subject_type text,
  p_subject uuid, p_projection jsonb, p_version_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM authorize_discovery_v3_artifact_promotion_v1(
    p_workspace, p_operation, p_request_digest, p_subject_type, p_subject, p_projection);
  IF p_version_id IS NULL OR char_length(p_version_id) > 1024 OR p_version_id !~ '^[A-Za-z0-9._~+/=-]+$' THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.discovery_v3_artifact_promotion intent
  SET object_version_id = p_version_id
  WHERE intent.workspace_id = p_workspace AND intent.operation_id = p_operation;
END;
$$;

-- Bind append to the independently confirmed version, while retaining the
-- existing manifest, subject, and operation receipt transaction.
DO $migration$
DECLARE
  definition text := pg_get_functiondef(
    'public.append_discovery_v3_artifact_v1(uuid,uuid,text,text,uuid,jsonb,timestamptz,text,smallint,boolean,text,text,text,boolean)'::regprocedure);
  anchor text := $old$  INSERT INTO "generic_operation_artifact_object"$old$;
  proof text := $new$  IF NOT EXISTS (
    SELECT 1 FROM public.discovery_v3_artifact_promotion intent
    WHERE intent.workspace_id = p_workspace AND intent.operation_id = p_operation
      AND intent.subject_type = p_subject_type AND intent.subject_id = p_subject
      AND intent.object_key = bound_object_key AND intent.projection = p_projection
      AND intent.object_version_id = p_object_version
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO "generic_operation_artifact_object"$new$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'DISCOVERY_V3_ARTIFACT_PROMOTION_APPEND_TARGET_MISMATCH';
  END IF;
  EXECUTE replace(definition, anchor, proof);
END
$migration$;

REVOKE ALL ON FUNCTION
  public.lock_discovery_v3_artifact_promotion_v1(uuid, uuid, text, text, uuid, jsonb),
  public.register_discovery_v3_artifact_promotion_v1(uuid, uuid, text, text, uuid, jsonb),
  public.authorize_discovery_v3_artifact_promotion_v1(uuid, uuid, text, text, uuid, jsonb),
  public.confirm_discovery_v3_artifact_promotion_v1(uuid, uuid, text, text, uuid, jsonb, text)
FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION
  public.register_discovery_v3_artifact_promotion_v1(uuid, uuid, text, text, uuid, jsonb),
  public.authorize_discovery_v3_artifact_promotion_v1(uuid, uuid, text, text, uuid, jsonb),
  public.confirm_discovery_v3_artifact_promotion_v1(uuid, uuid, text, text, uuid, jsonb, text)
TO app_user;

-- A cleanup command can also identify a version proven by a promotion intent
-- before the manifest transaction, or an exact key whose write result is unknown.
ALTER TABLE public.personal_artifact_cleanup_command
  ALTER COLUMN artifact_id DROP NOT NULL,
  ALTER COLUMN object_version_id DROP NOT NULL,
  ADD COLUMN promotion_operation_id uuid,
  ADD CONSTRAINT personal_artifact_cleanup_promotion_fkey FOREIGN KEY (workspace_id, promotion_operation_id)
    REFERENCES public.discovery_v3_artifact_promotion(workspace_id, operation_id),
  ADD CONSTRAINT personal_artifact_cleanup_promotion_shape CHECK (
    (artifact_id IS NOT NULL AND promotion_operation_id IS NULL AND object_version_id IS NOT NULL)
    OR (artifact_id IS NULL AND promotion_operation_id IS NOT NULL
      AND (object_version_id IS NOT NULL OR status <> 'COMPLETED'))
  ),
  DROP CONSTRAINT personal_artifact_cleanup_command_request_object_key,
  ADD CONSTRAINT personal_artifact_cleanup_command_request_object_key
    UNIQUE NULLS NOT DISTINCT (deletion_request_id, object_key, object_version_id);

CREATE FUNCTION public.personal_artifact_subject_keys_v2(p_workspace uuid, p_type text, p_subject uuid)
RETURNS TABLE(object_key text)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT artifact.object_key::text
  FROM public.generic_operation_artifact_subject subject
  JOIN public.generic_operation_artifact artifact
    ON (artifact.scope_key, artifact.id) = (subject.scope_key, subject.artifact_id)
  WHERE (subject.workspace_id, subject.subject_type, subject.subject_id) = (p_workspace, p_type, p_subject)
    AND artifact.privacy_class = 'PERSONAL_DATA'
  UNION
  SELECT intent.object_key::text
  FROM public.discovery_v3_artifact_promotion intent
  WHERE (intent.workspace_id, intent.subject_type, intent.subject_id) = (p_workspace, p_type, p_subject);
$$;

CREATE FUNCTION public.personal_artifact_key_has_live_subject_v2(p_key text)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT subject.workspace_id, subject.subject_type, subject.subject_id
      FROM public.generic_operation_artifact artifact
      JOIN public.generic_operation_artifact_subject subject
        ON (artifact.scope_key, artifact.id) = (subject.scope_key, subject.artifact_id)
      WHERE artifact.object_key = p_key AND artifact.privacy_class = 'PERSONAL_DATA'
      UNION
      SELECT intent.workspace_id, intent.subject_type, intent.subject_id
      FROM public.discovery_v3_artifact_promotion intent
      WHERE intent.object_key = p_key
    ) AS reference
    WHERE NOT EXISTS (
      SELECT 1 FROM public.generic_operation_artifact_subject_tombstone tombstone
      WHERE (tombstone.workspace_id, tombstone.subject_type, tombstone.subject_id) =
        (reference.workspace_id, reference.subject_type, reference.subject_id)
    )
  );
$$;

CREATE FUNCTION public.personal_artifact_key_has_unknown_version_v2(p_key text)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.generic_operation_artifact_object object
    WHERE object.object_key = p_key AND object.object_version_id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.discovery_v3_artifact_promotion intent
    WHERE intent.object_key = p_key AND intent.object_version_id IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.enqueue_workspace_personal_artifact_cleanup_v1(p_workspace_id uuid, p_deletion_request_id uuid)
RETURNS TABLE(command_count integer, shared_hold_count integer, version_hold_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  audit_row public.generic_operation_artifact_subject_tombstone_audit%ROWTYPE;
  key_row record;
  inserted_count integer;
  shared_count integer;
  missing_version_count integer;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user' OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_deletion_request_id IS NULL
  THEN RAISE EXCEPTION 'PERSONAL_ARTIFACT_CLEANUP_DENIED' USING ERRCODE = 'P0001'; END IF;
  SELECT target.* INTO audit_row FROM public.generic_operation_artifact_subject_tombstone_audit target
  WHERE target.deletion_request_id = p_deletion_request_id AND target.workspace_id = p_workspace_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PERSONAL_ARTIFACT_CLEANUP_TOMBSTONE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  FOR key_row IN
    SELECT candidate.object_key
    FROM personal_artifact_subject_keys_v2(p_workspace_id, audit_row.subject_type, audit_row.subject_id) candidate
    ORDER BY candidate.object_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('generic-operation-artifact-object:' || key_row.object_key, 0));
  END LOOP;

  WITH candidates AS MATERIALIZED (
    SELECT candidate.object_key, personal_artifact_key_has_live_subject_v2(candidate.object_key) AS live,
      personal_artifact_key_has_unknown_version_v2(candidate.object_key) AS unknown_version
    FROM personal_artifact_subject_keys_v2(p_workspace_id, audit_row.subject_type, audit_row.subject_id) candidate
  ), known_manifests AS (
    SELECT artifact.object_key, min(artifact.sha256) AS sha256, min(artifact.id::text)::uuid AS artifact_id
    FROM public.generic_operation_artifact_subject subject
    JOIN public.generic_operation_artifact artifact
      ON (artifact.scope_key, artifact.id) = (subject.scope_key, subject.artifact_id)
    JOIN candidates candidate ON candidate.object_key = artifact.object_key AND NOT candidate.live
    WHERE (subject.workspace_id, subject.subject_type, subject.subject_id) =
      (p_workspace_id, audit_row.subject_type, audit_row.subject_id)
      AND artifact.privacy_class = 'PERSONAL_DATA'
    GROUP BY artifact.object_key
  ), possible_commands AS (
    SELECT manifest.object_key, manifest.sha256, manifest.artifact_id, NULL::uuid AS promotion_operation_id,
      known.object_version_id
    FROM known_manifests manifest
    JOIN LATERAL (
      SELECT ledger.object_version_id FROM public.generic_operation_artifact_object_version ledger
      WHERE ledger.object_key = manifest.object_key
      UNION
      SELECT object.object_version_id FROM public.generic_operation_artifact_object object
      WHERE object.object_key = manifest.object_key AND object.object_version_id IS NOT NULL
    ) known ON true
    UNION ALL
    SELECT intent.object_key, intent.sha256, NULL::uuid, intent.operation_id, intent.object_version_id
    FROM candidates candidate
    JOIN public.discovery_v3_artifact_promotion intent ON intent.object_key = candidate.object_key
      AND intent.workspace_id = p_workspace_id
    WHERE NOT candidate.live
  ), inserted AS (
    INSERT INTO public.personal_artifact_cleanup_command (
      workspace_id, deletion_request_id, artifact_id, promotion_operation_id, object_key, sha256, object_version_id, tombstoned_at
    )
    SELECT DISTINCT ON (command.object_key, command.object_version_id)
      p_workspace_id, p_deletion_request_id, command.artifact_id, command.promotion_operation_id,
      command.object_key, command.sha256, command.object_version_id, audit_row.tombstoned_at
    FROM possible_commands command
    ORDER BY command.object_key, command.object_version_id, command.artifact_id NULLS LAST, command.promotion_operation_id
    ON CONFLICT ON CONSTRAINT personal_artifact_cleanup_command_request_object_key DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM inserted), count(*) FILTER (WHERE candidate.live),
    count(*) FILTER (WHERE candidate.unknown_version)
  INTO inserted_count, shared_count, missing_version_count FROM candidates candidate;
  RETURN QUERY SELECT inserted_count, shared_count, missing_version_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.inspect_workspace_personal_artifact_cleanup_v1(p_workspace_id uuid, p_deletion_request_id uuid)
RETURNS TABLE(fence_committed boolean, shared_hold boolean, version_hold boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE audit_row public.generic_operation_artifact_subject_tombstone_audit%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user' OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.deletion_request request
      WHERE request.id = p_deletion_request_id AND request.workspace_id = p_workspace_id
    )
  THEN RETURN; END IF;
  SELECT target.* INTO audit_row FROM public.generic_operation_artifact_subject_tombstone_audit target
  WHERE target.deletion_request_id = p_deletion_request_id AND target.workspace_id = p_workspace_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, false, false; RETURN; END IF;
  RETURN QUERY SELECT true,
    coalesce(bool_or(personal_artifact_key_has_live_subject_v2(candidate.object_key)), false),
    coalesce(bool_or(personal_artifact_key_has_unknown_version_v2(candidate.object_key)), false)
  FROM personal_artifact_subject_keys_v2(p_workspace_id, audit_row.subject_type, audit_row.subject_id) candidate;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_workspace_personal_artifact_cleanup_v1(p_workspace_id uuid, p_deletion_request_id uuid)
RETURNS SETOF public.personal_artifact_cleanup_command
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE candidate public.personal_artifact_cleanup_command%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user' OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.generic_operation_artifact_subject_tombstone_audit audit
      WHERE audit.deletion_request_id = p_deletion_request_id AND audit.workspace_id = p_workspace_id
    )
  THEN RETURN; END IF;
  PERFORM * FROM enqueue_workspace_personal_artifact_cleanup_v1(p_workspace_id, p_deletion_request_id);
  SELECT target.* INTO candidate FROM public.personal_artifact_cleanup_command target
  WHERE target.workspace_id = p_workspace_id AND target.deletion_request_id = p_deletion_request_id
    AND target.status IN ('PENDING', 'RETRY', 'CLAIMED')
  ORDER BY (target.object_version_id IS NULL),
    CASE WHEN target.object_version_id IS NULL THEN target.claimed_at END NULLS FIRST, target.created_at, target.command_id
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('generic-operation-artifact-object:' || candidate.object_key, 0));
    IF personal_artifact_key_has_live_subject_v2(candidate.object_key) THEN RETURN; END IF;
    IF candidate.status <> 'CLAIMED' OR candidate.object_version_id IS NULL THEN
      UPDATE public.personal_artifact_cleanup_command target
      SET status = 'CLAIMED', claimed_at = statement_timestamp()
      WHERE target.command_id = candidate.command_id RETURNING target.* INTO candidate;
    END IF;
    RETURN NEXT candidate;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.personal_artifact_cleanup_command target
    WHERE target.workspace_id = p_workspace_id AND target.deletion_request_id = p_deletion_request_id
      AND target.status <> 'COMPLETED'
  ) THEN
    SELECT target.* INTO candidate FROM public.personal_artifact_cleanup_command target
    WHERE target.workspace_id = p_workspace_id AND target.deletion_request_id = p_deletion_request_id
      AND target.status = 'COMPLETED'
    ORDER BY target.completed_at DESC, target.command_id LIMIT 1;
    IF FOUND THEN RETURN NEXT candidate; END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION
  public.personal_artifact_subject_keys_v2(uuid, text, uuid),
  public.personal_artifact_key_has_live_subject_v2(text),
  public.personal_artifact_key_has_unknown_version_v2(text)
FROM PUBLIC, app_user;

COMMIT;
