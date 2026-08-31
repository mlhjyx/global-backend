BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

CREATE FUNCTION public.discovery_query_json_keys_exact_v1(
  p_value JSONB,
  p_expected TEXT[]
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_typeof(p_value)='object'
    AND COALESCE((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_value) key),'{}')
      = (SELECT array_agg(key ORDER BY key) FROM unnest(p_expected) key)
$$;

CREATE FUNCTION public.assert_discovery_query_lineage_caller_v1(p_workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role',true) IS DISTINCT FROM 'none'
    OR p_workspace_id IS NULL
    OR p_workspace_id IS DISTINCT FROM public.current_workspace_id()
  THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001';
  END IF;
END
$$;

CREATE FUNCTION public.discovery_query_lineage_ack_exact_v1(
  p_workspace_id UUID,
  p_operation_id UUID,
  p_ack_id CHAR(64),
  p_consumer TEXT,
  p_authority_id UUID,
  p_account_id UUID,
  p_result_schema TEXT,
  p_result_digest CHAR(64),
  p_domain_ack_key CHAR(64),
  p_domain_revision CHAR(64),
  p_lock_rows BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed_count INTEGER;
  exact_count INTEGER;
BEGIN
  IF p_lock_rows THEN
    PERFORM 1 FROM public.execution_domain_ack
    WHERE operation_id=p_operation_id AND consumer=p_consumer
      AND domain_aggregate_type IN ('RawSourceRecord','CanonicalCompany')
    ORDER BY ack_id FOR SHARE;
  END IF;
  SELECT count(*),count(*) FILTER(WHERE ack_id=p_ack_id
      AND scope_key=p_workspace_id::text AND authority_id=p_authority_id
      AND account_id=p_account_id AND result_schema=p_result_schema
      AND result_digest=p_result_digest AND domain_aggregate_type='RawSourceRecord'
      AND domain_ack_key=p_domain_ack_key AND domain_revision=p_domain_revision
      AND result_strategy='typed_projection' AND artifact_id IS NULL
      -- xmin is the low 32-bit transaction ID. Reduce xid8 modulo 2^32
      -- instead of casting its epoch-bearing text through xid at wrap.
      AND (NOT p_lock_rows OR xmin::text::bigint=
        (pg_current_xact_id()::text::numeric%4294967296)::bigint))
    INTO allowed_count,exact_count
  FROM public.execution_domain_ack
  WHERE operation_id=p_operation_id AND consumer=p_consumer
    AND domain_aggregate_type IN ('RawSourceRecord','CanonicalCompany');
  RETURN allowed_count=1 AND exact_count=1;
END
$$;

CREATE FUNCTION public.assert_discovery_query_authorization_v1(
  p_workspace_id UUID,
  p_authority_id UUID,
  p_account_id UUID,
  p_account_key TEXT,
  p_generation INTEGER,
  p_request_sha256 CHAR(64)
) RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority public.execution_budget_authority%ROWTYPE;
  account public.tool_budget_account%ROWTYPE;
BEGIN
  SELECT target.* INTO authority FROM public.execution_budget_authority target
  WHERE target.scope_key=p_workspace_id::text AND target.workspace_id=p_workspace_id
    AND target.id=p_authority_id AND target.purpose='discovery.run'
    AND target.subject_type='discovery_run'
    AND target.subject_id='request:'||p_request_sha256::text
    AND target.request_sha256=p_request_sha256 AND target.consumed_at IS NOT NULL
    AND target.revoked_at IS NULL
  FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.execution_budget_authority_revocation revocation
      WHERE revocation.scope_key=p_workspace_id::text
        AND revocation.authority_id=p_authority_id)
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
  SELECT target.* INTO account FROM public.tool_budget_account target
  WHERE target.scope_key=p_workspace_id::text AND target.id=p_account_id
    AND target.authority_id=authority.id AND target.account_key=p_account_key
    AND target.generation=p_generation
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001';
  END IF;
END
$$;

CREATE FUNCTION public.append_discovery_query_lineage_v1(p_append_command JSONB)
RETURNS TABLE(status TEXT,attempt_count INTEGER,item_count INTEGER,query_key TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  lookup_value JSONB;
  receipt_value JSONB;
  authorization_value JSONB;
  attempts_value JSONB;
  items_value JSONB;
  attempt_value JSONB;
  item_value JSONB;
  workspace_id_value UUID;
  run_id_value UUID;
  plan_id_value UUID;
  authority_id_value UUID;
  account_id_value UUID;
  query_key_value CHAR(64);
  query_ordinal_value INTEGER;
  source_class_value TEXT;
  request_sha_value CHAR(64);
  account_key_value TEXT;
  attempt_operation_id UUID;
  attempt_provider_key TEXT;
  attempt_ack_id CHAR(64);
  attempt_consumer TEXT;
  attempt_result_digest CHAR(64);
  attempt_result_schema TEXT;
  attempt_domain_ack_key CHAR(64);
  attempt_domain_revision CHAR(64);
  attempt_generation INTEGER;
  item_id UUID;
  item_raw_id UUID;
  item_operation_id UUID;
  item_provider_key TEXT;
  item_record_index INTEGER;
  relation_result RECORD;
  computed_accepted INTEGER;
  computed_quarantined INTEGER;
  computed_rejected INTEGER;
  computed_duplicate INTEGER;
  existing_count INTEGER;
BEGIN
  IF p_append_command IS NULL OR pg_column_size(p_append_command)>16777216
    OR NOT public.discovery_query_json_keys_exact_v1(p_append_command,ARRAY[
      'schemaVersion','contractSha256','lookup','queryReceipt',
      'queryReceiptContractSha256','rawRelationContractSha256','attempts','items','authorization'])
    OR p_append_command->>'schemaVersion'<>'discovery-query-lineage-command/v1'
    OR p_append_command->>'contractSha256'<>'eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0'
    OR p_append_command->>'queryReceiptContractSha256'<>'eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0'
    OR p_append_command->>'rawRelationContractSha256'<>'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1'
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
  lookup_value:=p_append_command->'lookup';
  receipt_value:=p_append_command->'queryReceipt';
  authorization_value:=p_append_command->'authorization';
  attempts_value:=p_append_command->'attempts';
  items_value:=p_append_command->'items';
  IF NOT public.discovery_query_json_keys_exact_v1(lookup_value,ARRAY[
      'schemaVersion','workspaceId','runId','planId','queryKey','queryOrdinal','authorityId',
      'accountKey','purpose','subjectType','subjectId','requestSha256','sourceClass'])
    OR lookup_value->>'schemaVersion'<>'discovery-query-lineage-lookup/v1'
    OR NOT public.discovery_query_json_keys_exact_v1(receipt_value,ARRAY[
      'schemaVersion','queryKey','queryOrdinal','sourceClass','providers','accepted',
      'quarantined','rejected','governanceDenied','duplicate','usageQuantity','costCents'])
    OR receipt_value->>'schemaVersion'<>'discovery-query-receipt/v1'
    OR NOT public.discovery_query_json_keys_exact_v1(authorization_value,
      ARRAY['accountId','authorityId','generation'])
    OR jsonb_typeof(attempts_value)<>'array' OR jsonb_array_length(attempts_value)>128
    OR jsonb_typeof(items_value)<>'array' OR jsonb_array_length(items_value)>524160
    OR (lookup_value->>'workspaceId')!~'^[0-9a-f-]{36}$'
    OR (lookup_value->>'runId')!~'^[0-9a-f-]{36}$'
    OR (lookup_value->>'planId')!~'^[0-9a-f-]{36}$'
    OR (lookup_value->>'authorityId')!~'^[0-9a-f-]{36}$'
    OR (lookup_value->>'queryKey')!~'^[0-9a-f]{64}$'
    OR (lookup_value->>'requestSha256')!~'^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
  workspace_id_value:=(lookup_value->>'workspaceId')::uuid;
  run_id_value:=(lookup_value->>'runId')::uuid;
  plan_id_value:=(lookup_value->>'planId')::uuid;
  authority_id_value:=(lookup_value->>'authorityId')::uuid;
  query_key_value:=(lookup_value->>'queryKey')::char(64);
  query_ordinal_value:=(lookup_value->>'queryOrdinal')::integer;
  source_class_value:=lookup_value->>'sourceClass';
  request_sha_value:=(lookup_value->>'requestSha256')::char(64);
  account_key_value:=lookup_value->>'accountKey';
  account_id_value:=(authorization_value->>'accountId')::uuid;
  IF (authorization_value->>'authorityId')::uuid<>authority_id_value
    OR (authorization_value->>'generation')::integer NOT BETWEEN 1 AND 2147483647
    OR lookup_value->>'purpose'<>'discovery.run' OR lookup_value->>'subjectType'<>'discovery_run'
    OR (lookup_value->>'subjectId')<>('request:'||request_sha_value::text)
    OR account_key_value<>(
      'discovery.run:discovery_run:request:'||request_sha_value::text||':'||request_sha_value::text)
    OR receipt_value->>'queryKey'<>query_key_value
    OR (receipt_value->>'queryOrdinal')::integer<>query_ordinal_value
    OR receipt_value->>'sourceClass'<>source_class_value
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
  PERFORM public.assert_discovery_query_lineage_caller_v1(workspace_id_value);
  PERFORM public.assert_discovery_query_authorization_v1(workspace_id_value,
    authority_id_value,account_id_value,account_key_value,
    (authorization_value->>'generation')::integer,request_sha_value);
  PERFORM 1 FROM public.discovery_run
    WHERE workspace_id=workspace_id_value AND id=run_id_value AND plan_id=plan_id_value FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_CONFLICT' USING ERRCODE='P0001'; END IF;
  SELECT count(*) INTO existing_count FROM public.discovery_query_receipt receipt
    WHERE receipt.workspace_id=workspace_id_value AND receipt.run_id=run_id_value
      AND (receipt.query_key=query_key_value OR receipt.query_ordinal=query_ordinal_value);
  IF existing_count<>0 THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001';
  END IF;
  IF (receipt_value->>'accepted')::integer+(receipt_value->>'quarantined')::integer+
      (receipt_value->>'rejected')::integer+(receipt_value->>'duplicate')::integer
      <>jsonb_array_length(items_value)
    OR (receipt_value->>'governanceDenied')::integer<>
      (receipt_value->>'quarantined')::integer+(receipt_value->>'rejected')::integer
    OR (receipt_value->>'usageQuantity')::integer<>(receipt_value->>'accepted')::integer
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(receipt_value->'providers') provider
      WHERE provider NOT IN ('public_web','directory','trade_fair')
        OR provider='public_web' AND source_class_value NOT IN ('public_intelligence','industry_data')
        OR provider IN ('directory','trade_fair') AND source_class_value<>'industry_data')
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(attempts_value) attempt
      GROUP BY attempt->>'operationId' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(items_value) item
      GROUP BY item->>'id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(items_value) item
      GROUP BY item->>'operationId',item->>'relationKey' HAVING count(*)>1)
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.discovery_query_receipt(workspace_id,run_id,plan_id,authority_id,
    account_key,purpose,subject_type,subject_id,request_sha256,query_key,query_ordinal,
    source_class,providers,provider_count,record_count,accepted_count,quarantined_count,
    rejected_count,duplicate_count,governance_denied_count,usage_quantity,cost_cents,contract_sha256)
  VALUES(workspace_id_value,run_id_value,plan_id_value,authority_id_value,account_key_value,
    'discovery.run','discovery_run','request:'||request_sha_value,request_sha_value,
    query_key_value,query_ordinal_value,source_class_value,receipt_value->'providers',
    jsonb_array_length(receipt_value->'providers'),jsonb_array_length(items_value),
    (receipt_value->>'accepted')::bigint,(receipt_value->>'quarantined')::bigint,
    (receipt_value->>'rejected')::bigint,(receipt_value->>'duplicate')::bigint,
    (receipt_value->>'governanceDenied')::bigint,(receipt_value->>'usageQuantity')::bigint,
    (receipt_value->>'costCents')::bigint,p_append_command->>'queryReceiptContractSha256');

  FOR attempt_value IN SELECT value FROM jsonb_array_elements(attempts_value) value
    ORDER BY value->>'operationId'
  LOOP
    IF NOT public.discovery_query_json_keys_exact_v1(attempt_value,ARRAY[
      'providerKey','producerId','operationId','authorityId','accountId','operationGeneration',
      'ackId','consumer','domainAggregateType','domainAckKey','domainRevision','resultDigest',
      'resultSchema','lineageSchema','providerRecordCount','coveredItemCount','contractSha256'])
      OR (attempt_value->>'operationId')!~'^[0-9a-f-]{36}$'
      OR (attempt_value->>'ackId')!~'^[0-9a-f]{64}$'
      OR attempt_value->>'domainAggregateType'<>'RawSourceRecord'
      OR attempt_value->>'contractSha256'<>'eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0'
      OR (attempt_value->>'coveredItemCount')::integer NOT BETWEEN 0 AND
        LEAST((attempt_value->>'providerRecordCount')::integer,4095)
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
    attempt_operation_id:=(attempt_value->>'operationId')::uuid;
    attempt_provider_key:=attempt_value->>'providerKey';
    attempt_ack_id:=(attempt_value->>'ackId')::char(64);
    attempt_consumer:=attempt_value->>'consumer';
    attempt_result_digest:=(attempt_value->>'resultDigest')::char(64);
    attempt_result_schema:=attempt_value->>'resultSchema';
    attempt_domain_ack_key:=(attempt_value->>'domainAckKey')::char(64);
    attempt_domain_revision:=(attempt_value->>'domainRevision')::char(64);
    attempt_generation:=(attempt_value->>'operationGeneration')::integer;
    IF (attempt_value->>'authorityId')::uuid<>authority_id_value
      OR (attempt_value->>'accountId')::uuid<>account_id_value
      OR NOT (
        attempt_provider_key='public_web'
          AND source_class_value IN ('public_intelligence','industry_data')
          AND attempt_value->>'producerId'='discovery.extract_company'
          AND attempt_consumer='PublicWebDiscoveryProvider.mineDomain'
          AND attempt_result_schema='discovery-extract-company/v1'
        OR attempt_provider_key='directory'
          AND source_class_value='industry_data'
          AND attempt_value->>'producerId'='discovery.extract_list'
          AND attempt_consumer='DirectoryDiscoveryProvider.extractList'
          AND attempt_result_schema='discovery-extract-list/v1'
        OR attempt_provider_key='trade_fair'
          AND source_class_value='industry_data'
          AND attempt_value->>'producerId'='tradefair.algolia'
          AND attempt_consumer='TradeFairDiscoveryProvider'
          AND attempt_result_schema='tradefair-algolia/v1'
      )
      OR attempt_domain_ack_key<>encode(public.digest(convert_to(
        run_id_value::text||':'||attempt_provider_key||':'||attempt_operation_id::text,'UTF8'),'sha256'),'hex')
      OR attempt_domain_revision<>encode(public.digest(convert_to(
        attempt_result_digest::text,'UTF8'),'sha256'),'hex')
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
    IF NOT public.discovery_query_lineage_ack_exact_v1(workspace_id_value,
        attempt_operation_id,attempt_ack_id,attempt_consumer,authority_id_value,
        account_id_value,attempt_result_schema,attempt_result_digest,
        attempt_domain_ack_key,attempt_domain_revision,true)
      OR NOT EXISTS(SELECT 1 FROM public.tool_budget_operation operation
        WHERE operation.scope_key=workspace_id_value::text AND operation.id=attempt_operation_id
          AND operation.account_id=account_id_value AND operation.generation=attempt_generation
          AND operation.status='SETTLED' AND operation.result_digest=attempt_result_digest FOR SHARE)
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001'; END IF;
    INSERT INTO public.discovery_query_operation_attempt(workspace_id,run_id,query_key,
      provider_key,producer_id,operation_id,scope_key,authority_id,account_id,
      operation_generation,ack_id,consumer,domain_aggregate_type,domain_ack_key,
      domain_revision,result_digest,result_schema,lineage_schema,provider_record_count,
      covered_item_count,contract_sha256)
    VALUES(workspace_id_value,run_id_value,query_key_value,attempt_provider_key,
      attempt_value->>'producerId',attempt_operation_id,workspace_id_value::text,
      authority_id_value,account_id_value,attempt_generation,attempt_ack_id,attempt_consumer,
      'RawSourceRecord',attempt_value->>'domainAckKey',attempt_value->>'domainRevision',
      attempt_result_digest,attempt_result_schema,attempt_value->>'lineageSchema',
      (attempt_value->>'providerRecordCount')::integer,
      (attempt_value->>'coveredItemCount')::integer,attempt_value->>'contractSha256');
  END LOOP;

  IF EXISTS(SELECT 1 FROM jsonb_array_elements(attempts_value) attempt
      WHERE NOT (receipt_value->'providers' ? (attempt->>'providerKey')))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(items_value) item
      WHERE NOT (receipt_value->'providers' ? (item->>'providerKey')))
    OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(attempts_value) attempt
      GROUP BY attempt->>'providerKey'
      HAVING min((attempt->>'providerRecordCount')::integer)<>
        max((attempt->>'providerRecordCount')::integer)
    )
    OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(attempts_value) attempt
      LEFT JOIN LATERAL (
        SELECT count(*)::integer AS count_value
        FROM jsonb_array_elements(items_value) item
        WHERE item->>'operationId'=attempt->>'operationId'
      ) covered ON true
      WHERE covered.count_value<>(attempt->>'coveredItemCount')::integer
    )
    OR EXISTS(
      SELECT 1
      FROM (
        SELECT attempt->>'providerKey' provider_key,
          max((attempt->>'providerRecordCount')::integer) expected_count
        FROM jsonb_array_elements(attempts_value) attempt
        GROUP BY attempt->>'providerKey'
      ) expected
      LEFT JOIN LATERAL (
        SELECT count(*)::integer count_value,
          min((item->>'recordIndex')::integer) min_index,
          max((item->>'recordIndex')::integer) max_index,
          count(DISTINCT (item->>'recordIndex')::integer) distinct_count
        FROM jsonb_array_elements(items_value) item
        WHERE item->>'providerKey'=expected.provider_key
      ) actual ON true
      WHERE actual.count_value<>expected.expected_count
        OR (expected.expected_count>0 AND (
          actual.min_index<>0 OR actual.max_index<>expected.expected_count-1
          OR actual.distinct_count<>expected.expected_count))
    )
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;

  FOR item_value IN SELECT value FROM jsonb_array_elements(items_value) value
    ORDER BY value->>'providerKey',lpad(value->>'recordIndex',10,'0')
  LOOP
    IF NOT public.discovery_query_json_keys_exact_v1(item_value,ARRAY[
      'id','providerKey','operationId','recordIndex','resolutionKind','sourceRecordIndex',
      'rawRecordId','rawPayloadHash','rawIngestStatus','relationKey','sourceRefNamespace',
      'sourceRefUuid','ackId','contractSha256'])
      OR (item_value->>'id')!~'^[0-9a-f-]{36}$'
      OR (item_value->>'rawRecordId')!~'^[0-9a-f-]{36}$'
      OR item_value->>'sourceRefNamespace'<>'discovery_query_attempt_item'
      OR item_value->>'sourceRefUuid'<>item_value->>'id'
      OR item_value->>'contractSha256'<>p_append_command->>'rawRelationContractSha256'
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
    item_id:=(item_value->>'id')::uuid;
    item_raw_id:=(item_value->>'rawRecordId')::uuid;
    item_operation_id:=(item_value->>'operationId')::uuid;
    item_provider_key:=item_value->>'providerKey';
    item_record_index:=(item_value->>'recordIndex')::integer;
    IF NOT EXISTS(SELECT 1 FROM public.raw_source_record raw
        WHERE raw.workspace_id=workspace_id_value AND raw.id=item_raw_id
          AND raw.run_id=run_id_value AND raw.provider_key=item_provider_key
          AND raw.source_class=source_class_value AND raw.ingest_version='raw-source/v2'
          AND raw.payload_hash=item_value->>'rawPayloadHash'
          AND raw.ingest_status=item_value->>'rawIngestStatus' FOR SHARE)
      OR NOT EXISTS(SELECT 1 FROM public.discovery_query_operation_attempt attempt
        WHERE attempt.workspace_id=workspace_id_value AND attempt.operation_id=item_operation_id
          AND attempt.provider_key=item_provider_key AND attempt.ack_id=item_value->>'ackId')
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH' USING ERRCODE='P0001'; END IF;
    BEGIN
      SELECT * INTO STRICT relation_result
      FROM public.append_workspace_governed_child_relation_v1(
        workspace_id_value,authority_id_value,account_id_value,item_operation_id,
        (SELECT operation_generation FROM public.discovery_query_operation_attempt
          WHERE workspace_id=workspace_id_value AND operation_id=item_operation_id),
        (item_value->>'ackId')::char(64),
        (SELECT result_digest FROM public.discovery_query_operation_attempt
          WHERE workspace_id=workspace_id_value AND operation_id=item_operation_id),
        'tool_operation',item_operation_id,'NON_PERSONAL',NULL,NULL,NULL,
        'raw_source_record',item_raw_id,'NON_PERSONAL',NULL,NULL,
        item_value->>'relationKey','MATERIALIZED_CHILD',
        'discovery_query_attempt_item',item_id,NULL,
        (item_value->>'contractSha256')::char(64));
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001';
    END;
    IF relation_result.replay IS TRUE THEN
      RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001';
    END IF;
    INSERT INTO public.discovery_query_attempt_item(id,workspace_id,run_id,query_key,
      provider_key,operation_id,record_index,resolution_kind,source_record_index,
      raw_record_id,raw_payload_hash,raw_ingest_status,relation_key,operation_subject_id,
      child_subject_id,relation_id,contract_sha256)
    VALUES(item_id,workspace_id_value,run_id_value,query_key_value,item_provider_key,
      item_operation_id,item_record_index,item_value->>'resolutionKind',
      CASE WHEN item_value->'sourceRecordIndex'='null'::jsonb THEN NULL
        ELSE (item_value->>'sourceRecordIndex')::integer END,item_raw_id,
      item_value->>'rawPayloadHash',item_value->>'rawIngestStatus',
      item_value->>'relationKey',relation_result.operation_subject_id,
      relation_result.child_subject_id,relation_result.relation_id,
      item_value->>'contractSha256');
  END LOOP;
  SELECT count(*) FILTER(WHERE item.resolution_kind='INSERTED' AND item.raw_ingest_status='ACCEPTED'),
    count(*) FILTER(WHERE item.resolution_kind='INSERTED' AND item.raw_ingest_status='QUARANTINED'),
    count(*) FILTER(WHERE item.resolution_kind='INSERTED' AND item.raw_ingest_status='REJECTED'),
    count(*) FILTER(WHERE item.resolution_kind IN('EXISTING','REUSE_BATCH'))
    INTO computed_accepted,computed_quarantined,computed_rejected,computed_duplicate
  FROM public.discovery_query_attempt_item item
  WHERE item.workspace_id=workspace_id_value AND item.run_id=run_id_value
    AND item.query_key=query_key_value;
  IF computed_accepted<>(receipt_value->>'accepted')::integer
    OR computed_quarantined<>(receipt_value->>'quarantined')::integer
    OR computed_rejected<>(receipt_value->>'rejected')::integer
    OR computed_duplicate<>(receipt_value->>'duplicate')::integer
    OR EXISTS(SELECT 1 FROM public.discovery_query_operation_attempt attempt
      WHERE attempt.workspace_id=workspace_id_value AND attempt.run_id=run_id_value
        AND attempt.query_key=query_key_value AND attempt.covered_item_count<>
          (SELECT count(*) FROM public.discovery_query_attempt_item item
            WHERE item.workspace_id=attempt.workspace_id AND item.operation_id=attempt.operation_id))
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_CONFLICT' USING ERRCODE='P0001'; END IF;
  RETURN QUERY SELECT 'APPLIED',jsonb_array_length(attempts_value),
    jsonb_array_length(items_value),query_key_value::text;
EXCEPTION
  WHEN data_exception THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001';
  WHEN integrity_constraint_violation THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001';
END
$$;

CREATE FUNCTION public.attest_discovery_query_authorization_v1(
  p_workspace_id UUID,
  p_authority_id UUID,
  p_account_key TEXT,
  p_request_sha256 CHAR(64)
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  matched_count INTEGER;
BEGIN
  SELECT count(*) INTO matched_count
  FROM public.execution_budget_authority authority
  JOIN public.tool_budget_account account
    ON account.scope_key=authority.scope_key AND account.authority_id=authority.id
  LEFT JOIN public.execution_budget_authority_revocation revocation
    ON revocation.scope_key=authority.scope_key AND revocation.authority_id=authority.id
  WHERE authority.scope_key=p_workspace_id::text AND authority.workspace_id=p_workspace_id
    AND authority.id=p_authority_id AND authority.purpose='discovery.run'
    AND authority.subject_type='discovery_run'
    AND authority.subject_id='request:'||p_request_sha256::text
    AND authority.request_sha256=p_request_sha256 AND authority.consumed_at IS NOT NULL
    AND authority.revoked_at IS NULL AND revocation.authority_id IS NULL
    AND account.account_key=p_account_key;
  IF matched_count<>1 THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD'
      USING ERRCODE='P0001';
  END IF;
END
$$;

CREATE FUNCTION public.attest_discovery_query_lineage_v1(p_attestation_key JSONB)
RETURNS TABLE(status TEXT,query_receipt JSONB,attempt_count INTEGER,item_count INTEGER,replay BOOLEAN)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  workspace_id_value UUID;
  run_id_value UUID;
  query_key_value CHAR(64);
  receipt_row public.discovery_query_receipt%ROWTYPE;
  attempt_row public.discovery_query_operation_attempt%ROWTYPE;
  item_row public.discovery_query_attempt_item%ROWTYPE;
  relation_result RECORD;
  collision_count INTEGER;
  query_ordinal_value INTEGER;
BEGIN
  IF p_attestation_key IS NULL OR pg_column_size(p_attestation_key)>16384
    OR NOT public.discovery_query_json_keys_exact_v1(p_attestation_key,ARRAY[
      'schemaVersion','workspaceId','runId','planId','queryKey','queryOrdinal','authorityId',
      'accountKey','purpose','subjectType','subjectId','requestSha256'])
    OR p_attestation_key->>'schemaVersion'<>'discovery-query-lineage-lookup/v1'
    OR (p_attestation_key->>'workspaceId')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (p_attestation_key->>'runId')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (p_attestation_key->>'queryKey')!~'^[0-9a-f]{64}$'
    OR jsonb_typeof(p_attestation_key->'queryOrdinal')<>'number'
    OR (p_attestation_key->>'queryOrdinal')!~'^(0|[1-9][0-9]{0,3})$'
    OR (p_attestation_key->>'queryOrdinal')::integer NOT BETWEEN 0 AND 1023
    OR p_attestation_key->>'purpose'<>'discovery.run'
    OR p_attestation_key->>'subjectType'<>'discovery_run'
    OR p_attestation_key->>'requestSha256'!~'^[0-9a-f]{64}$'
    OR (p_attestation_key->>'subjectId')<>
      ('request:'||(p_attestation_key->>'requestSha256'))
    OR (p_attestation_key->>'accountKey')<>
      ('discovery.run:discovery_run:request:'||(p_attestation_key->>'requestSha256')||
       ':'||(p_attestation_key->>'requestSha256'))
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001'; END IF;
  workspace_id_value:=(p_attestation_key->>'workspaceId')::uuid;
  run_id_value:=(p_attestation_key->>'runId')::uuid;
  query_key_value:=(p_attestation_key->>'queryKey')::char(64);
  query_ordinal_value:=(p_attestation_key->>'queryOrdinal')::integer;
  PERFORM public.assert_discovery_query_lineage_caller_v1(workspace_id_value);
  SELECT count(*) INTO collision_count FROM public.discovery_query_receipt receipt
    WHERE receipt.workspace_id=workspace_id_value AND receipt.run_id=run_id_value
      AND (receipt.query_key=query_key_value OR receipt.query_ordinal=query_ordinal_value);
  IF collision_count=0 THEN
    RETURN QUERY SELECT 'NOT_FOUND',NULL::jsonb,0,0,false;
    RETURN;
  ELSIF collision_count<>1 THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO receipt_row FROM public.discovery_query_receipt
    WHERE workspace_id=workspace_id_value AND run_id=run_id_value AND query_key=query_key_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001';
  END IF;
  IF receipt_row.plan_id::text<>p_attestation_key->>'planId'
    OR receipt_row.query_ordinal<>(p_attestation_key->>'queryOrdinal')::integer
    OR receipt_row.authority_id::text<>p_attestation_key->>'authorityId'
    OR receipt_row.account_key<>p_attestation_key->>'accountKey'
    OR receipt_row.purpose<>p_attestation_key->>'purpose'
    OR receipt_row.subject_type<>p_attestation_key->>'subjectType'
    OR receipt_row.subject_id<>p_attestation_key->>'subjectId'
    OR receipt_row.request_sha256<>p_attestation_key->>'requestSha256'
  THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001'; END IF;
  PERFORM public.attest_discovery_query_authorization_v1(workspace_id_value,
    receipt_row.authority_id,receipt_row.account_key,receipt_row.request_sha256);
  FOR attempt_row IN SELECT * FROM public.discovery_query_operation_attempt
    WHERE workspace_id=workspace_id_value AND run_id=run_id_value AND query_key=query_key_value
    ORDER BY operation_id
  LOOP
    IF NOT public.discovery_query_lineage_ack_exact_v1(workspace_id_value,
      attempt_row.operation_id,attempt_row.ack_id,attempt_row.consumer,
      attempt_row.authority_id,attempt_row.account_id,attempt_row.result_schema,
      attempt_row.result_digest,attempt_row.domain_ack_key,
      attempt_row.domain_revision,false)
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001'; END IF;
  END LOOP;
  FOR item_row IN SELECT * FROM public.discovery_query_attempt_item
    WHERE workspace_id=workspace_id_value AND run_id=run_id_value AND query_key=query_key_value
    ORDER BY provider_key,record_index
  LOOP
    SELECT * INTO STRICT attempt_row FROM public.discovery_query_operation_attempt
      WHERE workspace_id=item_row.workspace_id AND operation_id=item_row.operation_id;
    BEGIN
      SELECT * INTO STRICT relation_result
      FROM public.attest_workspace_governed_child_relation_v1(
        workspace_id_value,attempt_row.authority_id,attempt_row.account_id,
        attempt_row.operation_id,attempt_row.operation_generation,attempt_row.ack_id,
        attempt_row.result_digest,'tool_operation',attempt_row.operation_id,
        'NON_PERSONAL',NULL,NULL,NULL,'raw_source_record',item_row.raw_record_id,
        'NON_PERSONAL',NULL,NULL,item_row.relation_key,'MATERIALIZED_CHILD',
        'discovery_query_attempt_item',item_row.id,NULL,item_row.contract_sha256);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001';
    END;
    IF relation_result.replay IS DISTINCT FROM true
      OR relation_result.operation_subject_id IS DISTINCT FROM item_row.operation_subject_id
      OR relation_result.child_subject_id IS DISTINCT FROM item_row.child_subject_id
      OR relation_result.relation_id IS DISTINCT FROM item_row.relation_id
    THEN RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD' USING ERRCODE='P0001'; END IF;
  END LOOP;
  RETURN QUERY SELECT 'REPLAYED',jsonb_build_object(
    'schemaVersion','discovery-query-receipt/v1','queryKey',receipt_row.query_key,
    'queryOrdinal',receipt_row.query_ordinal,'sourceClass',receipt_row.source_class,
    'providers',receipt_row.providers,'accepted',receipt_row.accepted_count,
    'quarantined',receipt_row.quarantined_count,'rejected',receipt_row.rejected_count,
    'governanceDenied',receipt_row.governance_denied_count,
    'duplicate',receipt_row.duplicate_count,'usageQuantity',receipt_row.usage_quantity,
    'costCents',receipt_row.cost_cents),
    (SELECT count(*)::integer FROM public.discovery_query_operation_attempt
      WHERE workspace_id=workspace_id_value AND run_id=run_id_value AND query_key=query_key_value),
    (SELECT count(*)::integer FROM public.discovery_query_attempt_item
      WHERE workspace_id=workspace_id_value AND run_id=run_id_value AND query_key=query_key_value),true;
EXCEPTION
  WHEN data_exception THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID' USING ERRCODE='P0001';
END
$$;

REVOKE ALL ON FUNCTION public.discovery_query_json_keys_exact_v1(JSONB,TEXT[])
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.assert_discovery_query_lineage_caller_v1(UUID)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.discovery_query_lineage_ack_exact_v1(UUID,UUID,CHAR(64),TEXT,UUID,UUID,TEXT,CHAR(64),CHAR(64),CHAR(64),BOOLEAN)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.assert_discovery_query_authorization_v1(UUID,UUID,UUID,TEXT,INTEGER,CHAR(64))
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.attest_discovery_query_authorization_v1(UUID,UUID,TEXT,CHAR(64))
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.append_discovery_query_lineage_v1(JSONB)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON FUNCTION public.attest_discovery_query_lineage_v1(JSONB)
  FROM PUBLIC,app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT EXECUTE ON FUNCTION public.append_discovery_query_lineage_v1(JSONB) TO app_user;
GRANT EXECUTE ON FUNCTION public.attest_discovery_query_lineage_v1(JSONB) TO app_user;

COMMIT;
