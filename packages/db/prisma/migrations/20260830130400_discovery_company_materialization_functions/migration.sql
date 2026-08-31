-- Release A C3: function-only authority for governed Discovery company materialization.
-- Normal application roles keep SELECT-only access to C tables; every write enters
-- through one of the six closed SECURITY DEFINER functions below.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

DO $roles$
DECLARE owner_state RECORD;
BEGIN
  SELECT rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    INTO owner_state FROM pg_roles
    WHERE rolname='discovery_materialization_function_owner';
  IF NOT FOUND THEN
    CREATE ROLE discovery_materialization_function_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF owner_state.rolcanlogin OR owner_state.rolinherit OR owner_state.rolsuper
    OR owner_state.rolcreatedb OR owner_state.rolcreaterole OR owner_state.rolreplication
    OR owner_state.rolbypassrls
  THEN
    RAISE EXCEPTION 'DISCOVERY_MATERIALIZATION_FUNCTION_OWNER_INVALID'
      USING ERRCODE='P0001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_auth_members membership
    WHERE membership.roleid='discovery_materialization_function_owner'::regrole
       OR membership.member='discovery_materialization_function_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'DISCOVERY_MATERIALIZATION_FUNCTION_OWNER_MEMBERSHIP_INVALID'
      USING ERRCODE='P0001';
  END IF;
  IF owner_state.rolcanlogin IS NOT NULL AND EXISTS(
    SELECT 1 FROM pg_class object
      WHERE object.relowner='discovery_materialization_function_owner'::regrole
    UNION ALL SELECT 1 FROM pg_proc object
      WHERE object.proowner='discovery_materialization_function_owner'::regrole
    UNION ALL SELECT 1 FROM information_schema.table_privileges
      WHERE grantee='discovery_materialization_function_owner'
    UNION ALL SELECT 1 FROM information_schema.routine_privileges
      WHERE grantee='discovery_materialization_function_owner'
    UNION ALL SELECT 1 FROM pg_db_role_setting setting
      WHERE setting.setrole='discovery_materialization_function_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'DISCOVERY_MATERIALIZATION_FUNCTION_OWNER_POLLUTED'
      USING ERRCODE='P0001';
  END IF;
END $roles$;

-- The only C-TX routine with BYPASSRLS.  Its closed input is derived by the
-- ordinary public facts function from an exact Q item; app/runtime roles cannot
-- execute it directly.  It locks the same Raw row used by retention/disposition
-- and returns no restricted payload.
CREATE FUNCTION public._discovery_company_materialization_lock_raw_fact_v1(
  p_workspace_id UUID,p_raw_record_id UUID
) RETURNS TABLE(raw_status TEXT,raw_expired_at TEXT,restricted_disposition_id UUID,
  product JSONB)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
DECLARE raw_row public.raw_source_record%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_raw_record_id IS NULL THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
      USING ERRCODE='P0001';
  END IF;
  SELECT raw.* INTO raw_row FROM public.raw_source_record raw
    WHERE raw.workspace_id=p_workspace_id AND raw.id=p_raw_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001';
  END IF;
  SELECT disposition.id INTO restricted_disposition_id
    FROM public.raw_source_governance_disposition disposition
    WHERE disposition.workspace_id=p_workspace_id
      AND disposition.raw_record_id=p_raw_record_id
      AND disposition.effect='RESTRICT_PROCESSING'
    ORDER BY disposition.id LIMIT 1;
  raw_status:=raw_row.ingest_status;
  raw_expired_at:=CASE WHEN raw_row.expired_at IS NULL THEN NULL ELSE
    to_char(raw_row.expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
  product:=CASE WHEN restricted_disposition_id IS NULL
    AND raw_row.ingest_status='ACCEPTED' THEN raw_row.payload ELSE NULL END;
  RETURN NEXT;
END $body$;

ALTER FUNCTION public._discovery_company_materialization_lock_raw_fact_v1(UUID,UUID)
  OWNER TO discovery_materialization_fact_reader;
REVOKE ALL ON FUNCTION public._discovery_company_materialization_lock_raw_fact_v1(UUID,UUID)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,
  runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION public._discovery_company_materialization_lock_raw_fact_v1(UUID,UUID)
  TO discovery_materialization_function_owner;

CREATE FUNCTION public._discovery_company_materialization_json_keys_exact_v1(
  p_value JSONB, p_keys TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog,public
AS $body$
  SELECT jsonb_typeof(p_value)='object'
    AND (SELECT coalesce(array_agg(key ORDER BY key),ARRAY[]::TEXT[])
         FROM jsonb_object_keys(p_value) key)
      =(SELECT coalesce(array_agg(key ORDER BY key),ARRAY[]::TEXT[])
        FROM unnest(p_keys) key)
$body$;

CREATE FUNCTION public._discovery_company_materialization_uuid_v1(
  p_value TEXT,p_nullable BOOLEAN DEFAULT false
) RETURNS UUID
LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog,public
AS $body$
BEGIN
  IF p_value IS NULL AND p_nullable THEN RETURN NULL; END IF;
  IF p_value IS NULL OR p_value !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  RETURN p_value::UUID;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001';
END $body$;

CREATE FUNCTION public._discovery_company_materialization_integer_v1(
  p_value TEXT,p_minimum INTEGER,p_maximum INTEGER,p_nullable BOOLEAN DEFAULT false
) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog,public
AS $body$
DECLARE parsed BIGINT;
BEGIN
  IF p_value IS NULL AND p_nullable THEN RETURN NULL; END IF;
  IF p_value IS NULL OR p_value !~ '^(0|[1-9][0-9]{0,9})$'
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  parsed:=p_value::BIGINT;
  IF parsed NOT BETWEEN p_minimum AND p_maximum
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  RETURN parsed::INTEGER;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001';
END $body$;

CREATE FUNCTION public._discovery_company_materialization_confidence_v1(
  p_value TEXT,p_nullable BOOLEAN DEFAULT false
) RETURNS DOUBLE PRECISION
LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog,public
AS $body$
DECLARE parsed DOUBLE PRECISION;
BEGIN
  IF p_value IS NULL AND p_nullable THEN RETURN NULL; END IF;
  IF p_value IS NULL OR p_value !~ '^(0|1|0\.[0-9]{1,18}|1\.0{1,18})$'
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  parsed:=p_value::DOUBLE PRECISION;
  IF parsed<0 OR parsed>1 OR parsed IN('NaN'::DOUBLE PRECISION,
      'Infinity'::DOUBLE PRECISION,'-Infinity'::DOUBLE PRECISION)
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  RETURN parsed;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001';
END $body$;

CREATE FUNCTION public._discovery_company_materialization_timestamp_v1(
  p_value TEXT,p_nullable BOOLEAN DEFAULT false
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog,public
AS $body$
BEGIN
  IF p_value IS NULL AND p_nullable THEN RETURN NULL; END IF;
  IF p_value IS NULL OR p_value !~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  RETURN p_value::TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001';
END $body$;

CREATE FUNCTION public._discovery_company_materialization_assert_caller_v1(
  p_workspace_id UUID
) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role',true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM public.current_workspace_id()
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
      USING ERRCODE='42501';
  END IF;
END $body$;

CREATE FUNCTION public._discovery_company_materialization_identity_v1(
  p_identity JSONB, p_with_admission BOOLEAN, p_with_query BOOLEAN,
  OUT workspace_id UUID, OUT admission_id UUID, OUT run_id UUID,
  OUT query_key CHAR(64), OUT batch_ordinal INTEGER
) RETURNS RECORD
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
DECLARE expected TEXT[]:=ARRAY['workspaceId','runId'];
BEGIN
  IF p_with_admission THEN expected:=array_append(expected,'admissionId'); END IF;
  IF p_with_query THEN expected:=expected||ARRAY['queryKey','batchOrdinal']; END IF;
  IF NOT public._discovery_company_materialization_json_keys_exact_v1(p_identity,expected)
    OR p_with_query AND (
      p_identity->>'queryKey' !~ '^[0-9a-f]{64}$'
      OR p_identity->>'batchOrdinal' !~ '^(0|[1-9][0-9]{0,3})$')
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
      USING ERRCODE='P0001';
  END IF;
  workspace_id:=public._discovery_company_materialization_uuid_v1(p_identity->>'workspaceId');
  run_id:=public._discovery_company_materialization_uuid_v1(p_identity->>'runId');
  admission_id:=CASE WHEN p_with_admission THEN
    public._discovery_company_materialization_uuid_v1(p_identity->>'admissionId') END;
  query_key:=CASE WHEN p_with_query THEN (p_identity->>'queryKey')::CHAR(64) END;
  batch_ordinal:=CASE WHEN p_with_query THEN public._discovery_company_materialization_integer_v1(
    p_identity->>'batchOrdinal',0,4095) END;
  PERFORM public._discovery_company_materialization_assert_caller_v1(workspace_id);
END $body$;

CREATE FUNCTION public.reject_unconsumed_discovery_company_materialization_fence_v1()
RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
BEGIN
  IF EXISTS(SELECT 1 FROM public.discovery_company_materialization_tx_fence fence
      WHERE fence.fence_id=NEW.fence_id) THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001';
  END IF;
  RETURN NULL;
END $body$;

CREATE CONSTRAINT TRIGGER discovery_company_materialization_tx_fence_guard
AFTER INSERT ON public.discovery_company_materialization_tx_fence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.reject_unconsumed_discovery_company_materialization_fence_v1();

CREATE FUNCTION public.admit_discovery_company_materialization_v1(p_identity JSONB)
RETURNS TABLE(status TEXT,admission_id UUID,mode TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
DECLARE identity_row RECORD; run_row public.discovery_run%ROWTYPE;
  existing public.discovery_company_materialization_admission%ROWTYPE;
  expected_queries INTEGER; q_receipts INTEGER; q_outcomes INTEGER; c_state BIGINT;
BEGIN
  SELECT * INTO identity_row FROM public._discovery_company_materialization_identity_v1(
    p_identity,false,false);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'discovery-company-materialization-run:'||identity_row.workspace_id||':'||identity_row.run_id,0));
  SELECT * INTO run_row FROM public.discovery_run run
    WHERE run.workspace_id=identity_row.workspace_id AND run.id=identity_row.run_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  SELECT * INTO existing FROM public.discovery_company_materialization_admission admission
    WHERE admission.workspace_id=identity_row.workspace_id AND admission.run_id=identity_row.run_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'REPLAYED'::TEXT,existing.admission_id,existing.mode::TEXT;
    RETURN;
  END IF;
  SELECT count(*) INTO c_state FROM (
    SELECT run_id FROM public.discovery_company_materialization_outcome
      WHERE workspace_id=identity_row.workspace_id AND run_id=identity_row.run_id
    UNION ALL SELECT run_id FROM public.discovery_company_materialization_batch_receipt
      WHERE workspace_id=identity_row.workspace_id AND run_id=identity_row.run_id
    UNION ALL SELECT run_id FROM public.discovery_company_materialization_query_receipt
      WHERE workspace_id=identity_row.workspace_id AND run_id=identity_row.run_id
    UNION ALL SELECT run_id FROM public.discovery_company_materialization_run_receipt
      WHERE workspace_id=identity_row.workspace_id AND run_id=identity_row.run_id) state;
  IF c_state<>0 THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
    USING ERRCODE='P0001'; END IF;
  IF run_row.materialization_contract_version IS NULL THEN
    INSERT INTO public.discovery_company_materialization_admission(
      workspace_id,run_id,materialization_contract_version,mode,reason_code,
      q_contract_sha256,contract_sha256)
    VALUES(identity_row.workspace_id,identity_row.run_id,NULL,'LEGACY','PRE_C_NULL_MARKER',NULL,
      '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe')
    RETURNING discovery_company_materialization_admission.admission_id INTO admission_id;
    status:='APPLIED'; mode:='LEGACY'; RETURN NEXT; RETURN;
  END IF;
  IF run_row.materialization_contract_version<>'discovery-company-materialization/v1'
    OR NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_activation activation
      WHERE activation.activation_id=1
        AND activation.contract_version='discovery-company-materialization/v1'
        AND activation.contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe')
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_UNAVAILABLE'
    USING ERRCODE='P0001'; END IF;
  SELECT jsonb_array_length(plan.queries) INTO expected_queries
    FROM public.discovery_query_plan plan WHERE plan.id=run_row.plan_id;
  SELECT count(*) INTO q_receipts FROM public.discovery_query_receipt receipt
    WHERE receipt.workspace_id=identity_row.workspace_id AND receipt.run_id=identity_row.run_id;
  SELECT count(*) INTO q_outcomes FROM public.discovery_query_execution_outcome outcome
    WHERE outcome.workspace_id=identity_row.workspace_id AND outcome.run_id=identity_row.run_id;
  IF expected_queries IS NULL OR q_receipts<>expected_queries OR q_outcomes<>expected_queries
    OR EXISTS(SELECT 1 FROM generate_series(0,expected_queries-1) ordinal
      WHERE NOT EXISTS(SELECT 1 FROM public.discovery_query_receipt receipt
        WHERE receipt.workspace_id=identity_row.workspace_id AND receipt.run_id=identity_row.run_id
          AND receipt.query_ordinal=ordinal))
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
    USING ERRCODE='P0001'; END IF;
  INSERT INTO public.discovery_company_materialization_admission(
    workspace_id,run_id,materialization_contract_version,mode,reason_code,
    q_contract_sha256,contract_sha256)
  VALUES(identity_row.workspace_id,identity_row.run_id,'discovery-company-materialization/v1',
    'GOVERNED_C_TX','GOVERNED_Q_V2_COMPLETE',
    'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
    '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe')
  RETURNING discovery_company_materialization_admission.admission_id INTO admission_id;
  status:='APPLIED'; mode:='GOVERNED_C_TX'; RETURN NEXT;
END $body$;

CREATE FUNCTION public.inspect_discovery_company_materialization_v1(p_identity JSONB)
RETURNS TABLE(status TEXT,next_work JSONB,run_summary JSONB)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
DECLARE identity_row RECORD; admission_row public.discovery_company_materialization_admission%ROWTYPE;
  receipt public.discovery_company_materialization_run_receipt%ROWTYPE;
  query_row RECORD; item_count BIGINT; batch_count INTEGER; missing_batch INTEGER;
  any_state BOOLEAN;
BEGIN
  SELECT * INTO identity_row FROM public._discovery_company_materialization_identity_v1(
    p_identity,true,false);
  SELECT * INTO admission_row FROM public.discovery_company_materialization_admission admission
    WHERE admission.workspace_id=identity_row.workspace_id
      AND admission.admission_id=identity_row.admission_id AND admission.run_id=identity_row.run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  IF admission_row.mode<>'GOVERNED_C_TX' THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
      USING ERRCODE='P0001';
  END IF;
  SELECT * INTO receipt FROM public.discovery_company_materialization_run_receipt run_receipt
    WHERE run_receipt.workspace_id=identity_row.workspace_id AND run_receipt.run_id=identity_row.run_id;
  IF FOUND THEN
    status:='REPLAYED'; next_work:=NULL;
    run_summary:=jsonb_build_object('companies',receipt.companies_count,
      'suppressed',receipt.suppressed_count); RETURN NEXT; RETURN;
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM public.discovery_company_materialization_batch_receipt b
      WHERE b.workspace_id=identity_row.workspace_id AND b.run_id=identity_row.run_id
    UNION ALL SELECT 1 FROM public.discovery_company_materialization_outcome o
      WHERE o.workspace_id=identity_row.workspace_id AND o.run_id=identity_row.run_id
    UNION ALL SELECT 1 FROM public.discovery_company_materialization_query_receipt q
      WHERE q.workspace_id=identity_row.workspace_id AND q.run_id=identity_row.run_id)
    INTO any_state;
  FOR query_row IN SELECT q.query_key,q.query_ordinal
    FROM public.discovery_query_receipt q
    WHERE q.workspace_id=identity_row.workspace_id AND q.run_id=identity_row.run_id
    ORDER BY q.query_ordinal
  LOOP
    IF EXISTS(SELECT 1 FROM public.discovery_company_materialization_query_receipt c
        WHERE c.workspace_id=identity_row.workspace_id AND c.run_id=identity_row.run_id
          AND c.query_key=query_row.query_key) THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.discovery_company_materialization_batch_receipt later
        JOIN public.discovery_query_receipt q2 ON q2.workspace_id=later.workspace_id
          AND q2.run_id=later.run_id AND q2.query_key=later.query_key
        WHERE later.workspace_id=identity_row.workspace_id AND later.run_id=identity_row.run_id
          AND q2.query_ordinal>query_row.query_ordinal)
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    SELECT count(*) INTO item_count FROM public.discovery_query_attempt_item item
      WHERE item.workspace_id=identity_row.workspace_id AND item.run_id=identity_row.run_id
        AND item.query_key=query_row.query_key;
    batch_count:=CASE WHEN item_count=0 THEN 0 ELSE ((item_count-1)/128+1)::INTEGER END;
    SELECT ordinal INTO missing_batch FROM generate_series(0,batch_count-1) ordinal
      WHERE NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_batch_receipt b
        WHERE b.workspace_id=identity_row.workspace_id AND b.run_id=identity_row.run_id
          AND b.query_key=query_row.query_key AND b.batch_ordinal=ordinal)
      ORDER BY ordinal LIMIT 1;
    status:=CASE WHEN any_state THEN 'PARTIAL_RESUMABLE' ELSE 'NOT_FOUND' END;
    next_work:=CASE WHEN missing_batch IS NULL
      THEN jsonb_build_object('kind','FINALIZE_QUERY','queryKey',query_row.query_key,
        'queryOrdinal',query_row.query_ordinal)
      ELSE jsonb_build_object('kind','BATCH','queryKey',query_row.query_key,
        'queryOrdinal',query_row.query_ordinal,'batchOrdinal',missing_batch) END;
    run_summary:=NULL; RETURN NEXT; RETURN;
  END LOOP;
  status:=CASE WHEN any_state THEN 'PARTIAL_RESUMABLE' ELSE 'NOT_FOUND' END;
  next_work:=jsonb_build_object('kind','FINALIZE_RUN'); run_summary:=NULL; RETURN NEXT;
END $body$;

CREATE FUNCTION public.lock_discovery_company_materialization_batch_facts_v1(p_identity JSONB)
RETURNS TABLE(status TEXT,fence_id UUID,snapshot_sha256 CHAR(64),facts JSONB)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
DECLARE identity_row RECORD; admission_row public.discovery_company_materialization_admission%ROWTYPE;
  current_work RECORD; item_row RECORD; attempt_row public.discovery_query_operation_attempt%ROWTYPE;
  relation_result RECORD; raw_fact RECORD; prior_row RECORD; facts_value JSONB:='[]'::JSONB;
  snapshot_value CHAR(64); suppression_snapshot JSONB;
BEGIN
  SELECT * INTO identity_row FROM public._discovery_company_materialization_identity_v1(
    p_identity,true,true);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'acquisition-suppression-policy:'||identity_row.workspace_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'discovery-company-materialization-run:'||identity_row.workspace_id||':'||identity_row.run_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'discovery-company-materialization:'||identity_row.workspace_id||':'||identity_row.run_id||':'||identity_row.query_key,0));
  SELECT * INTO admission_row FROM public.discovery_company_materialization_admission admission
    WHERE admission.workspace_id=identity_row.workspace_id
      AND admission.admission_id=identity_row.admission_id AND admission.run_id=identity_row.run_id
      AND admission.mode='GOVERNED_C_TX';
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.discovery_query_receipt earlier
      WHERE earlier.workspace_id=identity_row.workspace_id AND earlier.run_id=identity_row.run_id
        AND earlier.query_ordinal<(SELECT query_ordinal FROM public.discovery_query_receipt target
          WHERE target.workspace_id=identity_row.workspace_id AND target.run_id=identity_row.run_id
            AND target.query_key=identity_row.query_key)
        AND NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_query_receipt c
          WHERE c.workspace_id=earlier.workspace_id AND c.run_id=earlier.run_id
            AND c.query_key=earlier.query_key))
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
    USING ERRCODE='P0001'; END IF;
  -- The global cursor is ordered by query_ordinal,batch_ordinal and admits only its LIMIT 1 row.
  WITH expected AS (
    SELECT q.query_key,q.query_ordinal,ordinal AS batch_ordinal
    FROM public.discovery_query_receipt q
    CROSS JOIN LATERAL generate_series(0,
      CASE WHEN (SELECT count(*) FROM public.discovery_query_attempt_item i
        WHERE i.workspace_id=q.workspace_id AND i.run_id=q.run_id AND i.query_key=q.query_key)=0
        THEN -1 ELSE (((SELECT count(*) FROM public.discovery_query_attempt_item i
          WHERE i.workspace_id=q.workspace_id AND i.run_id=q.run_id AND i.query_key=q.query_key)-1)/128)::INTEGER END) ordinal
    WHERE q.workspace_id=identity_row.workspace_id AND q.run_id=identity_row.run_id
      AND NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_batch_receipt b
        WHERE b.workspace_id=q.workspace_id AND b.run_id=q.run_id AND b.query_key=q.query_key
          AND b.batch_ordinal=ordinal)
    ORDER BY query_ordinal,batch_ordinal LIMIT 1
  ) SELECT * INTO current_work FROM expected;
  IF NOT FOUND OR current_work.query_key IS DISTINCT FROM identity_row.query_key
    OR current_work.batch_ordinal IS DISTINCT FROM identity_row.batch_ordinal
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
    USING ERRCODE='P0001'; END IF;
  SELECT jsonb_build_object('count',count(*),'sha256',encode(digest(convert_to(
      coalesce(string_agg(
        octet_length(suppression.id::TEXT)::TEXT||':'||suppression.id::TEXT||
        octet_length(suppression.type)::TEXT||':'||suppression.type||
        octet_length(suppression.value)::TEXT||':'||suppression.value,
        '' ORDER BY suppression.id),''),'UTF8'),'sha256'),'hex'))
    INTO suppression_snapshot FROM public.suppression_record suppression
    WHERE suppression.workspace_id=identity_row.workspace_id
      AND suppression.type IN('domain','company_name');
  snapshot_value:=(suppression_snapshot->>'sha256')::CHAR(64);
  -- Rank the entire Q set canonically; this function returns exactly one physical batch of 128.
  FOR item_row IN SELECT ranked.* FROM (
    SELECT item.*,row_number() OVER(
      ORDER BY provider_key,record_index,raw_record_id,id) AS position
    FROM public.discovery_query_attempt_item item
    WHERE item.workspace_id=identity_row.workspace_id AND item.run_id=identity_row.run_id
      AND item.query_key=identity_row.query_key) ranked
    WHERE ((ranked.position-1) / 128)=identity_row.batch_ordinal
    ORDER BY ranked.raw_record_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'discovery-company-raw-identity:'||identity_row.workspace_id||':'||item_row.raw_record_id,0));
    SELECT * INTO STRICT raw_fact
      FROM public._discovery_company_materialization_lock_raw_fact_v1(
        identity_row.workspace_id,item_row.raw_record_id);
    SELECT * INTO STRICT attempt_row FROM public.discovery_query_operation_attempt attempt
      WHERE attempt.workspace_id=identity_row.workspace_id AND attempt.operation_id=item_row.operation_id;
    SELECT * INTO STRICT relation_result FROM public.attest_workspace_governed_child_relation_v1(
      identity_row.workspace_id,attempt_row.authority_id,attempt_row.account_id,
      attempt_row.operation_id,attempt_row.operation_generation,attempt_row.ack_id,
      attempt_row.result_digest,'tool_operation',attempt_row.operation_id,'NON_PERSONAL',
      NULL,NULL,NULL,'raw_source_record',item_row.raw_record_id,'NON_PERSONAL',NULL,NULL,
      item_row.relation_key,'MATERIALIZED_CHILD','discovery_query_attempt_item',item_row.id,
      NULL,item_row.contract_sha256);
    IF relation_result.replay IS DISTINCT FROM true
      OR relation_result.child_subject_id IS DISTINCT FROM item_row.child_subject_id
      OR relation_result.relation_id IS DISTINCT FROM item_row.relation_id
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    IF EXISTS(SELECT 1 FROM public.discovery_company_materialization_outcome orphan
        WHERE orphan.workspace_id=identity_row.workspace_id
          AND orphan.run_id=identity_row.run_id AND orphan.query_item_id=item_row.id)
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    FOR prior_row IN SELECT prior.* FROM public.discovery_company_materialization_outcome prior
      JOIN public.discovery_company_materialization_batch_receipt covering
        ON covering.workspace_id=prior.workspace_id AND covering.run_id=prior.run_id
        AND covering.query_key=prior.query_key AND covering.batch_ordinal=prior.batch_ordinal
      WHERE prior.workspace_id=identity_row.workspace_id AND prior.run_id=identity_row.run_id
        AND prior.raw_record_id=item_row.raw_record_id AND prior.outcome='CANONICALIZED'
      ORDER BY prior.query_ordinal,prior.record_index,prior.query_item_id
    LOOP
      SELECT * INTO STRICT attempt_row FROM public.discovery_query_operation_attempt attempt
        WHERE attempt.workspace_id=identity_row.workspace_id
          AND attempt.operation_id=prior_row.operation_id;
      SELECT * INTO STRICT relation_result FROM public.attest_workspace_governed_child_relation_v1(
        identity_row.workspace_id,attempt_row.authority_id,attempt_row.account_id,
        attempt_row.operation_id,attempt_row.operation_generation,attempt_row.ack_id,
        attempt_row.result_digest,'tool_operation',attempt_row.operation_id,'NON_PERSONAL',
        NULL,NULL,prior_row.raw_governed_subject_id,'canonical_company',
        prior_row.canonical_company_id,'NON_PERSONAL',NULL,NULL,prior_row.c_relation_key,
        'DERIVED_FROM','discovery_company_materialization_outcome',prior_row.query_item_id,
        NULL,prior_row.contract_sha256);
      IF relation_result.replay IS DISTINCT FROM true
        OR relation_result.child_subject_id IS DISTINCT FROM prior_row.canonical_governed_subject_id
        OR relation_result.relation_id IS DISTINCT FROM prior_row.c_relation_id
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
        USING ERRCODE='P0001'; END IF;
    END LOOP;
    facts_value:=facts_value||jsonb_build_array(jsonb_build_object(
      'qItem',jsonb_build_object('queryItemId',item_row.id,'queryKey',item_row.query_key,
        'queryOrdinal',current_work.query_ordinal,'providerKey',item_row.provider_key,
        'recordIndex',item_row.record_index,'operationId',item_row.operation_id,
        'rawRecordId',item_row.raw_record_id,'rawGovernedSubjectId',item_row.child_subject_id,
        'qRelationId',item_row.relation_id,'qIngestStatus',item_row.raw_ingest_status),
      'lockedFacts',jsonb_build_object('rawStatus',raw_fact.raw_status,
        'rawExpiredAt',raw_fact.raw_expired_at,
        'restrictedDispositionId',raw_fact.restricted_disposition_id,
        'suppressionSnapshotCount',(suppression_snapshot->>'count')::INTEGER,
        'suppressionSnapshotSha256',suppression_snapshot->>'sha256',
        'product',raw_fact.product),
      'exactExistingOutcome',NULL,
      'reusableIdentity',(SELECT jsonb_build_object(
        'canonicalCompanyId',prior.canonical_company_id,'identityLinkId',prior.identity_link_id,
        'identityCanonicalType',prior.identity_canonical_type,
        'canonicalGovernedSubjectId',prior.canonical_governed_subject_id,
        'cRelationId',NULL,'cRelationKey','discovery.canonical_company:'||item_row.record_index,
        'matchRule',prior.match_rule,'confidence',prior.confidence,
        'mutationClass','REUSED','evidenceCount',prior.evidence_count,
        'evidenceManifestSha256',prior.evidence_manifest_sha256)
        FROM public.discovery_company_materialization_outcome prior
        JOIN public.discovery_company_materialization_batch_receipt covering
          ON covering.workspace_id=prior.workspace_id AND covering.run_id=prior.run_id
          AND covering.query_key=prior.query_key AND covering.batch_ordinal=prior.batch_ordinal
        WHERE prior.workspace_id=identity_row.workspace_id AND prior.run_id=identity_row.run_id
          AND prior.raw_record_id=item_row.raw_record_id AND prior.outcome='CANONICALIZED'
        ORDER BY prior.query_ordinal,prior.record_index,prior.query_item_id LIMIT 1),
      'reusableManifestCandidates',(SELECT coalesce(jsonb_agg(jsonb_build_object(
        'workspaceId',prior.workspace_id,'admissionId',prior.admission_id,'runId',prior.run_id,
        'rawRecordId',prior.raw_record_id,'identityLinkId',prior.identity_link_id,
        'canonicalCompanyId',prior.canonical_company_id,'contractSha256',prior.contract_sha256,
        'evidenceCount',prior.evidence_count,'evidenceManifestSha256',prior.evidence_manifest_sha256,
        'queryItemId',prior.query_item_id,'operationId',prior.operation_id,
        'cRelationId',prior.c_relation_id,'cRelationKey',prior.c_relation_key,
        'sourceRefUuid',prior.query_item_id,'recordIndex',prior.record_index,
        'coveringBatchReceipt',true) ORDER BY prior.query_ordinal,prior.record_index,
        prior.query_item_id),'[]'::JSONB)
        FROM public.discovery_company_materialization_outcome prior
        JOIN public.discovery_company_materialization_batch_receipt covering
          ON covering.workspace_id=prior.workspace_id AND covering.run_id=prior.run_id
          AND covering.query_key=prior.query_key AND covering.batch_ordinal=prior.batch_ordinal
        WHERE prior.workspace_id=identity_row.workspace_id AND prior.run_id=identity_row.run_id
          AND prior.raw_record_id=item_row.raw_record_id AND prior.outcome='CANONICALIZED'),
      'companyParse',NULL,'canonicalWrite',NULL));
  END LOOP;
  IF jsonb_array_length(facts_value)=0 THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
      USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.discovery_company_materialization_tx_fence(
    backend_pid,transaction_id,workspace_id,admission_id,run_id,query_key,batch_ordinal,
    snapshot_sha256)
  VALUES(pg_backend_pid(),pg_current_xact_id(),identity_row.workspace_id,identity_row.admission_id,
    identity_row.run_id,identity_row.query_key,identity_row.batch_ordinal,snapshot_value)
  RETURNING discovery_company_materialization_tx_fence.fence_id INTO fence_id;
  status:='APPLIED'; snapshot_sha256:=snapshot_value; facts:=facts_value; RETURN NEXT;
END $body$;

CREATE FUNCTION public.append_discovery_company_materialization_batch_v1(p_command JSONB)
RETURNS TABLE(status TEXT,batch_ordinal INTEGER)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
DECLARE workspace_id_value UUID; admission_id_value UUID; run_id_value UUID;
  query_key_value CHAR(64); batch_ordinal_value INTEGER; fence_id_value UUID;
  snapshot_value CHAR(64); item_value JSONB; item_count INTEGER; relation_result RECORD;
  attempt_row public.discovery_query_operation_attempt%ROWTYPE; canonical_subject UUID;
  relation_id_value UUID; q_item_row public.discovery_query_attempt_item%ROWTYPE;
  raw_fact RECORD; expected_count INTEGER; expected_first TEXT; expected_last TEXT;
  expected_set_sha CHAR(64); evidence_row RECORD; suppression_ids JSONB;
  suppression_digest CHAR(64); prior_batch public.discovery_company_materialization_batch_receipt%ROWTYPE;
  stored_outcome public.discovery_company_materialization_outcome%ROWTYPE;
  expected_suppression_ids JSONB; suppression_snapshot_count INTEGER;
  suppression_snapshot_sha CHAR(64);
  item_id_value UUID; operation_id_value UUID; raw_id_value UUID;
  raw_subject_id_value UUID; q_relation_id_value UUID; canonical_id_value UUID;
  identity_link_id_value UUID; disposition_id_value UUID;
  query_ordinal_value INTEGER; record_index_value INTEGER; evidence_count_value INTEGER;
  suppression_count_value INTEGER; confidence_value DOUBLE PRECISION;
BEGIN
  IF NOT public._discovery_company_materialization_json_keys_exact_v1(p_command,ARRAY[
      'schemaVersion','workspaceId','admissionId','runId','queryKey','batchOrdinal',
      'fenceId','snapshotSha256','suppressionSnapshotCount','suppressionSnapshotSha256',
      'firstItemKey','lastItemKey','itemSetSha256','items'])
    OR p_command->>'schemaVersion'<>'discovery-company-materialization-append/v1'
    OR jsonb_typeof(p_command->'items')<>'array'
    OR jsonb_array_length(p_command->'items') NOT BETWEEN 1 AND 128
    OR p_command->>'queryKey' !~ '^[0-9a-f]{64}$'
    OR p_command->>'snapshotSha256' !~ '^[0-9a-f]{64}$'
    OR p_command->>'suppressionSnapshotSha256' !~ '^[0-9a-f]{64}$'
    OR p_command->>'itemSetSha256' !~ '^[0-9a-f]{64}$'
    OR length(p_command->>'firstItemKey') NOT BETWEEN 1 AND 512
    OR length(p_command->>'lastItemKey') NOT BETWEEN 1 AND 512
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  workspace_id_value:=public._discovery_company_materialization_uuid_v1(p_command->>'workspaceId');
  admission_id_value:=public._discovery_company_materialization_uuid_v1(p_command->>'admissionId');
  run_id_value:=public._discovery_company_materialization_uuid_v1(p_command->>'runId');
  query_key_value:=(p_command->>'queryKey')::CHAR(64);
  batch_ordinal_value:=public._discovery_company_materialization_integer_v1(
    p_command->>'batchOrdinal',0,4095);
  fence_id_value:=public._discovery_company_materialization_uuid_v1(p_command->>'fenceId');
  snapshot_value:=(p_command->>'snapshotSha256')::CHAR(64);
  suppression_snapshot_count:=public._discovery_company_materialization_integer_v1(
    p_command->>'suppressionSnapshotCount',0,2147483647);
  suppression_snapshot_sha:=(p_command->>'suppressionSnapshotSha256')::CHAR(64);
  IF p_command->>'suppressionSnapshotSha256' !~ '^[0-9a-f]{64}$'
    OR suppression_snapshot_sha IS DISTINCT FROM snapshot_value
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  PERFORM public._discovery_company_materialization_assert_caller_v1(workspace_id_value);
  IF NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_admission admission
      WHERE admission.workspace_id=workspace_id_value AND admission.admission_id=admission_id_value
        AND admission.run_id=run_id_value AND admission.mode='GOVERNED_C_TX')
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  item_count:=jsonb_array_length(p_command->'items');
  IF item_count<>(SELECT count(DISTINCT value->>'queryItemId')
      FROM jsonb_array_elements(p_command->'items') value)
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  SELECT * INTO prior_batch FROM public.discovery_company_materialization_batch_receipt receipt
    WHERE receipt.workspace_id=workspace_id_value AND receipt.run_id=run_id_value
      AND receipt.query_key=query_key_value AND receipt.batch_ordinal=batch_ordinal_value;
  IF FOUND THEN
    IF prior_batch.admission_id IS DISTINCT FROM admission_id_value
      OR prior_batch.expected_item_count IS DISTINCT FROM item_count
      OR prior_batch.first_item_key IS DISTINCT FROM p_command->>'firstItemKey'
      OR prior_batch.last_item_key IS DISTINCT FROM p_command->>'lastItemKey'
      OR prior_batch.item_set_sha256 IS DISTINCT FROM (p_command->>'itemSetSha256')::CHAR(64)
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
      USING ERRCODE='P0001'; END IF;
    FOR item_value IN SELECT value FROM jsonb_array_elements(p_command->'items')
    LOOP
      IF NOT public._discovery_company_materialization_json_keys_exact_v1(item_value,ARRAY[
          'queryItemId','queryKey','queryOrdinal','providerKey','operationId','recordIndex',
          'rawRecordId','rawGovernedSubjectId','qRelationId','qIngestStatus','outcome',
          'contractSha256','canonicalCompanyId','identityLinkId','identityCanonicalType',
          'canonicalGovernedSubjectId','cRelationId','cRelationKey','matchRule','confidence',
          'mutationClass','evidenceCount','evidenceManifestSha256','restrictedDispositionId',
          'suppressionMatchSha256','suppressionMatchCount','rawExpiredAt',
          'notCanonicalizableReasonCode','suppressionRecordIds'])
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
        USING ERRCODE='P0001'; END IF;
      item_id_value:=public._discovery_company_materialization_uuid_v1(
        item_value->>'queryItemId');
      SELECT * INTO stored_outcome FROM public.discovery_company_materialization_outcome outcome
        WHERE outcome.workspace_id=workspace_id_value
          AND outcome.query_item_id=item_id_value
          AND outcome.run_id=run_id_value AND outcome.query_key=query_key_value
          AND outcome.batch_ordinal=batch_ordinal_value;
      IF NOT FOUND OR item_value-ARRAY['suppressionRecordIds','canonicalGovernedSubjectId',
          'cRelationId'] IS DISTINCT FROM jsonb_build_object(
        'queryItemId',stored_outcome.query_item_id,'queryKey',stored_outcome.query_key,
        'queryOrdinal',stored_outcome.query_ordinal,'providerKey',stored_outcome.provider_key,
        'operationId',stored_outcome.operation_id,'recordIndex',stored_outcome.record_index,
        'rawRecordId',stored_outcome.raw_record_id,
        'rawGovernedSubjectId',stored_outcome.raw_governed_subject_id,
        'qRelationId',stored_outcome.q_relation_id,'qIngestStatus',stored_outcome.q_ingest_status,
        'outcome',stored_outcome.outcome,'contractSha256',stored_outcome.contract_sha256,
        'canonicalCompanyId',stored_outcome.canonical_company_id,
        'identityLinkId',stored_outcome.identity_link_id,
        'identityCanonicalType',stored_outcome.identity_canonical_type,
        'cRelationKey',stored_outcome.c_relation_key,'matchRule',stored_outcome.match_rule,
        'confidence',stored_outcome.confidence,'mutationClass',stored_outcome.mutation_class,
        'evidenceCount',stored_outcome.evidence_count,
        'evidenceManifestSha256',stored_outcome.evidence_manifest_sha256,
        'restrictedDispositionId',stored_outcome.restricted_disposition_id,
        'suppressionMatchSha256',stored_outcome.suppression_match_sha256,
        'suppressionMatchCount',stored_outcome.suppression_match_count,
        'rawExpiredAt',CASE WHEN stored_outcome.raw_expired_at IS NULL THEN NULL ELSE
          to_char(stored_outcome.raw_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'notCanonicalizableReasonCode',stored_outcome.not_canonicalizable_reason_code)
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
        USING ERRCODE='P0001'; END IF;
      IF stored_outcome.outcome<>'CANONICALIZED' AND (
          item_value->'canonicalGovernedSubjectId'<>'null'::JSONB
          OR item_value->'cRelationId'<>'null'::JSONB)
        OR stored_outcome.outcome='CANONICALIZED' AND NOT (
          item_value->'canonicalGovernedSubjectId'='null'::JSONB
            AND item_value->'cRelationId'='null'::JSONB
            AND stored_outcome.mutation_class<>'REUSED'
          OR item_value->>'canonicalGovernedSubjectId'=
              stored_outcome.canonical_governed_subject_id::TEXT
            AND item_value->'cRelationId'='null'::JSONB
            AND stored_outcome.mutation_class='REUSED'
          OR item_value->>'canonicalGovernedSubjectId'=
              stored_outcome.canonical_governed_subject_id::TEXT
            AND item_value->>'cRelationId'=stored_outcome.c_relation_id::TEXT)
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
        USING ERRCODE='P0001'; END IF;
      suppression_ids:=item_value->'suppressionRecordIds';
      IF jsonb_typeof(suppression_ids)<>'array'
        OR jsonb_array_length(suppression_ids)<>(SELECT count(DISTINCT value)
          FROM jsonb_array_elements_text(suppression_ids) value)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(suppression_ids) value
          WHERE NOT EXISTS(SELECT 1 FROM public.suppression_record suppression
          WHERE suppression.workspace_id=workspace_id_value
            AND suppression.id=public._discovery_company_materialization_uuid_v1(value)
              AND suppression.type IN('domain','company_name')))
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
        USING ERRCODE='P0001'; END IF;
      SELECT encode(digest(convert_to('['||coalesce(string_agg(to_json(value)::TEXT,','
        ORDER BY value),'')||']','UTF8'),'sha256'),'hex')::CHAR(64)
        INTO suppression_digest FROM jsonb_array_elements_text(suppression_ids) value;
      IF stored_outcome.outcome='SUPPRESSED' AND (
          jsonb_array_length(suppression_ids) IS DISTINCT FROM stored_outcome.suppression_match_count
          OR suppression_digest IS DISTINCT FROM stored_outcome.suppression_match_sha256)
        OR stored_outcome.outcome<>'SUPPRESSED' AND jsonb_array_length(suppression_ids)<>0
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
        USING ERRCODE='P0001'; END IF;
      IF stored_outcome.outcome='CANONICALIZED' THEN
        SELECT * INTO STRICT attempt_row FROM public.discovery_query_operation_attempt attempt
          WHERE attempt.workspace_id=workspace_id_value
            AND attempt.operation_id=stored_outcome.operation_id;
        SELECT * INTO STRICT relation_result FROM public.attest_workspace_governed_child_relation_v1(
          workspace_id_value,attempt_row.authority_id,attempt_row.account_id,
          attempt_row.operation_id,attempt_row.operation_generation,attempt_row.ack_id,
          attempt_row.result_digest,'tool_operation',attempt_row.operation_id,'NON_PERSONAL',
          NULL,NULL,stored_outcome.raw_governed_subject_id,'canonical_company',
          stored_outcome.canonical_company_id,'NON_PERSONAL',NULL,NULL,
          stored_outcome.c_relation_key,'DERIVED_FROM',
          'discovery_company_materialization_outcome',stored_outcome.query_item_id,
          NULL,stored_outcome.contract_sha256);
        IF relation_result.replay IS DISTINCT FROM true
          OR relation_result.child_subject_id IS DISTINCT FROM stored_outcome.canonical_governed_subject_id
          OR relation_result.relation_id IS DISTINCT FROM stored_outcome.c_relation_id
        THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
          USING ERRCODE='P0001'; END IF;
      END IF;
    END LOOP;
    status:='REPLAYED'; batch_ordinal:=batch_ordinal_value; RETURN NEXT; RETURN;
  END IF;
  PERFORM 1 FROM public.discovery_company_materialization_tx_fence fence
    WHERE fence.fence_id=fence_id_value AND fence.workspace_id=workspace_id_value
      AND fence.admission_id=admission_id_value AND fence.run_id=run_id_value
      AND fence.query_key=query_key_value AND fence.batch_ordinal=batch_ordinal_value
      AND fence.snapshot_sha256=snapshot_value AND fence.backend_pid=pg_backend_pid()
      AND fence.transaction_id=pg_current_xact_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
    USING ERRCODE='P0001'; END IF;
  WITH ranked AS (
    SELECT item.*,row_number() OVER(
      ORDER BY provider_key,record_index,raw_record_id,id) AS position,
      provider_key||':'||record_index||':'||raw_record_id||':'||id AS item_key
    FROM public.discovery_query_attempt_item item
    WHERE item.workspace_id=workspace_id_value AND item.run_id=run_id_value
      AND item.query_key=query_key_value
  ), expected AS (
    SELECT * FROM ranked WHERE ((position-1)/128)=batch_ordinal_value
  )
  SELECT count(*),(array_agg(item_key ORDER BY provider_key,record_index,raw_record_id,id))[1],
    (array_agg(item_key ORDER BY provider_key DESC,record_index DESC,raw_record_id DESC,id DESC))[1],
    encode(digest(convert_to('['||string_agg(to_json(item_key)::TEXT,',' ORDER BY
      provider_key,record_index,raw_record_id,id)||']','UTF8'),'sha256'),'hex')::CHAR(64)
  INTO expected_count,expected_first,expected_last,expected_set_sha FROM expected;
  IF expected_count IS DISTINCT FROM item_count
    OR expected_first IS DISTINCT FROM p_command->>'firstItemKey'
    OR expected_last IS DISTINCT FROM p_command->>'lastItemKey'
    OR expected_set_sha IS DISTINCT FROM (p_command->>'itemSetSha256')::CHAR(64)
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
    USING ERRCODE='P0001'; END IF;
  IF EXISTS(
    WITH ranked AS (
      SELECT item.id,row_number() OVER(
        ORDER BY provider_key,record_index,raw_record_id,id) AS position
      FROM public.discovery_query_attempt_item item
      WHERE item.workspace_id=workspace_id_value AND item.run_id=run_id_value
        AND item.query_key=query_key_value
    ), expected AS (
      SELECT id FROM ranked WHERE ((position-1)/128)=batch_ordinal_value
    ), supplied AS (
      SELECT public._discovery_company_materialization_uuid_v1(value->>'queryItemId') AS id
      FROM jsonb_array_elements(p_command->'items') value
    )
    (SELECT id FROM expected EXCEPT SELECT id FROM supplied)
    UNION ALL
    (SELECT id FROM supplied EXCEPT SELECT id FROM expected)
  ) THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT'
    USING ERRCODE='P0001'; END IF;
  FOR item_value IN SELECT value FROM jsonb_array_elements(p_command->'items')
  LOOP
    IF NOT public._discovery_company_materialization_json_keys_exact_v1(item_value,ARRAY[
        'queryItemId','queryKey','queryOrdinal','providerKey','operationId','recordIndex',
        'rawRecordId','rawGovernedSubjectId','qRelationId','qIngestStatus','outcome',
        'contractSha256','canonicalCompanyId','identityLinkId','identityCanonicalType',
        'canonicalGovernedSubjectId','cRelationId','cRelationKey','matchRule','confidence',
        'mutationClass','evidenceCount','evidenceManifestSha256','restrictedDispositionId',
        'suppressionMatchSha256','suppressionMatchCount','rawExpiredAt',
        'notCanonicalizableReasonCode','suppressionRecordIds'])
      OR item_value->>'contractSha256'<>'558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
      OR item_value->>'queryKey'<>query_key_value::TEXT
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
      USING ERRCODE='P0001'; END IF;
    item_id_value:=public._discovery_company_materialization_uuid_v1(
      item_value->>'queryItemId');
    operation_id_value:=public._discovery_company_materialization_uuid_v1(
      item_value->>'operationId');
    raw_id_value:=public._discovery_company_materialization_uuid_v1(
      item_value->>'rawRecordId');
    raw_subject_id_value:=public._discovery_company_materialization_uuid_v1(
      item_value->>'rawGovernedSubjectId');
    q_relation_id_value:=public._discovery_company_materialization_uuid_v1(
      item_value->>'qRelationId');
    query_ordinal_value:=public._discovery_company_materialization_integer_v1(
      item_value->>'queryOrdinal',0,1023);
    record_index_value:=public._discovery_company_materialization_integer_v1(
      item_value->>'recordIndex',0,999999);
    canonical_id_value:=public._discovery_company_materialization_uuid_v1(
      item_value->>'canonicalCompanyId',true);
    identity_link_id_value:=public._discovery_company_materialization_uuid_v1(
      item_value->>'identityLinkId',true);
    disposition_id_value:=public._discovery_company_materialization_uuid_v1(
      item_value->>'restrictedDispositionId',true);
    evidence_count_value:=public._discovery_company_materialization_integer_v1(
      item_value->>'evidenceCount',0,1000000,true);
    suppression_count_value:=public._discovery_company_materialization_integer_v1(
      item_value->>'suppressionMatchCount',1,64,true);
    confidence_value:=public._discovery_company_materialization_confidence_v1(
      item_value->>'confidence',true);
    IF item_value->>'providerKey' !~ '^[a-z][a-z0-9._-]{0,127}$'
      OR item_value->>'qIngestStatus' NOT IN('ACCEPTED','QUARANTINED','REJECTED')
      OR item_value->>'outcome' NOT IN('CANONICALIZED','RAW_QUARANTINED','RAW_REJECTED',
        'RESTRICTED_PROCESSING','SUPPRESSED','NOT_CANONICALIZABLE',
        'EXPIRED_BEFORE_CANONICALIZATION')
      OR item_value->>'evidenceManifestSha256' IS NOT NULL
        AND item_value->>'evidenceManifestSha256' !~ '^[0-9a-f]{64}$'
      OR item_value->>'suppressionMatchSha256' IS NOT NULL
        AND item_value->>'suppressionMatchSha256' !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
      USING ERRCODE='P0001'; END IF;
    SELECT item.* INTO q_item_row FROM public.discovery_query_attempt_item item
      WHERE item.workspace_id=workspace_id_value AND item.id=item_id_value
        AND item.run_id=run_id_value AND item.query_key=query_key_value
        AND item.provider_key=item_value->>'providerKey'
        AND item.operation_id=operation_id_value
        AND item.record_index=record_index_value
        AND item.raw_record_id=raw_id_value
        AND item.child_subject_id=raw_subject_id_value
        AND item.relation_id=q_relation_id_value
        AND item.raw_ingest_status=item_value->>'qIngestStatus';
    IF NOT FOUND OR (SELECT query_ordinal FROM public.discovery_query_receipt receipt
        WHERE receipt.workspace_id=workspace_id_value AND receipt.run_id=run_id_value
          AND receipt.query_key=query_key_value)<>query_ordinal_value
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'discovery-company-raw-identity:'||workspace_id_value||':'||q_item_row.raw_record_id,0));
    SELECT * INTO STRICT raw_fact
      FROM public._discovery_company_materialization_lock_raw_fact_v1(
        workspace_id_value,q_item_row.raw_record_id);
    SELECT jsonb_build_object('count',count(*),'sha256',encode(digest(convert_to(
      coalesce(string_agg(
        octet_length(suppression.id::TEXT)::TEXT||':'||suppression.id::TEXT||
        octet_length(suppression.type)::TEXT||':'||suppression.type||
        octet_length(suppression.value)::TEXT||':'||suppression.value,
        '' ORDER BY suppression.id),''),'UTF8'),'sha256'),'hex'))
      INTO expected_suppression_ids FROM public.suppression_record suppression
      WHERE suppression.workspace_id=workspace_id_value
        AND suppression.type IN('domain','company_name');
    IF public._discovery_company_materialization_integer_v1(
        expected_suppression_ids->>'count',0,2147483647) IS DISTINCT FROM suppression_snapshot_count
      OR (expected_suppression_ids->>'sha256')::CHAR(64) IS DISTINCT FROM suppression_snapshot_sha
      OR (expected_suppression_ids->>'sha256')::CHAR(64) IS DISTINCT FROM snapshot_value
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    suppression_ids:=item_value->'suppressionRecordIds';
    IF jsonb_typeof(suppression_ids)<>'array'
      OR jsonb_array_length(suppression_ids)>64
      OR jsonb_array_length(suppression_ids)<>(SELECT count(DISTINCT value)
        FROM jsonb_array_elements_text(suppression_ids) value)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(suppression_ids) supplied(value)
        WHERE supplied.value !~ '^[0-9a-f-]{36}$')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(suppression_ids) supplied(value)
        WHERE NOT EXISTS(SELECT 1 FROM public.suppression_record suppression
          WHERE suppression.workspace_id=workspace_id_value
            AND suppression.type IN('domain','company_name')
            AND suppression.id=public._discovery_company_materialization_uuid_v1(
              supplied.value)))
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    SELECT encode(digest(convert_to('['||coalesce(string_agg(to_json(value)::TEXT,','
      ORDER BY value),'')||']','UTF8'),'sha256'),'hex')::CHAR(64)
      INTO suppression_digest FROM jsonb_array_elements_text(suppression_ids) value;
    IF item_value->>'outcome'='SUPPRESSED' AND (
        jsonb_array_length(suppression_ids)=0
        OR suppression_count_value<>jsonb_array_length(suppression_ids)
        OR (item_value->>'suppressionMatchSha256')::CHAR(64) IS DISTINCT FROM suppression_digest)
      OR item_value->>'outcome'<>'SUPPRESSED' AND jsonb_array_length(suppression_ids)<>0
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    IF q_item_row.raw_ingest_status='QUARANTINED' THEN
      IF item_value->>'outcome'<>'RAW_QUARANTINED' THEN
        RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
          USING ERRCODE='P0001'; END IF;
    ELSIF q_item_row.raw_ingest_status='REJECTED' THEN
      IF item_value->>'outcome'<>'RAW_REJECTED' THEN
        RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
          USING ERRCODE='P0001'; END IF;
    ELSIF q_item_row.raw_ingest_status='ACCEPTED' THEN
      IF raw_fact.restricted_disposition_id IS NOT NULL THEN
        IF item_value->>'outcome'<>'RESTRICTED_PROCESSING'
          OR disposition_id_value IS DISTINCT FROM raw_fact.restricted_disposition_id
        THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
          USING ERRCODE='P0001'; END IF;
      ELSIF jsonb_array_length(suppression_ids)>0 THEN
        IF item_value->>'outcome'<>'SUPPRESSED' OR disposition_id_value IS NOT NULL
        THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
          USING ERRCODE='P0001'; END IF;
      ELSIF raw_fact.raw_status='EXPIRED' THEN
        IF item_value->>'outcome'='EXPIRED_BEFORE_CANONICALIZATION' THEN
          IF item_value->>'rawExpiredAt' IS DISTINCT FROM raw_fact.raw_expired_at
          THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
            USING ERRCODE='P0001'; END IF;
        ELSIF item_value->>'outcome'<>'CANONICALIZED'
        THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
          USING ERRCODE='P0001'; END IF;
      ELSIF item_value->>'outcome' IN('RAW_QUARANTINED','RAW_REJECTED',
          'RESTRICTED_PROCESSING','SUPPRESSED','EXPIRED_BEFORE_CANONICALIZATION')
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
        USING ERRCODE='P0001'; END IF;
    ELSE RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    canonical_subject:=NULL; relation_id_value:=NULL;
    IF item_value->>'outcome'='CANONICALIZED' THEN
      IF item_value->'cRelationId'<>'null'::JSONB
        OR item_value->>'mutationClass'='REUSED'
          AND (item_value->>'canonicalGovernedSubjectId') IS NULL
        OR item_value->>'mutationClass'<>'REUSED'
          AND item_value->'canonicalGovernedSubjectId'<>'null'::JSONB
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
        USING ERRCODE='P0001'; END IF;
      PERFORM 1 FROM public.canonical_company company
        WHERE company.workspace_id=workspace_id_value
          AND company.id=canonical_id_value FOR SHARE;
      IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.identity_link link
          WHERE link.workspace_id=workspace_id_value
            AND link.id=identity_link_id_value AND link.canonical_type='company'
            AND link.canonical_id=canonical_id_value
            AND link.raw_record_id=raw_id_value
            AND link.match_rule=item_value->>'matchRule'
            AND link.confidence=confidence_value)
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT'
        USING ERRCODE='P0001'; END IF;
      SELECT * INTO STRICT attempt_row FROM public.discovery_query_operation_attempt attempt
        WHERE attempt.workspace_id=workspace_id_value
          AND attempt.operation_id=operation_id_value;
      SELECT * INTO STRICT relation_result FROM public.append_workspace_governed_child_relation_v1(
        workspace_id_value,attempt_row.authority_id,attempt_row.account_id,attempt_row.operation_id,
        attempt_row.operation_generation,attempt_row.ack_id,attempt_row.result_digest,
        'tool_operation',attempt_row.operation_id,'NON_PERSONAL',NULL,NULL,
        raw_subject_id_value,'canonical_company',canonical_id_value,'NON_PERSONAL',NULL,NULL,
        item_value->>'cRelationKey','DERIVED_FROM',
        'discovery_company_materialization_outcome',item_id_value,NULL,
        '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe');
      SELECT * INTO STRICT relation_result FROM public.attest_workspace_governed_child_relation_v1(
        workspace_id_value,attempt_row.authority_id,attempt_row.account_id,attempt_row.operation_id,
        attempt_row.operation_generation,attempt_row.ack_id,attempt_row.result_digest,
        'tool_operation',attempt_row.operation_id,'NON_PERSONAL',NULL,NULL,
        raw_subject_id_value,'canonical_company',canonical_id_value,'NON_PERSONAL',NULL,NULL,
        item_value->>'cRelationKey','DERIVED_FROM',
        'discovery_company_materialization_outcome',item_id_value,NULL,
        '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe');
      canonical_subject:=relation_result.child_subject_id;
      relation_id_value:=relation_result.relation_id;
      IF relation_result.replay IS DISTINCT FROM true
        OR NOT EXISTS(SELECT 1 FROM public.governed_subject subject
          WHERE subject.workspace_id=workspace_id_value AND subject.id=canonical_subject
            AND subject.subject_type='canonical_company'
            AND subject.subject_id=canonical_id_value)
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
        USING ERRCODE='P0001'; END IF;
      IF item_value->>'mutationClass'='REUSED'
        AND canonical_subject IS DISTINCT FROM
          public._discovery_company_materialization_uuid_v1(
            item_value->>'canonicalGovernedSubjectId')
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
        USING ERRCODE='P0001'; END IF;
      SELECT count(*) AS evidence_count,
        encode(digest(convert_to(coalesce(jsonb_agg(jsonb_build_array(evidence.field,
          evidence.id,encode(digest(evidence.value::TEXT,'sha256'),'hex'),
          evidence.provider_key,evidence.license,
          encode(digest(coalesce(evidence.allowed_actions,'null'::JSONB)::TEXT,'sha256'),'hex'))
          ORDER BY evidence.field,evidence.id),'[]'::JSONB)::TEXT,'UTF8'),'sha256'),'hex')::CHAR(64)
          AS evidence_manifest_sha256
      INTO evidence_row FROM public.field_evidence evidence
        WHERE evidence.workspace_id=workspace_id_value AND evidence.entity_type='company'
          AND evidence.entity_id=canonical_id_value
          AND evidence.raw_record_id=raw_id_value;
      IF evidence_row.evidence_count IS DISTINCT FROM evidence_count_value
        OR evidence_row.evidence_manifest_sha256 IS DISTINCT FROM
          (item_value->>'evidenceManifestSha256')::CHAR(64)
      THEN
        IF item_value->>'mutationClass'<>'REUSED' OR NOT EXISTS(
          SELECT 1 FROM public.discovery_company_materialization_outcome prior
          JOIN public.discovery_company_materialization_batch_receipt covering
            ON covering.workspace_id=prior.workspace_id AND covering.run_id=prior.run_id
            AND covering.query_key=prior.query_key AND covering.batch_ordinal=prior.batch_ordinal
          WHERE prior.workspace_id=workspace_id_value AND prior.run_id=run_id_value
            AND prior.query_item_id<>item_id_value
            AND prior.raw_record_id=raw_id_value
            AND prior.identity_link_id=identity_link_id_value
            AND prior.canonical_company_id=canonical_id_value
            AND prior.canonical_governed_subject_id=canonical_subject
            AND prior.outcome='CANONICALIZED' AND prior.contract_sha256=
              '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
            AND prior.evidence_count=evidence_count_value
            AND prior.evidence_manifest_sha256=
              (item_value->>'evidenceManifestSha256')::CHAR(64)
        ) THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
          USING ERRCODE='P0001'; END IF;
      END IF;
      IF raw_fact.raw_status='EXPIRED' AND item_value->>'mutationClass'<>'REUSED'
      THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
        USING ERRCODE='P0001'; END IF;
    END IF;
    INSERT INTO public.discovery_company_materialization_outcome(
      workspace_id,admission_id,run_id,query_item_id,query_key,query_ordinal,provider_key,
      operation_id,record_index,raw_record_id,raw_governed_subject_id,q_relation_id,
      q_ingest_status,batch_ordinal,outcome,canonical_company_id,identity_link_id,
      identity_canonical_type,canonical_governed_subject_id,canonical_governed_subject_type,
      c_relation_id,c_relation_key,match_rule,confidence,mutation_class,evidence_count,
      evidence_manifest_sha256,restricted_disposition_id,suppression_match_sha256,
      suppression_match_count,raw_expired_at,not_canonicalizable_reason_code,contract_sha256)
    VALUES(workspace_id_value,admission_id_value,run_id_value,item_id_value,
      query_key_value,query_ordinal_value,item_value->>'providerKey',
      operation_id_value,record_index_value,raw_id_value,raw_subject_id_value,
      q_relation_id_value,item_value->>'qIngestStatus',batch_ordinal_value,
      item_value->>'outcome',canonical_id_value,identity_link_id_value,
      NULLIF(item_value->>'identityCanonicalType',''),canonical_subject,
      CASE WHEN canonical_subject IS NULL THEN NULL ELSE 'canonical_company' END,
      relation_id_value,item_value->>'cRelationKey',NULLIF(item_value->>'matchRule',''),
      confidence_value,NULLIF(item_value->>'mutationClass',''),evidence_count_value,
      NULLIF(item_value->>'evidenceManifestSha256','')::CHAR(64),
      disposition_id_value,
      NULLIF(item_value->>'suppressionMatchSha256','')::CHAR(64),
      suppression_count_value,
      public._discovery_company_materialization_timestamp_v1(
        item_value->>'rawExpiredAt',true),
      NULLIF(item_value->>'notCanonicalizableReasonCode',''),
      '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe');
  END LOOP;
  INSERT INTO public.discovery_company_materialization_batch_receipt(
    workspace_id,admission_id,run_id,query_key,batch_ordinal,first_item_key,last_item_key,
    expected_item_count,item_set_sha256,outcome_canonicalized_count,
    outcome_raw_quarantined_count,outcome_raw_rejected_count,
    outcome_restricted_processing_count,outcome_suppressed_count,
    outcome_not_canonicalizable_count,outcome_expired_before_canonicalization_count,
    mutation_created_count,mutation_updated_count,mutation_linked_count,mutation_reused_count,
    evidence_manifest_count,evidence_manifest_sha256,contract_sha256)
  SELECT workspace_id_value,admission_id_value,run_id_value,query_key_value,batch_ordinal_value,
    p_command->>'firstItemKey',p_command->>'lastItemKey',item_count,
    (p_command->>'itemSetSha256')::CHAR(64),
    count(*) FILTER(WHERE value->>'outcome'='CANONICALIZED'),
    count(*) FILTER(WHERE value->>'outcome'='RAW_QUARANTINED'),
    count(*) FILTER(WHERE value->>'outcome'='RAW_REJECTED'),
    count(*) FILTER(WHERE value->>'outcome'='RESTRICTED_PROCESSING'),
    count(*) FILTER(WHERE value->>'outcome'='SUPPRESSED'),
    count(*) FILTER(WHERE value->>'outcome'='NOT_CANONICALIZABLE'),
    count(*) FILTER(WHERE value->>'outcome'='EXPIRED_BEFORE_CANONICALIZATION'),
    count(*) FILTER(WHERE value->>'mutationClass'='CREATED'),
    count(*) FILTER(WHERE value->>'mutationClass'='UPDATED'),
    count(*) FILTER(WHERE value->>'mutationClass'='LINKED'),
    count(*) FILTER(WHERE value->>'mutationClass'='REUSED'),
    count(*) FILTER(WHERE value->>'evidenceManifestSha256' IS NOT NULL),
    encode(digest(coalesce(jsonb_agg(jsonb_build_array(value->>'queryItemId',
      value->>'evidenceManifestSha256') ORDER BY value->>'queryItemId'),'[]'::JSONB)::TEXT,'sha256'),'hex'),
    '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
  FROM jsonb_array_elements(p_command->'items') value;
  DELETE FROM public.discovery_company_materialization_tx_fence WHERE fence_id=fence_id_value;
  status:='APPLIED'; batch_ordinal:=batch_ordinal_value; RETURN NEXT;
END $body$;

CREATE FUNCTION public.finalize_discovery_company_materialization_query_v1(p_identity JSONB)
RETURNS TABLE(status TEXT,query_key CHAR(64))
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
DECLARE identity_row RECORD; query_ordinal_value INTEGER; item_count_value BIGINT;
  batch_count_value INTEGER; aggregate_row RECORD;
  prior public.discovery_company_materialization_query_receipt%ROWTYPE;
BEGIN
  SELECT * INTO identity_row FROM public._discovery_company_materialization_identity_v1(
    p_identity,true,true);
  IF NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_admission admission
      WHERE admission.workspace_id=identity_row.workspace_id
        AND admission.admission_id=identity_row.admission_id
        AND admission.run_id=identity_row.run_id AND admission.mode='GOVERNED_C_TX')
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'discovery-company-materialization-run:'||identity_row.workspace_id||':'||identity_row.run_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'discovery-company-materialization:'||identity_row.workspace_id||':'||identity_row.run_id||':'||identity_row.query_key,0));
  SELECT q.query_ordinal INTO STRICT query_ordinal_value FROM public.discovery_query_receipt q
    WHERE q.workspace_id=identity_row.workspace_id AND q.run_id=identity_row.run_id
      AND q.query_key=identity_row.query_key;
  IF EXISTS(SELECT 1 FROM public.discovery_query_receipt earlier
      WHERE earlier.workspace_id=identity_row.workspace_id AND earlier.run_id=identity_row.run_id
        AND earlier.query_ordinal<query_ordinal_value
        AND NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_query_receipt c
          WHERE c.workspace_id=earlier.workspace_id AND c.run_id=earlier.run_id
            AND c.query_key=earlier.query_key))
    OR EXISTS(SELECT 1 FROM public.discovery_company_materialization_batch_receipt later
      JOIN public.discovery_query_receipt q2 ON q2.workspace_id=later.workspace_id
        AND q2.run_id=later.run_id AND q2.query_key=later.query_key
      WHERE later.workspace_id=identity_row.workspace_id AND later.run_id=identity_row.run_id
        AND q2.query_ordinal>query_ordinal_value)
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
    USING ERRCODE='P0001'; END IF;
  SELECT count(*) INTO item_count_value FROM public.discovery_query_attempt_item item
    WHERE item.workspace_id=identity_row.workspace_id AND item.run_id=identity_row.run_id
      AND item.query_key=identity_row.query_key;
  batch_count_value:=CASE WHEN item_count_value=0 THEN 0 ELSE ((item_count_value-1)/128+1)::INTEGER END;
  SELECT count(*) AS outcome_count,
    count(*) FILTER(WHERE outcome='CANONICALIZED') AS canonicalized,
    count(*) FILTER(WHERE outcome='RAW_QUARANTINED') AS quarantined,
    count(*) FILTER(WHERE outcome='RAW_REJECTED') AS rejected,
    count(*) FILTER(WHERE outcome='RESTRICTED_PROCESSING') AS restricted,
    count(*) FILTER(WHERE outcome='SUPPRESSED') AS suppressed,
    count(*) FILTER(WHERE outcome='NOT_CANONICALIZABLE') AS invalid,
    count(*) FILTER(WHERE outcome='EXPIRED_BEFORE_CANONICALIZATION') AS expired,
    count(*) FILTER(WHERE mutation_class='CREATED') AS created,
    count(*) FILTER(WHERE mutation_class='UPDATED') AS updated,
    count(*) FILTER(WHERE mutation_class='LINKED') AS linked,
    count(*) FILTER(WHERE mutation_class='REUSED') AS reused,
    sum(record_index) AS deterministic_sum
  INTO aggregate_row FROM public.discovery_company_materialization_outcome outcome
    WHERE outcome.workspace_id=identity_row.workspace_id AND outcome.run_id=identity_row.run_id
      AND outcome.query_key=identity_row.query_key;
  IF aggregate_row.outcome_count<>item_count_value
    OR (SELECT count(*) FROM public.discovery_company_materialization_batch_receipt batch
      WHERE batch.workspace_id=identity_row.workspace_id AND batch.run_id=identity_row.run_id
        AND batch.query_key=identity_row.query_key)<>batch_count_value
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
    USING ERRCODE='P0001'; END IF;
  SELECT * INTO prior FROM public.discovery_company_materialization_query_receipt receipt
    WHERE receipt.workspace_id=identity_row.workspace_id
      AND receipt.run_id=identity_row.run_id AND receipt.query_key=identity_row.query_key;
  IF FOUND THEN
    IF prior.admission_id IS DISTINCT FROM identity_row.admission_id
      OR prior.batch_count IS DISTINCT FROM batch_count_value
      OR prior.item_count IS DISTINCT FROM item_count_value
      OR prior.outcome_canonicalized_count IS DISTINCT FROM aggregate_row.canonicalized
      OR prior.outcome_raw_quarantined_count IS DISTINCT FROM aggregate_row.quarantined
      OR prior.outcome_raw_rejected_count IS DISTINCT FROM aggregate_row.rejected
      OR prior.outcome_restricted_processing_count IS DISTINCT FROM aggregate_row.restricted
      OR prior.outcome_suppressed_count IS DISTINCT FROM aggregate_row.suppressed
      OR prior.outcome_not_canonicalizable_count IS DISTINCT FROM aggregate_row.invalid
      OR prior.outcome_expired_before_canonicalization_count IS DISTINCT FROM aggregate_row.expired
      OR prior.mutation_created_count IS DISTINCT FROM aggregate_row.created
      OR prior.mutation_updated_count IS DISTINCT FROM aggregate_row.updated
      OR prior.mutation_linked_count IS DISTINCT FROM aggregate_row.linked
      OR prior.mutation_reused_count IS DISTINCT FROM aggregate_row.reused
      OR prior.companies_count IS DISTINCT FROM aggregate_row.created+aggregate_row.updated
      OR prior.contract_sha256 IS DISTINCT FROM
        '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
      USING ERRCODE='P0001'; END IF;
    status:='REPLAYED'; query_key:=identity_row.query_key; RETURN NEXT; RETURN;
  END IF;
  INSERT INTO public.discovery_company_materialization_query_receipt(
    workspace_id,admission_id,run_id,query_key,batch_count,item_count,
    outcome_canonicalized_count,outcome_raw_quarantined_count,outcome_raw_rejected_count,
    outcome_restricted_processing_count,outcome_suppressed_count,
    outcome_not_canonicalizable_count,outcome_expired_before_canonicalization_count,
    mutation_created_count,mutation_updated_count,mutation_linked_count,mutation_reused_count,
    companies_count,contract_sha256)
  VALUES(identity_row.workspace_id,identity_row.admission_id,identity_row.run_id,
    identity_row.query_key,batch_count_value,item_count_value,aggregate_row.canonicalized,
    aggregate_row.quarantined,aggregate_row.rejected,aggregate_row.restricted,
    aggregate_row.suppressed,aggregate_row.invalid,aggregate_row.expired,
    aggregate_row.created,aggregate_row.updated,aggregate_row.linked,aggregate_row.reused,
    aggregate_row.created+aggregate_row.updated,
    '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe')
  ;
  status:='APPLIED'; query_key:=identity_row.query_key; RETURN NEXT;
END $body$;

CREATE FUNCTION public.finalize_discovery_company_materialization_run_v1(p_identity JSONB)
RETURNS TABLE(status TEXT,companies BIGINT,suppressed BIGINT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public
AS $body$
DECLARE identity_row RECORD; expected_count INTEGER; aggregate_row RECORD;
  header_digest CHAR(64); prior public.discovery_company_materialization_run_receipt%ROWTYPE;
BEGIN
  SELECT * INTO identity_row FROM public._discovery_company_materialization_identity_v1(
    p_identity,true,false);
  IF NOT EXISTS(SELECT 1 FROM public.discovery_company_materialization_admission admission
      WHERE admission.workspace_id=identity_row.workspace_id
        AND admission.admission_id=identity_row.admission_id
        AND admission.run_id=identity_row.run_id AND admission.mode='GOVERNED_C_TX')
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID'
    USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'discovery-company-materialization-run:'||identity_row.workspace_id||':'||identity_row.run_id,0));
  SELECT * INTO prior FROM public.discovery_company_materialization_run_receipt receipt
    WHERE receipt.workspace_id=identity_row.workspace_id AND receipt.run_id=identity_row.run_id;
  IF FOUND THEN status:='REPLAYED'; companies:=prior.companies_count;
    suppressed:=prior.suppressed_count; RETURN NEXT; RETURN; END IF;
  SELECT count(*) INTO expected_count FROM public.discovery_query_receipt q
    WHERE q.workspace_id=identity_row.workspace_id AND q.run_id=identity_row.run_id;
  IF (SELECT count(*) FROM public.discovery_company_materialization_query_receipt c
      WHERE c.workspace_id=identity_row.workspace_id AND c.run_id=identity_row.run_id)<>expected_count
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD'
    USING ERRCODE='P0001'; END IF;
  SELECT count(*) AS completed_count,sum(c.batch_count) AS batches,sum(c.item_count) AS items,
    sum(c.outcome_canonicalized_count) AS canonicalized,
    sum(c.outcome_raw_quarantined_count) AS quarantined,
    sum(c.outcome_raw_rejected_count) AS rejected,
    sum(c.outcome_restricted_processing_count) AS restricted,
    sum(c.outcome_suppressed_count) AS suppressed_count,
    sum(c.outcome_not_canonicalizable_count) AS invalid,
    sum(c.outcome_expired_before_canonicalization_count) AS expired,
    sum(c.mutation_created_count) AS created,sum(c.mutation_updated_count) AS updated,
    sum(c.mutation_linked_count) AS linked,sum(c.mutation_reused_count) AS reused,
    sum(c.companies_count) AS companies_count
  INTO aggregate_row FROM public.discovery_company_materialization_query_receipt c
    JOIN public.discovery_query_receipt q ON q.workspace_id=c.workspace_id
      AND q.run_id=c.run_id AND q.query_key=c.query_key
    WHERE c.workspace_id=identity_row.workspace_id AND c.run_id=identity_row.run_id;
  SELECT encode(digest(coalesce(jsonb_agg(jsonb_build_array(c.query_key,c.contract_sha256)
      ORDER BY q.query_ordinal),'[]'::JSONB)::TEXT,'sha256'),'hex')::CHAR(64)
    INTO header_digest FROM public.discovery_company_materialization_query_receipt c
    JOIN public.discovery_query_receipt q ON q.workspace_id=c.workspace_id
      AND q.run_id=c.run_id AND q.query_key=c.query_key
    WHERE c.workspace_id=identity_row.workspace_id AND c.run_id=identity_row.run_id;
  INSERT INTO public.discovery_company_materialization_run_receipt(
    workspace_id,admission_id,run_id,expected_query_count,completed_query_count,
    total_batch_count,total_item_count,outcome_canonicalized_count,
    outcome_raw_quarantined_count,outcome_raw_rejected_count,
    outcome_restricted_processing_count,outcome_suppressed_count,
    outcome_not_canonicalizable_count,outcome_expired_before_canonicalization_count,
    mutation_created_count,mutation_updated_count,mutation_linked_count,mutation_reused_count,
    companies_count,suppressed_count,query_header_set_sha256,contract_sha256)
  VALUES(identity_row.workspace_id,identity_row.admission_id,identity_row.run_id,
    expected_count,expected_count,coalesce(aggregate_row.batches,0),coalesce(aggregate_row.items,0),
    coalesce(aggregate_row.canonicalized,0),coalesce(aggregate_row.quarantined,0),
    coalesce(aggregate_row.rejected,0),coalesce(aggregate_row.restricted,0),
    coalesce(aggregate_row.suppressed_count,0),coalesce(aggregate_row.invalid,0),
    coalesce(aggregate_row.expired,0),coalesce(aggregate_row.created,0),
    coalesce(aggregate_row.updated,0),coalesce(aggregate_row.linked,0),
    coalesce(aggregate_row.reused,0),coalesce(aggregate_row.companies_count,0),
    coalesce(aggregate_row.suppressed_count,0),header_digest,
    '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe');
  status:='APPLIED'; companies:=coalesce(aggregate_row.companies_count,0);
  suppressed:=coalesce(aggregate_row.suppressed_count,0); RETURN NEXT;
END $body$;

-- Six public entrypoints and their ordinary helpers deliberately have no
-- BYPASSRLS owner.  FORCE RLS remains active and the caller workspace GUC is
-- therefore part of every product-state read/write.  Only the internal Raw
-- helper above crosses restrictive Raw RLS.
ALTER FUNCTION public._discovery_company_materialization_json_keys_exact_v1(JSONB,TEXT[])
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public._discovery_company_materialization_uuid_v1(TEXT,BOOLEAN)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public._discovery_company_materialization_integer_v1(TEXT,INTEGER,INTEGER,BOOLEAN)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public._discovery_company_materialization_confidence_v1(TEXT,BOOLEAN)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public._discovery_company_materialization_timestamp_v1(TEXT,BOOLEAN)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public._discovery_company_materialization_assert_caller_v1(UUID)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public._discovery_company_materialization_identity_v1(JSONB,BOOLEAN,BOOLEAN)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public.reject_unconsumed_discovery_company_materialization_fence_v1()
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public.admit_discovery_company_materialization_v1(JSONB)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public.inspect_discovery_company_materialization_v1(JSONB)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public.lock_discovery_company_materialization_batch_facts_v1(JSONB)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public.append_discovery_company_materialization_batch_v1(JSONB)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public.finalize_discovery_company_materialization_query_v1(JSONB)
  OWNER TO discovery_materialization_function_owner;
ALTER FUNCTION public.finalize_discovery_company_materialization_run_v1(JSONB)
  OWNER TO discovery_materialization_function_owner;

GRANT USAGE ON SCHEMA public TO discovery_materialization_function_owner;
GRANT SELECT ON public.discovery_run,public.discovery_query_plan,
  public.discovery_query_receipt,public.discovery_query_execution_outcome,
  public.discovery_query_operation_attempt,public.discovery_query_attempt_item,
  public.discovery_company_materialization_activation,
  public.discovery_company_materialization_admission,
  public.discovery_company_materialization_outcome,
  public.discovery_company_materialization_batch_receipt,
  public.discovery_company_materialization_query_receipt,
  public.discovery_company_materialization_run_receipt,
  public.canonical_company,public.identity_link,public.field_evidence,
  public.governed_subject,public.raw_source_record,
  public.raw_source_governance_disposition,public.suppression_record
  TO discovery_materialization_function_owner;
GRANT INSERT ON public.discovery_company_materialization_admission,
  public.discovery_company_materialization_outcome,
  public.discovery_company_materialization_batch_receipt,
  public.discovery_company_materialization_query_receipt,
  public.discovery_company_materialization_run_receipt
  TO discovery_materialization_function_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.discovery_company_materialization_tx_fence
  TO discovery_materialization_function_owner;
-- PostgreSQL requires UPDATE privilege for SELECT ... FOR SHARE/UPDATE even
-- though these routines never issue UPDATE.  Both roles are NOLOGIN with no
-- memberships, and their only reachable SQL is the closed function body.
GRANT UPDATE ON public.discovery_run,public.canonical_company
  TO discovery_materialization_function_owner;
GRANT UPDATE ON public.raw_source_record TO discovery_materialization_fact_reader;
GRANT EXECUTE ON FUNCTION public.append_workspace_governed_child_relation_v1(
  UUID,UUID,UUID,UUID,INTEGER,CHAR(64),CHAR(64),VARCHAR(191),UUID,VARCHAR(16),
  VARCHAR(191),UUID,UUID,VARCHAR(191),UUID,VARCHAR(16),VARCHAR(191),UUID,
  VARCHAR(200),VARCHAR(32),VARCHAR(64),UUID,CHAR(64),CHAR(64))
  TO discovery_materialization_function_owner;
GRANT EXECUTE ON FUNCTION public.attest_workspace_governed_child_relation_v1(
  UUID,UUID,UUID,UUID,INTEGER,CHAR(64),CHAR(64),VARCHAR(191),UUID,VARCHAR(16),
  VARCHAR(191),UUID,UUID,VARCHAR(191),UUID,VARCHAR(16),VARCHAR(191),UUID,
  VARCHAR(200),VARCHAR(32),VARCHAR(64),UUID,CHAR(64),CHAR(64))
  TO discovery_materialization_function_owner;

-- The six public functions are the only runtime execution surface.
REVOKE ALL ON FUNCTION public._discovery_company_materialization_json_keys_exact_v1(JSONB,TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._discovery_company_materialization_uuid_v1(TEXT,BOOLEAN)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._discovery_company_materialization_integer_v1(TEXT,INTEGER,INTEGER,BOOLEAN)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._discovery_company_materialization_confidence_v1(TEXT,BOOLEAN)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._discovery_company_materialization_timestamp_v1(TEXT,BOOLEAN)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public._discovery_company_materialization_assert_caller_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._discovery_company_materialization_identity_v1(JSONB,BOOLEAN,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_unconsumed_discovery_company_materialization_fence_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.admit_discovery_company_materialization_v1(JSONB) FROM PUBLIC,app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.inspect_discovery_company_materialization_v1(JSONB) FROM PUBLIC,app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.lock_discovery_company_materialization_batch_facts_v1(JSONB) FROM PUBLIC,app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.append_discovery_company_materialization_batch_v1(JSONB) FROM PUBLIC,app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.finalize_discovery_company_materialization_query_v1(JSONB) FROM PUBLIC,app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.finalize_discovery_company_materialization_run_v1(JSONB) FROM PUBLIC,app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;

GRANT EXECUTE ON FUNCTION public.admit_discovery_company_materialization_v1(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.inspect_discovery_company_materialization_v1(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.lock_discovery_company_materialization_batch_facts_v1(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.append_discovery_company_materialization_batch_v1(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.finalize_discovery_company_materialization_query_v1(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.finalize_discovery_company_materialization_run_v1(JSONB) TO app_user;

COMMIT;
