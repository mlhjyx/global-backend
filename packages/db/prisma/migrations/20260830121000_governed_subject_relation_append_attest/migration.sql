BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public._governed_relation_assert_caller_v1(
  p_workspace_id UUID
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $caller$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
END
$caller$;

CREATE FUNCTION public._governed_relation_assert_operation_v1(
  p_workspace_id UUID,
  p_authority_id UUID,
  p_account_id UUID,
  p_operation_id UUID,
  p_operation_generation INTEGER,
  p_ack_id CHAR(64),
  p_result_digest CHAR(64)
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $operation$
BEGIN
  PERFORM 1
  FROM execution_budget_authority authority
  JOIN tool_budget_account account
    ON account.scope_key = authority.scope_key
   AND account.authority_id = authority.id
  JOIN tool_budget_operation operation
    ON operation.scope_key = account.scope_key
   AND operation.account_id = account.id
  JOIN execution_domain_ack ack
    ON ack.scope_key = operation.scope_key
   AND ack.operation_id = operation.id
   AND ack.account_id = account.id
   AND ack.authority_id = authority.id
  LEFT JOIN execution_budget_authority_revocation revocation
    ON revocation.scope_key = authority.scope_key
   AND revocation.authority_id = authority.id
  WHERE authority.scope_key = p_workspace_id::text
    AND authority.workspace_id = p_workspace_id
    AND authority.id = p_authority_id
    AND authority.consumed_at IS NOT NULL
    AND authority.revoked_at IS NULL
    AND account.id = p_account_id
    AND account.generation = p_operation_generation
    AND operation.id = p_operation_id
    AND operation.generation = p_operation_generation
    AND operation.status = 'SETTLED'
    AND operation.result_digest = p_result_digest
    AND ack.ack_id = p_ack_id
    AND ack.result_digest = p_result_digest
    AND revocation.authority_id IS NULL;
  IF NOT FOUND THEN
    PERFORM 1 FROM execution_budget_authority_revocation revocation
    WHERE revocation.scope_key = p_workspace_id::text
      AND revocation.authority_id = p_authority_id;
    IF FOUND THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_AUTHORITY_REVOKED' USING ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM execution_budget_authority authority
    WHERE authority.scope_key = p_workspace_id::text
      AND authority.id = p_authority_id
      AND authority.revoked_at IS NOT NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_AUTHORITY_REVOKED' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
END
$operation$;

CREATE FUNCTION public._governed_relation_assert_path_v1(
  p_workspace_id UUID,
  p_operation_id UUID,
  p_operation_subject_id UUID,
  p_parent_subject_id UUID,
  p_child_subject_id UUID
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $path$
BEGIN
  PERFORM 1
  FROM governed_subject_tombstone tombstone
  LEFT JOIN public.governed_subject_relation parent_edge
    ON parent_edge.workspace_id = tombstone.workspace_id
   AND parent_edge.operation_id = p_operation_id
   AND parent_edge.parent_subject_id = tombstone.governed_subject_id
  LEFT JOIN public.governed_subject_relation child_edge
    ON child_edge.workspace_id = tombstone.workspace_id
   AND child_edge.operation_id = p_operation_id
   AND child_edge.child_subject_id = tombstone.governed_subject_id
  WHERE tombstone.workspace_id = p_workspace_id
    AND COALESCE(
      parent_edge.operation_id,
      child_edge.operation_id,
      CASE WHEN tombstone.governed_subject_id = p_operation_subject_id
        THEN p_operation_id END,
      CASE WHEN tombstone.governed_subject_id = p_parent_subject_id
        THEN p_operation_id END,
      CASE WHEN tombstone.governed_subject_id = p_child_subject_id
        THEN p_operation_id END
    ) = p_operation_id;
  IF FOUND THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_TOMBSTONED' USING ERRCODE = 'P0001';
  END IF;
END
$path$;

CREATE FUNCTION public._governed_relation_lock_personal_path_v1(
  p_workspace_id UUID,
  p_operation_id UUID,
  p_parent_subject_id UUID,
  p_child_data_class VARCHAR(16),
  p_child_dsr_subject_type VARCHAR(191),
  p_child_dsr_subject_id UUID
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $personal$
DECLARE
  locked_subject RECORD;
  path_subject public.governed_subject%ROWTYPE;
  current_subject UUID;
  next_subject UUID;
BEGIN
  FOR locked_subject IN
    SELECT DISTINCT subject.dsr_subject_type, subject.dsr_subject_id
    FROM public.governed_subject subject
    LEFT JOIN public.governed_subject_relation parent_edge
      ON parent_edge.workspace_id = subject.workspace_id
     AND parent_edge.parent_subject_id = subject.id
     AND parent_edge.operation_id = p_operation_id
    LEFT JOIN public.governed_subject_relation child_edge
      ON child_edge.workspace_id = subject.workspace_id
     AND child_edge.child_subject_id = subject.id
     AND child_edge.operation_id = p_operation_id
    WHERE subject.workspace_id = p_workspace_id
      AND subject.data_class = 'PERSONAL'
      AND COALESCE(parent_edge.operation_id, child_edge.operation_id) = p_operation_id
    UNION
    SELECT p_child_dsr_subject_type, p_child_dsr_subject_id
    WHERE p_child_data_class = 'PERSONAL'
    ORDER BY 1, 2
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'generic-operation-artifact-subject:' || p_workspace_id::text || ':' ||
      locked_subject.dsr_subject_type || ':' || locked_subject.dsr_subject_id::text,
      0
    ));
  END LOOP;

  current_subject := p_parent_subject_id;
  LOOP
    SELECT subject.* INTO path_subject
    FROM public.governed_subject subject
    WHERE subject.workspace_id = p_workspace_id
      AND subject.id = current_subject;
    IF path_subject.data_class = 'PERSONAL' THEN
      PERFORM 1 FROM public.generic_operation_artifact_subject_tombstone tombstone
      WHERE tombstone.workspace_id = p_workspace_id
        AND tombstone.subject_type = path_subject.dsr_subject_type
        AND tombstone.subject_id = path_subject.dsr_subject_id;
      IF FOUND THEN
        RAISE EXCEPTION 'GOVERNED_SUBJECT_TOMBSTONED' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    SELECT relation.parent_subject_id INTO next_subject
    FROM public.governed_subject_relation relation
    WHERE relation.workspace_id = p_workspace_id
      AND relation.operation_id = p_operation_id
      AND relation.child_subject_id = current_subject
    ORDER BY relation.id
    LIMIT 1;
    EXIT WHEN NOT FOUND;
    current_subject := next_subject;
  END LOOP;
  IF p_child_data_class = 'PERSONAL' THEN
    PERFORM 1 FROM public.generic_operation_artifact_subject_tombstone tombstone
    WHERE tombstone.workspace_id = p_workspace_id
      AND tombstone.subject_type = p_child_dsr_subject_type
      AND tombstone.subject_id = p_child_dsr_subject_id;
    IF FOUND THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_TOMBSTONED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
END
$personal$;

CREATE FUNCTION public.append_workspace_governed_child_relation_v1(
  p_workspace_id UUID,
  p_authority_id UUID,
  p_account_id UUID,
  p_operation_id UUID,
  p_operation_generation INTEGER,
  p_ack_id CHAR(64),
  p_result_digest CHAR(64),
  p_root_subject_type VARCHAR(191),
  p_root_subject_id UUID,
  p_root_data_class VARCHAR(16),
  p_root_dsr_subject_type VARCHAR(191),
  p_root_dsr_subject_id UUID,
  p_parent_governed_subject_id UUID,
  p_child_subject_type VARCHAR(191),
  p_child_subject_id UUID,
  p_child_data_class VARCHAR(16),
  p_child_dsr_subject_type VARCHAR(191),
  p_child_dsr_subject_id UUID,
  p_relation_key VARCHAR(200),
  p_relation_kind VARCHAR(32),
  p_source_ref_namespace VARCHAR(64),
  p_source_ref_uuid UUID,
  p_source_ref_sha256 CHAR(64),
  p_contract_sha256 CHAR(64)
) RETURNS TABLE(
  operation_subject_id UUID,
  parent_subject_id UUID,
  child_subject_id UUID,
  relation_id UUID,
  replay BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $append$
DECLARE
  stored_operation_subject public.tool_operation_subject%ROWTYPE;
  stored_root public.governed_subject%ROWTYPE;
  stored_child public.governed_subject%ROWTYPE;
  stored_relation public.governed_subject_relation%ROWTYPE;
  effective_parent UUID;
  parent_depth INTEGER;
BEGIN
  PERFORM _governed_relation_assert_caller_v1(p_workspace_id);
  IF p_root_subject_type IS DISTINCT FROM 'tool_operation'
    OR p_root_subject_id IS DISTINCT FROM p_operation_id
    OR p_root_data_class IS DISTINCT FROM 'NON_PERSONAL'
    OR p_root_dsr_subject_type IS NOT NULL
    OR p_root_dsr_subject_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_subject_type !~ '^[a-z][a-z0-9_.]{0,190}$'
    OR p_relation_key !~ '^[a-z][a-z0-9_.:-]{0,199}$'
    OR p_source_ref_namespace !~ '^[a-z][a-z0-9_.]{0,63}$'
    OR p_contract_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_relation_kind <> 'MATERIALIZED_CHILD'
    AND p_relation_kind <> 'DERIVED_FROM' THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_ref_uuid IS NULL AND p_source_ref_sha256 IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_ref_uuid IS NOT NULL AND p_source_ref_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_ref_sha256 IS NOT NULL
    AND p_source_ref_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'PERSONAL' AND p_child_dsr_subject_type IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'PERSONAL' AND p_child_dsr_subject_id IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'PERSONAL'
    AND p_child_dsr_subject_type !~ '^[a-z][a-z0-9_.]{0,190}$' THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'NON_PERSONAL' AND p_child_dsr_subject_type IS NOT NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'NON_PERSONAL' AND p_child_dsr_subject_id IS NOT NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class <> 'PERSONAL' AND p_child_data_class <> 'NON_PERSONAL' THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'governed-subject-relation:' || p_workspace_id::text || ':' || p_operation_id::text,
    0
  ));
  PERFORM _governed_relation_assert_operation_v1(
    p_workspace_id, p_authority_id, p_account_id, p_operation_id,
    p_operation_generation, p_ack_id, p_result_digest
  );

  SELECT target.* INTO stored_operation_subject
  FROM public.tool_operation_subject target
  WHERE target.workspace_id = p_workspace_id
    AND target.operation_id = p_operation_id;
  IF FOUND THEN
    IF stored_operation_subject.authority_id IS DISTINCT FROM p_authority_id
      OR stored_operation_subject.account_id IS DISTINCT FROM p_account_id
      OR stored_operation_subject.operation_generation IS DISTINCT FROM p_operation_generation
      OR stored_operation_subject.ack_id IS DISTINCT FROM p_ack_id
      OR stored_operation_subject.result_digest IS DISTINCT FROM p_result_digest
    THEN
      RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT target.* INTO stored_root
    FROM public.governed_subject target
    WHERE target.workspace_id = p_workspace_id
      AND target.subject_type = 'tool_operation'
      AND target.subject_id = p_operation_id;
    IF FOUND THEN
      IF stored_root.data_class IS DISTINCT FROM 'NON_PERSONAL'
        OR stored_root.dsr_subject_type IS NOT NULL
        OR stored_root.dsr_subject_id IS NOT NULL
      THEN
        RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
      END IF;
    ELSE
      INSERT INTO public.governed_subject(
        scope_key, workspace_id, subject_type, subject_id, data_class
      ) VALUES (
        p_workspace_id::text, p_workspace_id, 'tool_operation', p_operation_id,
        'NON_PERSONAL'
      ) RETURNING * INTO stored_root;
    END IF;
    INSERT INTO public.tool_operation_subject(
      subject_id, scope_key, workspace_id, authority_id, account_id,
      operation_id, operation_generation, root_subject_id, ack_id, result_digest
    ) VALUES (
      stored_root.id, p_workspace_id::text, p_workspace_id, p_authority_id,
      p_account_id, p_operation_id, p_operation_generation, stored_root.id,
      p_ack_id, p_result_digest
    ) RETURNING * INTO stored_operation_subject;
  END IF;

  effective_parent := COALESCE(
    p_parent_governed_subject_id, stored_operation_subject.subject_id
  );
  WITH RECURSIVE reachable(subject_id, depth) AS (
    SELECT stored_operation_subject.subject_id, 0
    UNION ALL
    SELECT relation.child_subject_id, reachable.depth + 1
    FROM reachable
    JOIN public.governed_subject_relation relation
      ON relation.workspace_id = p_workspace_id
     AND relation.operation_id = p_operation_id
     AND relation.parent_subject_id = reachable.subject_id
    WHERE reachable.depth < 65
  )
  SELECT MAX(depth) INTO parent_depth
  FROM reachable WHERE subject_id = effective_parent;
  IF parent_depth IS NULL OR parent_depth >= 64 THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT target.* INTO stored_child
  FROM public.governed_subject target
  WHERE target.workspace_id = p_workspace_id
    AND target.subject_type = p_child_subject_type
    AND target.subject_id = p_child_subject_id;
  SELECT target.* INTO stored_relation
  FROM public.governed_subject_relation target
  WHERE target.workspace_id = p_workspace_id
    AND target.operation_id = p_operation_id
    AND target.relation_key = p_relation_key;
  IF FOUND THEN
    IF stored_child.id IS NULL
      OR stored_child.data_class IS DISTINCT FROM p_child_data_class
      OR stored_child.dsr_subject_type IS DISTINCT FROM p_child_dsr_subject_type
      OR stored_child.dsr_subject_id IS DISTINCT FROM p_child_dsr_subject_id
      OR stored_relation.authority_id IS DISTINCT FROM p_authority_id
      OR stored_relation.account_id IS DISTINCT FROM p_account_id
      OR stored_relation.operation_generation IS DISTINCT FROM p_operation_generation
      OR stored_relation.ack_id IS DISTINCT FROM p_ack_id
      OR stored_relation.operation_subject_id IS DISTINCT FROM stored_operation_subject.subject_id
      OR stored_relation.parent_subject_id IS DISTINCT FROM effective_parent
      OR stored_relation.child_subject_id IS DISTINCT FROM stored_child.id
      OR stored_relation.relation_kind IS DISTINCT FROM p_relation_kind
      OR stored_relation.source_ref_namespace IS DISTINCT FROM p_source_ref_namespace
      OR stored_relation.source_ref_uuid IS DISTINCT FROM p_source_ref_uuid
      OR stored_relation.source_ref_sha256 IS DISTINCT FROM p_source_ref_sha256
      OR stored_relation.contract_sha256 IS DISTINCT FROM p_contract_sha256
    THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM _governed_relation_assert_path_v1(
      p_workspace_id, p_operation_id, stored_operation_subject.subject_id,
      effective_parent, stored_child.id
    );
    PERFORM _governed_relation_lock_personal_path_v1(
      p_workspace_id, p_operation_id, effective_parent, p_child_data_class,
      p_child_dsr_subject_type, p_child_dsr_subject_id
    );
    RETURN QUERY SELECT stored_operation_subject.subject_id, effective_parent,
      stored_child.id, stored_relation.id, true;
    RETURN;
  END IF;

  IF stored_child.id IS NOT NULL AND (
    stored_child.data_class IS DISTINCT FROM p_child_data_class
    OR stored_child.dsr_subject_type IS DISTINCT FROM p_child_dsr_subject_type
    OR stored_child.dsr_subject_id IS DISTINCT FROM p_child_dsr_subject_id
  ) THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;

  IF stored_child.id IS NOT NULL AND (
    stored_child.id = effective_parent OR EXISTS (
      WITH RECURSIVE descendants(subject_id) AS (
        SELECT stored_child.id
        UNION
        SELECT relation.child_subject_id
        FROM public.governed_subject_relation relation
        JOIN descendants current_path ON current_path.subject_id = relation.parent_subject_id
        WHERE relation.workspace_id = p_workspace_id
          AND relation.operation_id = p_operation_id
      )
      SELECT 1 FROM descendants WHERE subject_id = effective_parent
    )
  ) THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF (stored_child.id IS NULL AND (
      SELECT count(*) FROM public.governed_subject WHERE workspace_id = p_workspace_id
    ) >= 4096) OR (
      SELECT count(*) FROM public.governed_subject_relation
      WHERE workspace_id = p_workspace_id AND operation_id = p_operation_id
    ) >= 8192
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;

  PERFORM _governed_relation_assert_path_v1(
    p_workspace_id, p_operation_id, stored_operation_subject.subject_id,
    effective_parent, CASE WHEN stored_child.id IS NULL THEN NULL ELSE stored_child.id END
  );
  PERFORM _governed_relation_lock_personal_path_v1(
    p_workspace_id, p_operation_id, effective_parent, p_child_data_class,
    p_child_dsr_subject_type, p_child_dsr_subject_id
  );
  IF stored_child.id IS NULL THEN
    INSERT INTO public.governed_subject(
      scope_key, workspace_id, subject_type, subject_id, data_class,
      dsr_subject_type, dsr_subject_id
    ) VALUES (
      p_workspace_id::text, p_workspace_id, p_child_subject_type,
      p_child_subject_id, p_child_data_class, p_child_dsr_subject_type,
      p_child_dsr_subject_id
    ) RETURNING * INTO stored_child;
  END IF;
  INSERT INTO public.governed_subject_relation(
    scope_key, workspace_id, authority_id, account_id, operation_id,
    operation_generation, ack_id, operation_subject_id, parent_subject_id,
    child_subject_id, relation_key, relation_kind, source_ref_namespace,
    source_ref_uuid, source_ref_sha256, contract_sha256
  ) VALUES (
    p_workspace_id::text, p_workspace_id, p_authority_id, p_account_id,
    p_operation_id, p_operation_generation, p_ack_id,
    stored_operation_subject.subject_id, effective_parent, stored_child.id,
    p_relation_key, p_relation_kind, p_source_ref_namespace, p_source_ref_uuid,
    p_source_ref_sha256, p_contract_sha256
  ) RETURNING * INTO stored_relation;
  RETURN QUERY SELECT stored_operation_subject.subject_id, effective_parent,
    stored_child.id, stored_relation.id, false;
END
$append$;

CREATE FUNCTION public.attest_workspace_governed_child_relation_v1(
  p_workspace_id UUID,
  p_authority_id UUID,
  p_account_id UUID,
  p_operation_id UUID,
  p_operation_generation INTEGER,
  p_ack_id CHAR(64),
  p_result_digest CHAR(64),
  p_root_subject_type VARCHAR(191),
  p_root_subject_id UUID,
  p_root_data_class VARCHAR(16),
  p_root_dsr_subject_type VARCHAR(191),
  p_root_dsr_subject_id UUID,
  p_parent_governed_subject_id UUID,
  p_child_subject_type VARCHAR(191),
  p_child_subject_id UUID,
  p_child_data_class VARCHAR(16),
  p_child_dsr_subject_type VARCHAR(191),
  p_child_dsr_subject_id UUID,
  p_relation_key VARCHAR(200),
  p_relation_kind VARCHAR(32),
  p_source_ref_namespace VARCHAR(64),
  p_source_ref_uuid UUID,
  p_source_ref_sha256 CHAR(64),
  p_contract_sha256 CHAR(64)
) RETURNS TABLE(
  operation_subject_id UUID,
  parent_subject_id UUID,
  child_subject_id UUID,
  relation_id UUID,
  replay BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $attest$
DECLARE
  stored_operation_subject public.tool_operation_subject%ROWTYPE;
  stored_child public.governed_subject%ROWTYPE;
  stored_relation public.governed_subject_relation%ROWTYPE;
  effective_parent UUID;
BEGIN
  PERFORM _governed_relation_assert_caller_v1(p_workspace_id);
  IF p_root_subject_type IS DISTINCT FROM 'tool_operation'
    OR p_root_subject_id IS DISTINCT FROM p_operation_id
    OR p_root_data_class IS DISTINCT FROM 'NON_PERSONAL'
    OR p_root_dsr_subject_type IS NOT NULL
    OR p_root_dsr_subject_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_subject_type !~ '^[a-z][a-z0-9_.]{0,190}$'
    OR p_relation_key !~ '^[a-z][a-z0-9_.:-]{0,199}$'
    OR p_source_ref_namespace !~ '^[a-z][a-z0-9_.]{0,63}$'
    OR p_contract_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_relation_kind <> 'MATERIALIZED_CHILD'
    AND p_relation_kind <> 'DERIVED_FROM' THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_ref_uuid IS NULL AND p_source_ref_sha256 IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_ref_uuid IS NOT NULL AND p_source_ref_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_ref_sha256 IS NOT NULL
    AND p_source_ref_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'PERSONAL' AND p_child_dsr_subject_type IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'PERSONAL' AND p_child_dsr_subject_id IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'PERSONAL'
    AND p_child_dsr_subject_type !~ '^[a-z][a-z0-9_.]{0,190}$' THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'NON_PERSONAL' AND p_child_dsr_subject_type IS NOT NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class = 'NON_PERSONAL' AND p_child_dsr_subject_id IS NOT NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_data_class <> 'PERSONAL' AND p_child_data_class <> 'NON_PERSONAL' THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'governed-subject-relation:' || p_workspace_id::text || ':' || p_operation_id::text,
    0
  ));
  PERFORM _governed_relation_assert_operation_v1(
    p_workspace_id, p_authority_id, p_account_id, p_operation_id,
    p_operation_generation, p_ack_id, p_result_digest
  );
  SELECT target.* INTO stored_operation_subject
  FROM public.tool_operation_subject target
  WHERE target.workspace_id = p_workspace_id
    AND target.operation_id = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF stored_operation_subject.authority_id IS DISTINCT FROM p_authority_id
    OR stored_operation_subject.account_id IS DISTINCT FROM p_account_id
    OR stored_operation_subject.operation_generation IS DISTINCT FROM p_operation_generation
    OR stored_operation_subject.ack_id IS DISTINCT FROM p_ack_id
    OR stored_operation_subject.result_digest IS DISTINCT FROM p_result_digest
  THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  effective_parent := COALESCE(
    p_parent_governed_subject_id, stored_operation_subject.subject_id
  );
  PERFORM 1
  FROM public.governed_subject subject
  LEFT JOIN public.tool_operation_subject root_subject
    ON root_subject.workspace_id = subject.workspace_id
   AND root_subject.operation_id = p_operation_id
   AND root_subject.subject_id = subject.id
  LEFT JOIN public.governed_subject_relation parent_edge
    ON parent_edge.workspace_id = subject.workspace_id
   AND parent_edge.operation_id = p_operation_id
   AND parent_edge.parent_subject_id = subject.id
  LEFT JOIN public.governed_subject_relation child_edge
    ON child_edge.workspace_id = subject.workspace_id
   AND child_edge.operation_id = p_operation_id
   AND child_edge.child_subject_id = subject.id
  WHERE subject.workspace_id = p_workspace_id
    AND subject.id = effective_parent
    AND COALESCE(
      root_subject.operation_id, parent_edge.operation_id, child_edge.operation_id
    ) = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT target.* INTO stored_child
  FROM public.governed_subject target
  WHERE target.workspace_id = p_workspace_id
    AND target.subject_type = p_child_subject_type
    AND target.subject_id = p_child_subject_id;
  SELECT target.* INTO stored_relation
  FROM public.governed_subject_relation target
  WHERE target.workspace_id = p_workspace_id
    AND target.operation_id = p_operation_id
    AND target.relation_key = p_relation_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF stored_child.id IS NULL
    OR stored_child.data_class IS DISTINCT FROM p_child_data_class
    OR stored_child.dsr_subject_type IS DISTINCT FROM p_child_dsr_subject_type
    OR stored_child.dsr_subject_id IS DISTINCT FROM p_child_dsr_subject_id
    OR stored_relation.authority_id IS DISTINCT FROM p_authority_id
    OR stored_relation.account_id IS DISTINCT FROM p_account_id
    OR stored_relation.operation_generation IS DISTINCT FROM p_operation_generation
    OR stored_relation.ack_id IS DISTINCT FROM p_ack_id
    OR stored_relation.operation_subject_id IS DISTINCT FROM stored_operation_subject.subject_id
    OR stored_relation.parent_subject_id IS DISTINCT FROM effective_parent
    OR stored_relation.child_subject_id IS DISTINCT FROM stored_child.id
    OR stored_relation.relation_kind IS DISTINCT FROM p_relation_kind
    OR stored_relation.source_ref_namespace IS DISTINCT FROM p_source_ref_namespace
    OR stored_relation.source_ref_uuid IS DISTINCT FROM p_source_ref_uuid
    OR stored_relation.source_ref_sha256 IS DISTINCT FROM p_source_ref_sha256
    OR stored_relation.contract_sha256 IS DISTINCT FROM p_contract_sha256
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_CONFLICT' USING ERRCODE = 'P0001';
  END IF;
  PERFORM _governed_relation_assert_path_v1(
    p_workspace_id, p_operation_id, stored_operation_subject.subject_id,
    effective_parent, stored_child.id
  );
  PERFORM _governed_relation_lock_personal_path_v1(
    p_workspace_id, p_operation_id, effective_parent, p_child_data_class,
    p_child_dsr_subject_type, p_child_dsr_subject_id
  );
  RETURN QUERY SELECT stored_operation_subject.subject_id, effective_parent,
    stored_child.id, stored_relation.id, true;
END
$attest$;

REVOKE ALL ON FUNCTION public._governed_relation_assert_caller_v1(UUID) FROM
  PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._governed_relation_assert_operation_v1(
  UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64)
) FROM PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._governed_relation_assert_path_v1(
  UUID, UUID, UUID, UUID, UUID
) FROM PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._governed_relation_lock_personal_path_v1(
  UUID, UUID, UUID, VARCHAR(16), VARCHAR(191), UUID
) FROM PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;

REVOKE ALL ON FUNCTION public.append_workspace_governed_child_relation_v1(UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64), VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, UUID, VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, VARCHAR(200), VARCHAR(32), VARCHAR(64), UUID, CHAR(64), CHAR(64)) FROM PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.attest_workspace_governed_child_relation_v1(UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64), VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, UUID, VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, VARCHAR(200), VARCHAR(32), VARCHAR(64), UUID, CHAR(64), CHAR(64)) FROM PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION public.append_workspace_governed_child_relation_v1(UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64), VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, UUID, VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, VARCHAR(200), VARCHAR(32), VARCHAR(64), UUID, CHAR(64), CHAR(64)) TO app_user;
GRANT EXECUTE ON FUNCTION public.attest_workspace_governed_child_relation_v1(UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64), VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, UUID, VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, VARCHAR(200), VARCHAR(32), VARCHAR(64), UUID, CHAR(64), CHAR(64)) TO app_user;

COMMIT;
