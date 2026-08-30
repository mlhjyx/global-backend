-- Product-neutral governed subject erasure fence primitive.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.tombstone_workspace_governed_subject_v1(
  p_workspace_id UUID,
  p_governed_subject_id UUID,
  p_deletion_request_id UUID
)
RETURNS TABLE(
  governed_subject_id UUID,
  tombstoned_at TIMESTAMPTZ,
  audit_id UUID,
  outcome VARCHAR(48)
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $tombstone$
DECLARE
  subject_row public.governed_subject%ROWTYPE;
  request_row public.deletion_request%ROWTYPE;
  audit_row public.governed_subject_tombstone_audit%ROWTYPE;
  fence_row public.governed_subject_tombstone%ROWTYPE;
  operation_row RECORD;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR p_governed_subject_id IS NULL
    OR p_deletion_request_id IS NULL
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO subject_row
  FROM public.governed_subject target
  WHERE target.workspace_id = p_workspace_id
    AND target.id = p_governed_subject_id;
  IF NOT FOUND
    OR subject_row.data_class IS DISTINCT FROM 'PERSONAL'
    OR subject_row.dsr_subject_type IS NULL
    OR subject_row.dsr_subject_id IS NULL
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-subject:' || p_workspace_id::text || ':' ||
      subject_row.dsr_subject_type || ':' || subject_row.dsr_subject_id::text,
    0
  ));

  FOR operation_row IN
    SELECT candidate.operation_id
    FROM (
      SELECT operation.operation_id
      FROM public.tool_operation_subject operation
      WHERE operation.workspace_id = p_workspace_id
        AND operation.subject_id = p_governed_subject_id
      UNION
      SELECT relation.operation_id
      FROM public.governed_subject_relation relation
      WHERE relation.workspace_id = p_workspace_id
        AND (
          relation.operation_subject_id = p_governed_subject_id
          OR relation.parent_subject_id = p_governed_subject_id
          OR relation.child_subject_id = p_governed_subject_id
        )
    ) candidate
    ORDER BY candidate.operation_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'governed-subject-relation:' || p_workspace_id::text || ':' ||
        operation_row.operation_id::text,
      0
    ));
  END LOOP;

  SELECT target.* INTO subject_row
  FROM public.governed_subject target
  WHERE target.workspace_id = p_workspace_id
    AND target.id = p_governed_subject_id;
  IF NOT FOUND
    OR subject_row.data_class IS DISTINCT FROM 'PERSONAL'
    OR subject_row.dsr_subject_type IS NULL
    OR subject_row.dsr_subject_id IS NULL
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO request_row
  FROM public.deletion_request target
  WHERE target.id = p_deletion_request_id
    AND target.workspace_id = p_workspace_id
    AND target.subject_type = subject_row.dsr_subject_type
    AND target.subject_id = subject_row.dsr_subject_id
    AND target.status IN ('RECEIVED', 'FROZEN', 'ERASING', 'COMPLETED')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO audit_row
  FROM public.governed_subject_tombstone_audit target
  WHERE target.deletion_request_id = p_deletion_request_id;
  IF FOUND THEN
    IF audit_row.workspace_id IS DISTINCT FROM p_workspace_id
      OR audit_row.governed_subject_id IS DISTINCT FROM p_governed_subject_id
    THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT audit_row.governed_subject_id, audit_row.tombstoned_at,
      audit_row.deletion_request_id, 'REPLAYED'::VARCHAR(48);
    RETURN;
  END IF;

  SELECT target.* INTO fence_row
  FROM public.governed_subject_tombstone target
  WHERE target.workspace_id = p_workspace_id
    AND target.governed_subject_id = p_governed_subject_id;
  IF FOUND THEN
    INSERT INTO public.governed_subject_tombstone_audit(
      deletion_request_id, workspace_id, governed_subject_id, tombstoned_at
    ) VALUES (
      p_deletion_request_id, p_workspace_id, p_governed_subject_id,
      fence_row.tombstoned_at
    ) RETURNING * INTO audit_row;
    RETURN QUERY SELECT p_governed_subject_id, fence_row.tombstoned_at,
      audit_row.deletion_request_id,
      'AUDIT_APPENDED_WITH_EXISTING_FENCE'::VARCHAR(48);
    RETURN;
  END IF;

  INSERT INTO public.governed_subject_tombstone(
    workspace_id, governed_subject_id
  ) VALUES (
    p_workspace_id, p_governed_subject_id
  ) RETURNING * INTO fence_row;
  INSERT INTO public.governed_subject_tombstone_audit(
    deletion_request_id, workspace_id, governed_subject_id, tombstoned_at
  ) VALUES (
    p_deletion_request_id, p_workspace_id, p_governed_subject_id,
    fence_row.tombstoned_at
  ) RETURNING * INTO audit_row;
  RETURN QUERY SELECT p_governed_subject_id, fence_row.tombstoned_at,
    audit_row.deletion_request_id, 'FENCE_CREATED'::VARCHAR(48);
END
$tombstone$;

REVOKE ALL ON FUNCTION public.tombstone_workspace_governed_subject_v1(UUID,UUID,UUID)
FROM PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION public.tombstone_workspace_governed_subject_v1(UUID,UUID,UUID)
TO app_user;

COMMIT;
