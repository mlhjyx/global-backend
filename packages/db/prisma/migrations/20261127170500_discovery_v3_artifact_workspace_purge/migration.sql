BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  writer text := pg_get_functiondef(
    'public.lock_discovery_v3_artifact_promotion_v1(uuid,uuid,text,text,uuid,jsonb)'::regprocedure);
  purge text := pg_get_functiondef('public.purge_workspace_tenant_data_v1(uuid)'::regprocedure);
  writer_anchor text := $old$  SELECT operation.run_id INTO run_id FROM public.discovery_v3_operation operation$old$;
  writer_fence text := $new$  PERFORM pg_advisory_xact_lock_shared(hashtextextended('discovery-v3-artifact-workspace:' || p_workspace::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.workspace_purge_receipt purge_receipt
    WHERE purge_receipt.workspace_id = p_workspace AND purge_receipt.status IN ('PENDING', 'RUNNING', 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT operation.run_id INTO run_id FROM public.discovery_v3_operation operation$new$;
  purge_fence_anchor text := $old$  v_nonce := gen_random_uuid();$old$;
  purge_fence text := $new$  PERFORM pg_advisory_xact_lock(hashtextextended('discovery-v3-artifact-workspace:' || p_workspace_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.discovery_v3_artifact_promotion intent
    WHERE intent.workspace_id = p_workspace_id AND intent.object_version_id IS NULL
  ) THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_ARTIFACT_PROMOTION_UNRESOLVED' USING ERRCODE = 'P0001';
  END IF;

  v_nonce := gen_random_uuid();$new$;
  purge_manifest_anchor text := $old$  DELETE FROM public."discovery_run" WHERE "workspace_id" = p_workspace_id;$old$;
  purge_manifest text := $new$  -- Preserve known versions from interrupted receipts in the existing storage manifest.
  SELECT coalesce(jsonb_agg(DISTINCT item), '[]'::jsonb) INTO v_personal_objects
  FROM (
    SELECT item FROM jsonb_array_elements(v_personal_objects) AS known(item)
    UNION ALL
    SELECT jsonb_build_object('objectKey', intent.object_key, 'sha256', intent.sha256,
      'versionId', intent.object_version_id, 'objectScope', 'workspace')
    FROM public.discovery_v3_artifact_promotion intent
    WHERE intent.workspace_id = p_workspace_id AND intent.object_version_id IS NOT NULL
  ) AS candidates;

  DELETE FROM public."discovery_run" WHERE "workspace_id" = p_workspace_id;$new$;
BEGIN
  IF length(writer) - length(replace(writer, writer_anchor, '')) <> length(writer_anchor)
    OR length(purge) - length(replace(purge, purge_fence_anchor, '')) <> length(purge_fence_anchor)
    OR length(purge) - length(replace(purge, purge_manifest_anchor, '')) <> length(purge_manifest_anchor) THEN
    RAISE EXCEPTION 'DISCOVERY_V3_ARTIFACT_WORKSPACE_PURGE_TARGET_MISMATCH';
  END IF;
  EXECUTE replace(writer, writer_anchor, writer_fence);
  EXECUTE replace(replace(purge, purge_fence_anchor, purge_fence), purge_manifest_anchor, purge_manifest);
END
$migration$;

COMMIT;
