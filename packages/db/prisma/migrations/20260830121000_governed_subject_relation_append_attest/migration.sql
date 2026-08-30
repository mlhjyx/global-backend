BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE FUNCTION public._governed_relation_assert_caller_v1(p_workspace_id UUID) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $caller$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM current_workspace_id()
  THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
END
$caller$;
CREATE FUNCTION public._governed_relation_lock_operation_v1(
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
DECLARE
  operation public.tool_budget_operation%ROWTYPE;
  account public.tool_budget_account%ROWTYPE;
  authority public.execution_budget_authority%ROWTYPE;
  ack public.execution_domain_ack%ROWTYPE;
  expected_strategy TEXT;
  expected_artifact_id TEXT;
BEGIN
  SELECT target.* INTO authority FROM public.execution_budget_authority target
  WHERE target.scope_key=p_workspace_id::text AND target.workspace_id=p_workspace_id
    AND target.id=p_authority_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF authority.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_AUTHORITY_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  IF authority.consumed_at IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.execution_budget_authority_revocation revocation
  WHERE revocation.scope_key = authority.scope_key
    AND revocation.authority_id = authority.id;
  IF FOUND THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_AUTHORITY_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  SELECT target.* INTO operation FROM public.tool_budget_operation target
  WHERE target.scope_key=p_workspace_id::text AND target.id=p_operation_id
    AND target.generation=p_operation_generation AND target.status='SETTLED'
    AND target.result_digest=p_result_digest FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE='P0001'; END IF;
  SELECT target.* INTO account FROM public.tool_budget_account target
  WHERE target.scope_key=operation.scope_key AND target.id=p_account_id
    AND target.id=operation.account_id AND target.authority_id=authority.id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE='P0001'; END IF;
  SELECT target.* INTO ack
  FROM public.execution_domain_ack target
  WHERE target.scope_key = operation.scope_key
    AND target.ack_id = p_ack_id
    AND target.operation_id = operation.id
    AND target.account_id = account.id
    AND target.authority_id = authority.id
    AND target.result_digest = p_result_digest
  FOR SHARE;
  expected_strategy := CASE operation.result_schema_version
    WHEN 'generic-operation-projection/v1' THEN 'typed_projection'
    WHEN 'generic-operation-artifact-ref/v1' THEN 'artifact_reference'
    ELSE NULL
  END;
  expected_artifact_id := CASE expected_strategy
    WHEN 'artifact_reference' THEN operation.result_json->>'artifactId'
    ELSE NULL
  END;
  IF NOT FOUND
    OR ack.operation_key IS DISTINCT FROM operation.operation_key
    OR ack.result_schema IS DISTINCT FROM operation.result_schema
    OR ack.usage IS DISTINCT FROM operation.receipt_usage
    OR ack.cost_basis IS DISTINCT FROM operation.receipt_cost_basis
    OR expected_strategy IS NULL
    OR ack.result_strategy IS DISTINCT FROM expected_strategy
    OR ack.artifact_id IS DISTINCT FROM expected_artifact_id
    OR expected_strategy = 'artifact_reference' AND COALESCE(
      expected_artifact_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', true
    )
  THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
END
$operation$;
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
AS $operation_read$
DECLARE
  matched_count INTEGER;
BEGIN
  SELECT count(*) INTO matched_count
  FROM public.execution_budget_authority authority
  JOIN public.tool_budget_account account
    ON account.scope_key = authority.scope_key
   AND account.authority_id = authority.id
  JOIN public.tool_budget_operation operation
    ON operation.scope_key = account.scope_key
   AND operation.account_id = account.id
  JOIN public.execution_domain_ack ack
    ON ack.scope_key = operation.scope_key
   AND ack.operation_id = operation.id
   AND ack.account_id = account.id
   AND ack.authority_id = authority.id
  LEFT JOIN public.execution_budget_authority_revocation revocation
    ON revocation.scope_key = authority.scope_key
   AND revocation.authority_id = authority.id
  WHERE authority.scope_key = p_workspace_id::text
    AND authority.workspace_id = p_workspace_id
    AND authority.id = p_authority_id
    AND authority.consumed_at IS NOT NULL
    AND authority.revoked_at IS NULL
    AND revocation.authority_id IS NULL
    AND account.id = p_account_id
    AND operation.id = p_operation_id
    AND operation.generation = p_operation_generation
    AND operation.status = 'SETTLED'
    AND operation.result_digest = p_result_digest
    AND ack.ack_id = p_ack_id
    AND ack.result_digest = p_result_digest
    AND ack.operation_key = operation.operation_key
    AND ack.result_schema = operation.result_schema
    AND ack.usage = operation.receipt_usage
    AND ack.cost_basis = operation.receipt_cost_basis
    AND ack.result_strategy = CASE operation.result_schema_version
      WHEN 'generic-operation-projection/v1' THEN 'typed_projection'
      WHEN 'generic-operation-artifact-ref/v1' THEN 'artifact_reference'
      ELSE NULL END
    AND ack.artifact_id IS NOT DISTINCT FROM CASE operation.result_schema_version
      WHEN 'generic-operation-artifact-ref/v1' THEN operation.result_json->>'artifactId'
      ELSE NULL END
    AND CASE operation.result_schema_version
      WHEN 'generic-operation-projection/v1' THEN ack.artifact_id IS NULL
      WHEN 'generic-operation-artifact-ref/v1' THEN
        ack.artifact_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ELSE false END;
  IF matched_count = 1 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public.execution_budget_authority_revocation revocation
  WHERE revocation.scope_key = p_workspace_id::text
    AND revocation.authority_id = p_authority_id;
  IF FOUND THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_AUTHORITY_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.execution_budget_authority authority
  WHERE authority.scope_key = p_workspace_id::text
    AND authority.id = p_authority_id
    AND authority.revoked_at IS NOT NULL;
  IF FOUND THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_AUTHORITY_REVOKED' USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
END
$operation_read$;
CREATE FUNCTION public._governed_relation_path_snapshot_v1(
  p_workspace_id UUID,p_operation_id UUID,p_parent_subject_id UUID,
  p_child_subject_type VARCHAR(191),p_child_subject_id UUID,p_child_data_class VARCHAR(16),
  p_child_dsr_subject_type VARCHAR(191),p_child_dsr_subject_id UUID,p_tuple JSONB
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public AS $path$
DECLARE ancestors_set UUID[]; subjects UUID[]; dsr TEXT[]; governed UUID[]; artifact TEXT[]; reachable BOOLEAN;
  operation_subject UUID; child_internal UUID; effective_parent UUID;
  relation public.governed_subject_relation%ROWTYPE; relation_child public.governed_subject%ROWTYPE;
  caller_tuple JSONB; stored_tuple JSONB;
BEGIN
  SELECT subject_id INTO operation_subject FROM public.tool_operation_subject
    WHERE workspace_id=p_workspace_id AND operation_id=p_operation_id;
  SELECT id INTO child_internal FROM public.governed_subject
    WHERE workspace_id=p_workspace_id AND subject_type=p_child_subject_type
      AND subject_id=p_child_subject_id;
  effective_parent:=COALESCE(p_parent_subject_id,operation_subject);
  caller_tuple:=p_tuple||jsonb_build_object('effectiveParentId',effective_parent);
  SELECT target.* INTO relation FROM public.governed_subject_relation target
    WHERE target.workspace_id=p_workspace_id AND target.operation_id=p_operation_id
      AND target.relation_key=p_tuple->>'relationKey';
  IF FOUND THEN
    SELECT target.* INTO relation_child FROM public.governed_subject target
      WHERE target.workspace_id=p_workspace_id AND target.id=relation.child_subject_id;
    stored_tuple:=jsonb_build_object('authorityId',relation.authority_id,
      'accountId',relation.account_id,'generation',relation.operation_generation,
      'ackId',relation.ack_id,'parentInputId',p_parent_subject_id,
      'childType',relation_child.subject_type,'childId',relation_child.subject_id,
      'childData',relation_child.data_class,'childDsrType',relation_child.dsr_subject_type,
      'childDsrId',relation_child.dsr_subject_id,'relationKey',relation.relation_key,
      'relationKind',relation.relation_kind,'sourceNamespace',relation.source_ref_namespace,
      'sourceUuid',relation.source_ref_uuid,'sourceSha',relation.source_ref_sha256,
      'contractSha',relation.contract_sha256,'effectiveParentId',relation.parent_subject_id);
  END IF;
  WITH RECURSIVE ancestors(subject_id) AS (
    SELECT effective_parent WHERE effective_parent IS NOT NULL
    UNION SELECT edge.parent_subject_id FROM public.governed_subject_relation edge
      JOIN ancestors path ON path.subject_id=edge.child_subject_id
      WHERE edge.workspace_id=p_workspace_id AND edge.operation_id=p_operation_id
  ) SELECT COALESCE(array_agg(subject_id ORDER BY subject_id),ARRAY[]::UUID[])
    INTO ancestors_set FROM ancestors;
  reachable := operation_subject IS NULL AND p_parent_subject_id IS NULL
    OR operation_subject=ANY(ancestors_set);
  WITH path_subjects(subject_id) AS (
    SELECT unnest(ancestors_set)
    UNION SELECT operation_subject WHERE operation_subject IS NOT NULL
    UNION SELECT child_internal WHERE child_internal IS NOT NULL
  ) SELECT COALESCE(array_agg(subject_id ORDER BY subject_id),ARRAY[]::UUID[])
    INTO subjects FROM path_subjects;
  WITH personal(subject_type,subject_id) AS (
    SELECT subject.dsr_subject_type,subject.dsr_subject_id FROM public.governed_subject subject
      WHERE subject.workspace_id=p_workspace_id AND subject.id=ANY(subjects)
        AND subject.data_class='PERSONAL'
    UNION SELECT p_child_dsr_subject_type,p_child_dsr_subject_id
      WHERE p_child_data_class='PERSONAL'
  ) SELECT COALESCE(array_agg(subject_type||':'||subject_id::text
      ORDER BY subject_type,subject_id),ARRAY[]::TEXT[]) INTO dsr FROM personal;
  SELECT COALESCE(array_agg(t.governed_subject_id ORDER BY t.governed_subject_id),ARRAY[]::UUID[])
    INTO governed FROM public.governed_subject_tombstone t
    WHERE t.workspace_id=p_workspace_id AND t.governed_subject_id=ANY(subjects);
  SELECT COALESCE(array_agg(t.subject_type||':'||t.subject_id::text
      ORDER BY t.subject_type,t.subject_id),ARRAY[]::TEXT[]) INTO artifact
    FROM public.generic_operation_artifact_subject_tombstone t
    WHERE t.workspace_id=p_workspace_id
      AND t.subject_type||':'||t.subject_id::text=ANY(dsr);
  RETURN jsonb_build_object('subjectIds',to_jsonb(subjects),'dsrKeys',to_jsonb(dsr),
    'governedFences',to_jsonb(governed),'artifactFences',to_jsonb(artifact),
    'rootReachable',reachable,'operationSubjectId',operation_subject,
    'effectiveParentId',effective_parent,'childInternalId',child_internal,
    'relationExists',relation.id IS NOT NULL,'relationId',relation.id,
    'tuple',caller_tuple,'storedTuple',stored_tuple,
    'relationExact',stored_tuple IS NOT DISTINCT FROM caller_tuple);
END $path$;
CREATE FUNCTION public._governed_relation_lock_snapshot_dsr_v1(
  p_workspace_id UUID,p_operation_id UUID,p_snapshot JSONB) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public AS $locks$
DECLARE key TEXT;
BEGIN
  IF current_setting('app.governed_relation_graph_lock_'||replace(p_operation_id::text,'-','_'),true)='held' AND EXISTS (SELECT 1 FROM pg_locks graph WHERE graph.pid=pg_backend_pid() AND graph.locktype='advisory' AND graph.granted AND graph.classid::bigint=((hashtextextended('governed-subject-relation:'||p_workspace_id::text||':'||p_operation_id::text,0)>>32)&4294967295) AND graph.objid::bigint=(hashtextextended('governed-subject-relation:'||p_workspace_id::text||':'||p_operation_id::text,0)&4294967295)) AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_snapshot->'dsrKeys') value WHERE NOT EXISTS (
      SELECT 1 FROM pg_locks held WHERE held.pid=pg_backend_pid() AND held.locktype='advisory'
       AND held.granted AND held.classid::bigint=((hashtextextended(
        'generic-operation-artifact-subject:'||p_workspace_id::text||':'||value,0)>>32)&4294967295)
       AND held.objid::bigint=(hashtextextended(
        'generic-operation-artifact-subject:'||p_workspace_id::text||':'||value,0)&4294967295)
    )) THEN RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE='P0001'; END IF;
  FOR key IN SELECT value FROM jsonb_array_elements_text(p_snapshot->'dsrKeys') value ORDER BY value
  LOOP PERFORM pg_advisory_xact_lock(hashtextextended(
    'generic-operation-artifact-subject:'||p_workspace_id::text||':'||key,0)); END LOOP;
END $locks$;
CREATE FUNCTION public.append_workspace_governed_child_relation_v1(
 p_workspace_id UUID, p_authority_id UUID, p_account_id UUID, p_operation_id UUID, p_operation_generation INTEGER, p_ack_id CHAR(64), p_result_digest CHAR(64), p_root_subject_type VARCHAR(191), p_root_subject_id UUID, p_root_data_class VARCHAR(16), p_root_dsr_subject_type VARCHAR(191), p_root_dsr_subject_id UUID, p_parent_governed_subject_id UUID, p_child_subject_type VARCHAR(191), p_child_subject_id UUID, p_child_data_class VARCHAR(16), p_child_dsr_subject_type VARCHAR(191), p_child_dsr_subject_id UUID, p_relation_key VARCHAR(200), p_relation_kind VARCHAR(32), p_source_ref_namespace VARCHAR(64), p_source_ref_uuid UUID, p_source_ref_sha256 CHAR(64), p_contract_sha256 CHAR(64)
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
  parent_depth INTEGER; child_height INTEGER:=0;
  operation_subject_count INTEGER;
  child_in_operation BOOLEAN;
  pre_snapshot JSONB; post_snapshot JSONB;
  caller_tuple JSONB;
  materialization_allowance INTEGER;
BEGIN
  PERFORM _governed_relation_assert_caller_v1(p_workspace_id);
  IF p_authority_id IS NULL OR p_account_id IS NULL OR p_operation_id IS NULL
    OR p_operation_generation IS NULL OR p_operation_generation < 1
    OR p_ack_id IS NULL OR p_result_digest IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_root_subject_type IS DISTINCT FROM 'tool_operation'
    OR p_root_subject_id IS DISTINCT FROM p_operation_id
    OR p_root_data_class IS DISTINCT FROM 'NON_PERSONAL'
    OR p_root_dsr_subject_type IS NOT NULL
    OR p_root_dsr_subject_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_parent_governed_subject_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.governed_subject subject
    WHERE subject.workspace_id=p_workspace_id AND subject.id=p_parent_governed_subject_id
      AND subject.subject_type='tool_operation' AND subject.subject_id=p_operation_id
  ) THEN RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE='P0001'; END IF;
  IF p_child_subject_type !~ '^[a-z][a-z0-9_.]{0,190}$'
    OR p_relation_key !~ '^[a-z][a-z0-9_.:-]{0,199}$'
    OR p_source_ref_namespace !~ '^[a-z][a-z0-9_.]{0,63}$'
    OR p_contract_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_subject_type IS NULL OR p_child_subject_id IS NULL
    OR p_child_data_class IS NULL OR p_relation_key IS NULL
    OR p_relation_kind IS NULL OR p_source_ref_namespace IS NULL
    OR p_contract_sha256 IS NULL THEN
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
  caller_tuple:=jsonb_build_object('authorityId',p_authority_id,'accountId',p_account_id,
    'generation',p_operation_generation,'ackId',p_ack_id,'parentInputId',p_parent_governed_subject_id,
    'childType',p_child_subject_type,'childId',p_child_subject_id,'childData',p_child_data_class,
    'childDsrType',p_child_dsr_subject_type,'childDsrId',p_child_dsr_subject_id,
    'relationKey',p_relation_key,'relationKind',p_relation_kind,
    'sourceNamespace',p_source_ref_namespace,'sourceUuid',p_source_ref_uuid,
    'sourceSha',p_source_ref_sha256,'contractSha',p_contract_sha256);
  PERFORM _governed_relation_lock_operation_v1(p_workspace_id,p_authority_id,p_account_id,
    p_operation_id,p_operation_generation,p_ack_id,p_result_digest);
  pre_snapshot:=_governed_relation_path_snapshot_v1(p_workspace_id,p_operation_id,
    p_parent_governed_subject_id,p_child_subject_type,p_child_subject_id,p_child_data_class,
    p_child_dsr_subject_type,p_child_dsr_subject_id,caller_tuple);
  IF COALESCE((pre_snapshot->>'rootReachable')::BOOLEAN,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE='P0001'; END IF;
  PERFORM _governed_relation_lock_snapshot_dsr_v1(p_workspace_id,p_operation_id,pre_snapshot);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'governed-subject-relation:' || p_workspace_id::text || ':' || p_operation_id::text,
    0
  ));
  PERFORM set_config('app.governed_relation_graph_lock_'||replace(p_operation_id::text,'-','_'),'held',true);
  post_snapshot:=_governed_relation_path_snapshot_v1(p_workspace_id,p_operation_id,
    p_parent_governed_subject_id,p_child_subject_type,p_child_subject_id,p_child_data_class,
    p_child_dsr_subject_type,p_child_dsr_subject_id,caller_tuple);
  materialization_allowance:=CASE WHEN pre_snapshot->>'operationSubjectId' IS NULL THEN 1 ELSE 0 END
    + CASE WHEN pre_snapshot->>'childInternalId' IS NULL THEN 1 ELSE 0 END;
  IF post_snapshot IS DISTINCT FROM pre_snapshot THEN
    IF post_snapshot->'governedFences' IS DISTINCT FROM pre_snapshot->'governedFences'
      OR post_snapshot->'artifactFences' IS DISTINCT FROM pre_snapshot->'artifactFences' THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_TOMBSTONED' USING ERRCODE='P0001'; END IF;
    IF COALESCE((pre_snapshot->>'relationExists')::BOOLEAN,false)
      OR COALESCE((post_snapshot->>'relationExists')::BOOLEAN,false) IS NOT TRUE
      OR post_snapshot->'dsrKeys' IS DISTINCT FROM pre_snapshot->'dsrKeys'
      OR NOT ((post_snapshot->'subjectIds') @> (pre_snapshot->'subjectIds'))
      OR jsonb_array_length(post_snapshot->'subjectIds')>
        jsonb_array_length(pre_snapshot->'subjectIds')+materialization_allowance THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE='P0001'; END IF;
    IF COALESCE((post_snapshot->>'relationExact')::BOOLEAN,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_CONFLICT' USING ERRCODE='P0001'; END IF;
    pre_snapshot:=post_snapshot;
  END IF;
  IF jsonb_array_length(pre_snapshot->'governedFences')>0
    OR jsonb_array_length(pre_snapshot->'artifactFences')>0 THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_TOMBSTONED' USING ERRCODE='P0001'; END IF;
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
    UNION
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
  IF stored_child.id IS NOT NULL THEN WITH RECURSIVE descendants(id,depth) AS (SELECT stored_child.id,0 UNION
      SELECT relation.child_subject_id,path.depth+1 FROM descendants path
      JOIN public.governed_subject_relation relation ON relation.workspace_id=p_workspace_id
       AND relation.operation_id=p_operation_id AND relation.parent_subject_id=path.id
      WHERE path.depth<65) SELECT COALESCE(MAX(depth),0) INTO child_height FROM descendants;
    IF parent_depth+1+child_height>64 THEN RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID'
      USING ERRCODE='P0001'; END IF;
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
  SELECT count(*) INTO operation_subject_count
  FROM (
    SELECT stored_operation_subject.subject_id AS subject_id
    UNION SELECT relation.parent_subject_id
      FROM public.governed_subject_relation relation
      WHERE relation.workspace_id = p_workspace_id
        AND relation.operation_id = p_operation_id
    UNION SELECT relation.child_subject_id
      FROM public.governed_subject_relation relation
      WHERE relation.workspace_id = p_workspace_id
        AND relation.operation_id = p_operation_id
  ) operation_subjects;
  child_in_operation := stored_child.id IS NOT NULL AND (
    stored_child.id = stored_operation_subject.subject_id OR EXISTS (
      SELECT 1 FROM public.governed_subject_relation relation
      WHERE relation.workspace_id = p_workspace_id
        AND relation.operation_id = p_operation_id
        AND (relation.parent_subject_id = stored_child.id
          OR relation.child_subject_id = stored_child.id)
    )
  );
  IF (NOT child_in_operation AND operation_subject_count >= 4096) OR (
      SELECT count(*) FROM public.governed_subject_relation
      WHERE workspace_id = p_workspace_id AND operation_id = p_operation_id
    ) >= 8192
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
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
 p_workspace_id UUID, p_authority_id UUID, p_account_id UUID, p_operation_id UUID, p_operation_generation INTEGER, p_ack_id CHAR(64), p_result_digest CHAR(64), p_root_subject_type VARCHAR(191), p_root_subject_id UUID, p_root_data_class VARCHAR(16), p_root_dsr_subject_type VARCHAR(191), p_root_dsr_subject_id UUID, p_parent_governed_subject_id UUID, p_child_subject_type VARCHAR(191), p_child_subject_id UUID, p_child_data_class VARCHAR(16), p_child_dsr_subject_type VARCHAR(191), p_child_dsr_subject_id UUID, p_relation_key VARCHAR(200), p_relation_kind VARCHAR(32), p_source_ref_namespace VARCHAR(64), p_source_ref_uuid UUID, p_source_ref_sha256 CHAR(64), p_contract_sha256 CHAR(64)
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
  pre_snapshot JSONB; post_snapshot JSONB;
  caller_tuple JSONB;
BEGIN
  PERFORM _governed_relation_assert_caller_v1(p_workspace_id);
  IF p_authority_id IS NULL OR p_account_id IS NULL OR p_operation_id IS NULL
    OR p_operation_generation IS NULL OR p_operation_generation < 1
    OR p_ack_id IS NULL OR p_result_digest IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_root_subject_type IS DISTINCT FROM 'tool_operation'
    OR p_root_subject_id IS DISTINCT FROM p_operation_id
    OR p_root_data_class IS DISTINCT FROM 'NON_PERSONAL'
    OR p_root_dsr_subject_type IS NOT NULL
    OR p_root_dsr_subject_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'GOVERNED_OPERATION_SUBJECT_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_parent_governed_subject_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.governed_subject subject
    WHERE subject.workspace_id=p_workspace_id AND subject.id=p_parent_governed_subject_id
      AND subject.subject_type='tool_operation' AND subject.subject_id=p_operation_id
  ) THEN RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE='P0001'; END IF;
  IF p_child_subject_type !~ '^[a-z][a-z0-9_.]{0,190}$'
    OR p_relation_key !~ '^[a-z][a-z0-9_.:-]{0,199}$'
    OR p_source_ref_namespace !~ '^[a-z][a-z0-9_.]{0,63}$'
    OR p_contract_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE = 'P0001';
  END IF;
  IF p_child_subject_type IS NULL OR p_child_subject_id IS NULL
    OR p_child_data_class IS NULL OR p_relation_key IS NULL
    OR p_relation_kind IS NULL OR p_source_ref_namespace IS NULL
    OR p_contract_sha256 IS NULL THEN
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
  caller_tuple:=jsonb_build_object('authorityId',p_authority_id,'accountId',p_account_id,
    'generation',p_operation_generation,'ackId',p_ack_id,'parentInputId',p_parent_governed_subject_id,
    'childType',p_child_subject_type,'childId',p_child_subject_id,'childData',p_child_data_class,
    'childDsrType',p_child_dsr_subject_type,'childDsrId',p_child_dsr_subject_id,
    'relationKey',p_relation_key,'relationKind',p_relation_kind,
    'sourceNamespace',p_source_ref_namespace,'sourceUuid',p_source_ref_uuid,
    'sourceSha',p_source_ref_sha256,'contractSha',p_contract_sha256);
  PERFORM _governed_relation_assert_operation_v1(p_workspace_id,p_authority_id,p_account_id,
    p_operation_id,p_operation_generation,p_ack_id,p_result_digest);
  pre_snapshot:=_governed_relation_path_snapshot_v1(p_workspace_id,p_operation_id,
    p_parent_governed_subject_id,p_child_subject_type,p_child_subject_id,p_child_data_class,
    p_child_dsr_subject_type,p_child_dsr_subject_id,caller_tuple);
  IF pre_snapshot->>'operationSubjectId' IS NULL THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE' USING ERRCODE='P0001'; END IF;
  IF COALESCE((pre_snapshot->>'rootReachable')::BOOLEAN,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE='P0001'; END IF;
  PERFORM _governed_relation_lock_snapshot_dsr_v1(p_workspace_id,p_operation_id,pre_snapshot);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'governed-subject-relation:' || p_workspace_id::text || ':' || p_operation_id::text,
    0
  ));
  PERFORM set_config('app.governed_relation_graph_lock_'||replace(p_operation_id::text,'-','_'),'held',true);
  PERFORM _governed_relation_assert_operation_v1(
    p_workspace_id, p_authority_id, p_account_id, p_operation_id,
    p_operation_generation, p_ack_id, p_result_digest
  );
  post_snapshot:=_governed_relation_path_snapshot_v1(p_workspace_id,p_operation_id,
    p_parent_governed_subject_id,p_child_subject_type,p_child_subject_id,p_child_data_class,
    p_child_dsr_subject_type,p_child_dsr_subject_id,caller_tuple);
  IF post_snapshot IS DISTINCT FROM pre_snapshot THEN
    IF post_snapshot->'governedFences' IS DISTINCT FROM pre_snapshot->'governedFences'
      OR post_snapshot->'artifactFences' IS DISTINCT FROM pre_snapshot->'artifactFences' THEN
      RAISE EXCEPTION 'GOVERNED_SUBJECT_TOMBSTONED' USING ERRCODE='P0001'; END IF;
    RAISE EXCEPTION 'GOVERNED_SUBJECT_RELATION_INVALID' USING ERRCODE='P0001'; END IF;
  IF jsonb_array_length(pre_snapshot->'governedFences')>0
    OR jsonb_array_length(pre_snapshot->'artifactFences')>0 THEN
    RAISE EXCEPTION 'GOVERNED_SUBJECT_TOMBSTONED' USING ERRCODE='P0001'; END IF;
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
  RETURN QUERY SELECT stored_operation_subject.subject_id, effective_parent,
    stored_child.id, stored_relation.id, true;
END
$attest$;
REVOKE ALL ON FUNCTION public._governed_relation_assert_caller_v1(UUID) FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._governed_relation_assert_operation_v1(UUID,UUID,UUID,UUID,INTEGER,CHAR(64),CHAR(64)) FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._governed_relation_lock_operation_v1(UUID,UUID,UUID,UUID,INTEGER,CHAR(64),CHAR(64)) FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._governed_relation_path_snapshot_v1(UUID,UUID,UUID,VARCHAR(191),UUID,VARCHAR(16),VARCHAR(191),UUID,JSONB) FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._governed_relation_lock_snapshot_dsr_v1(UUID,UUID,JSONB) FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.append_workspace_governed_child_relation_v1(UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64), VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, UUID, VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, VARCHAR(200), VARCHAR(32), VARCHAR(64), UUID, CHAR(64), CHAR(64)) FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.attest_workspace_governed_child_relation_v1(UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64), VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, UUID, VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, VARCHAR(200), VARCHAR(32), VARCHAR(64), UUID, CHAR(64), CHAR(64)) FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION public.append_workspace_governed_child_relation_v1(UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64), VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, UUID, VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, VARCHAR(200), VARCHAR(32), VARCHAR(64), UUID, CHAR(64), CHAR(64)) TO app_user;
GRANT EXECUTE ON FUNCTION public.attest_workspace_governed_child_relation_v1(UUID, UUID, UUID, UUID, INTEGER, CHAR(64), CHAR(64), VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, UUID, VARCHAR(191), UUID, VARCHAR(16), VARCHAR(191), UUID, VARCHAR(200), VARCHAR(32), VARCHAR(64), UUID, CHAR(64), CHAR(64)) TO app_user;
COMMIT;
