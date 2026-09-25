-- G3 (spec 2026-09-24 §4.1): pre-wire admission for subject-bound
-- PERSONAL_DATA artifact producers. Additive, forward-only.
--
-- app_user has no table privilege on the subject tombstone tables (see
-- 20260824110000). This owner-defined reader returns only two booleans for
-- one exact workspace subject and applies the same app_user/workspace guard
-- as the other v1 subject functions. A guard failure returns zero rows, which
-- the caller treats as fail-closed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION find_workspace_generic_operation_artifact_subject_execution_hold_v1(
  p_workspace_id UUID, p_subject_type TEXT, p_subject_id UUID
)
RETURNS TABLE(tombstoned BOOLEAN, suppressed BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
    OR p_subject_type NOT IN ('contact', 'company')
    OR p_subject_id IS NULL
  THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT
    EXISTS (
      SELECT 1 FROM "generic_operation_artifact_subject_tombstone" tombstone
      WHERE tombstone."workspace_id" = p_workspace_id
        AND tombstone."subject_type" = p_subject_type
        AND tombstone."subject_id" = p_subject_id
    ),
    EXISTS (
      SELECT 1 FROM "canonical_company" company
      WHERE company."workspace_id" = p_workspace_id
        AND company."status" = 'SUPPRESSED'
        AND company."id" = CASE p_subject_type
          WHEN 'company' THEN p_subject_id
          ELSE (
            SELECT contact."company_id" FROM "canonical_contact" contact
            WHERE contact."workspace_id" = p_workspace_id
              AND contact."id" = p_subject_id
          )
        END
    );
END
$$;

REVOKE ALL ON FUNCTION
  find_workspace_generic_operation_artifact_subject_execution_hold_v1(UUID, TEXT, UUID)
FROM PUBLIC, app_user, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION
  find_workspace_generic_operation_artifact_subject_execution_hold_v1(UUID, TEXT, UUID)
TO app_user;

COMMIT;
