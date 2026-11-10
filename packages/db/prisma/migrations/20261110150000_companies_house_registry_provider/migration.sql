BEGIN;

-- 获客挖掘 vNext W4 P0 第二源（2026-11-10）：Companies House 公司注册发现。
-- discovery query lineage v1 provider allowlist 四次扩：补 companies_house_registry
-- （producer=companies_house.search——复用既有工具，consumer=CompaniesHouseRegistryDiscoveryProvider，
-- resultSchema=companies-house-search/v1，source_class=company_registry）。code 侧
-- PROVIDER_CONTRACT / DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS 已同步注册（本 PR），但 SQL
-- 白名单与 attempt 三元组是硬编码；不扩则该源一旦 env 开启，治理 run 在 append 阶段被
-- DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID 拒绝。只扩白名单与 attempt 三元组，
-- v1 合同哈希、命令/回执字段与其余校验不变（纯 widen，历史回执不含新源）。

CREATE OR REPLACE FUNCTION public.append_discovery_query_lineage_v1(p_append_command JSONB)
RETURNS TABLE(status TEXT,attempt_count INTEGER,item_count INTEGER,query_key TEXT)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
      WHERE provider NOT IN ('public_web','directory','trade_fair','wikidata','openstreetmap','ted','openfda','model_web_search','registry_frame','opencorporates','companies_house_registry')
        OR provider='public_web' AND source_class_value NOT IN ('public_intelligence','industry_data')
        OR provider IN ('directory','trade_fair','openstreetmap') AND source_class_value<>'industry_data'
        OR provider='wikidata' AND source_class_value NOT IN ('company_registry','industry_data')
        OR provider IN ('ted','openfda') AND source_class_value<>'public_intelligence'
        OR provider='model_web_search' AND source_class_value<>'public_intelligence'
        OR provider IN ('registry_frame','opencorporates','companies_house_registry') AND source_class_value<>'company_registry')
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
        OR attempt_provider_key='wikidata'
          AND source_class_value IN ('company_registry','industry_data')
          AND attempt_value->>'producerId'='wikidata.sparql'
          AND attempt_consumer='WikidataDiscoveryProvider'
          AND attempt_result_schema='wikidata-sparql/v1'
        OR attempt_provider_key='openstreetmap'
          AND source_class_value='industry_data'
          AND attempt_value->>'producerId'='osm.overpass'
          AND attempt_consumer='OsmDiscoveryProvider'
          AND attempt_result_schema='osm-overpass/v1'
        OR attempt_provider_key='ted'
          AND source_class_value='public_intelligence'
          AND attempt_value->>'producerId'='ted.search'
          AND attempt_consumer='TedDiscoveryProvider'
          AND attempt_result_schema='ted-search/v1'
        OR attempt_provider_key='openfda'
          AND source_class_value='public_intelligence'
          AND attempt_value->>'producerId'='openfda.search'
          AND attempt_consumer='OpenFdaDiscoveryProvider'
          AND attempt_result_schema='openfda-search/v1'
        OR attempt_provider_key='model_web_search'
          AND source_class_value='public_intelligence'
          AND attempt_value->>'producerId'='discovery.web_search_candidates'
          AND attempt_consumer='ModelWebSearchDiscoveryProvider'
          AND attempt_result_schema='discovery-web-search-candidates/v1'
        OR attempt_provider_key='registry_frame'
          AND source_class_value='company_registry'
          AND attempt_value->>'producerId'='registry.query'
          AND attempt_consumer='RegistryFrameDiscoveryProvider'
          AND attempt_result_schema='registry-query/v1'
        OR attempt_provider_key='opencorporates'
          AND source_class_value='company_registry'
          AND attempt_value->>'producerId'='opencorporates.search'
          AND attempt_consumer='OpenCorporatesDiscoveryProvider'
          AND attempt_result_schema='opencorporates-search/v1'
        OR attempt_provider_key='companies_house_registry'
          AND source_class_value='company_registry'
          AND attempt_value->>'producerId'='companies_house.search'
          AND attempt_consumer='CompaniesHouseRegistryDiscoveryProvider'
          AND attempt_result_schema='companies-house-search/v1'
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

GRANT EXECUTE ON FUNCTION public.append_discovery_query_lineage_v1(JSONB) TO app_user;

-- Raw writer 闸门对齐新增注册源（获客 vNext W4，2026-11-11）：companies_house_registry 与
-- opencorporates 的 payload/identifier 需在 DB 侧放行。#996 已合的 opencorporates 因默认
-- 三关关闭尚未暴露：Raw writer 的 provider 白名单与 identifier CASE（registry/ted/openfda）
-- 不含新源，真实数据会以 RAW_SOURCE_WRITER_PROVIDER_BINDING_INVALID /
-- RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID 整条拒收（探针实测 4/4 拒绝）。
-- 本段为纯 widen：只加两个 provider 的分支与注册号专用 token（同 #1001 TED 纯数字先例），
-- 既有 provider 的校验语义逐字节不变；电话/邮箱/人名守卫对联系人字段仍原样生效。
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- 注册号专用校验（获客 vNext W4 第二源）：与 #1001 的 TED 纯数字放行同一类问题——
-- Companies House 8 位纯数字注册号 / OpenCorporates 各国编号常是长数字串，会被
-- 「防电话 PII」守卫 raw_source_text_contact_safe_v2 误杀。注册号是公司标识而非联系方式：
-- 只查形状/长度与密钥形态（电话守卫对联系人字段不变）。
CREATE FUNCTION raw_source_registry_number_identifier_valid_v1(
  p_value TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT normalize(p_value,NFKC)=p_value
    AND octet_length(p_value) BETWEEN 1 AND 80
    AND p_value ~ '^[[:alnum:]][[:alnum:] ._:/-]{0,79}$'
    AND public.raw_source_text_secret_safe_v2(p_value)
$$;

REVOKE ALL ON FUNCTION raw_source_registry_number_identifier_valid_v1(TEXT)
  FROM PUBLIC, app_user;

CREATE OR REPLACE FUNCTION public.raw_source_identifier_valid_v2(p_provider_key text, p_identifier jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  identifier_scheme TEXT;
  identifier_value TEXT;
BEGIN
  IF p_identifier IS NULL THEN RETURN true; END IF;
  IF NOT public.raw_source_json_keys_within_v2(
    p_identifier, ARRAY['scheme','value'], ARRAY['scheme','value']
  ) THEN RETURN false; END IF;
  identifier_scheme := p_identifier->>'scheme';
  identifier_value := p_identifier->>'value';
  IF NOT public.raw_source_text_secret_safe_v2(identifier_value)
    OR octet_length(identifier_value) > 128
  THEN RETURN false; END IF;
  CASE p_provider_key
    WHEN 'registry' THEN
      RETURN (identifier_scheme = 'registry-id'
          AND identifier_value ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$'
          AND public.raw_source_text_contact_safe_v2(identifier_value))
        OR (identifier_scheme = 'lei'
          AND identifier_value ~ '^[A-Z0-9]{20}$');
    WHEN 'ted' THEN
      RETURN identifier_scheme ~ '^ted-natid(?::[a-z]{2})?$'
        AND public.raw_source_ted_national_identifier_contact_valid_v1(
          identifier_value
        );
    WHEN 'openfda' THEN
      RETURN identifier_scheme = 'fda-reg'
        AND identifier_value ~ '^[0-9]{1,32}$';
    WHEN 'opencorporates' THEN
      RETURN identifier_scheme ~ '^oc-company-number:[a-z]{2}(?:_[a-z0-9]{1,3})?$'
        AND public.raw_source_registry_number_identifier_valid_v1(
          identifier_value
        );
    WHEN 'companies_house_registry' THEN
      RETURN identifier_scheme = 'ch-company-number'
        AND public.raw_source_registry_number_identifier_valid_v1(
          identifier_value
        );
    ELSE RETURN false;
  END CASE;
END
$function$;

CREATE OR REPLACE FUNCTION public.raw_source_provider_payload_types_valid_v2(p_provider_key text, p_payload jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  attributes JSONB;
  provenance JSONB;
  identifier JSONB;
  nested JSONB;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_payload->'attributes') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_payload->'name') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'provenance') IS DISTINCT FROM 'object'
  THEN RETURN false; END IF;

  FOREACH nested IN ARRAY ARRAY[
    p_payload->'externalId',p_payload->'domain',p_payload->'country',
    p_payload->'license'
  ] LOOP
    IF nested IS NOT NULL AND jsonb_typeof(nested) IS DISTINCT FROM 'string'
    THEN RETURN false; END IF;
  END LOOP;
  IF NOT public.raw_source_optional_json_type_v2(p_payload,'employeeCount','number')
    OR NOT public.raw_source_optional_json_type_v2(p_payload,'revenueUsd','number')
    OR NOT public.raw_source_optional_json_type_v2(p_payload,'identifier','object')
    OR NOT public.raw_source_optional_json_type_v2(p_payload,'monitoredSource','object')
  THEN RETURN false; END IF;

  provenance := p_payload->'provenance';
  IF jsonb_typeof(provenance->'sourceUrl') IS DISTINCT FROM 'string'
    OR jsonb_typeof(provenance->'fetchedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(provenance->'contentHash') IS DISTINCT FROM 'string'
    OR jsonb_typeof(provenance->'parserVersion') IS DISTINCT FROM 'string'
  THEN RETURN false; END IF;

  identifier := p_payload->'identifier';
  IF identifier IS NOT NULL AND (
    jsonb_typeof(identifier->'scheme') IS DISTINCT FROM 'string'
    OR jsonb_typeof(identifier->'value') IS DISTINCT FROM 'string'
  ) THEN RETURN false; END IF;

  attributes := p_payload->'attributes';
  CASE p_provider_key
    WHEN 'registry' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'employee_band','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'employees','number')
        OR (attributes ? 'products' AND NOT
          public.raw_source_string_array_type_v2(attributes->'products'))
      THEN RETURN false; END IF;
    WHEN 'directory' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'detail_url','string')
        OR jsonb_typeof(attributes->'source_class') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'source_directory') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'source_kind') IS DISTINCT FROM 'string'
      THEN RETURN false; END IF;
    WHEN 'wikidata' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'latitude','number')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'longitude','number')
        OR jsonb_typeof(attributes->'source_class') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'wikidata_qid') IS DISTINCT FROM 'string'
      THEN RETURN false; END IF;
    WHEN 'openstreetmap' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'latitude','number')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'longitude','number')
        OR jsonb_typeof(attributes->'source_class') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'osm_id') IS DISTINCT FROM 'string'
      THEN RETURN false; END IF;
    WHEN 'trade_fair' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'hall','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'stand','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'source_class','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'source_fair','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'source_kind','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'hiring_signal','boolean')
        OR (attributes ? 'products' AND NOT
          public.raw_source_string_array_type_v2(attributes->'products'))
      THEN RETURN false; END IF;
      nested := p_payload->'monitoredSource';
      IF nested IS NOT NULL AND (
        jsonb_typeof(nested->'originProviderKey') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceEntityId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceExternalId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceFetchId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceKey') IS DISTINCT FROM 'string'
      ) THEN RETURN false; END IF;
    WHEN 'ted' THEN
      IF jsonb_typeof(attributes->'ted') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'ted';
      IF jsonb_typeof(nested->'publication_number') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'publication_date') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'notice_type') IS DISTINCT FROM 'string'
        OR NOT public.raw_source_optional_json_type_v2(nested,'winner_identifier','string')
        OR (nested ? 'cpv' AND NOT
          public.raw_source_string_array_type_v2(nested->'cpv'))
        OR (nested ? 'buyer_countries' AND NOT
          public.raw_source_string_array_type_v2(nested->'buyer_countries'))
      THEN RETURN false; END IF;
    WHEN 'openfda' THEN
      IF jsonb_typeof(attributes->'fda') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'fda';
      IF NOT public.raw_source_optional_json_type_v2(nested,'created_date','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'fei_number','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'registration_number','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'state_code','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'status_code','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'initial_importer','boolean')
        OR (nested ? 'owner_operator_numbers' AND NOT
          public.raw_source_string_array_type_v2(nested->'owner_operator_numbers'))
        OR (nested ? 'product_codes' AND NOT
          public.raw_source_string_array_type_v2(nested->'product_codes'))
        OR (attributes ? 'products' AND NOT
          public.raw_source_string_array_type_v2(attributes->'products'))
      THEN RETURN false; END IF;
      IF (nested ? 'product_codes' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(nested->'product_codes') code
          WHERE code !~ '^[A-Z]{3}$'
            OR NOT public.raw_source_text_contact_safe_v2(code)
        )) OR (attributes ? 'products' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(attributes->'products') code
          WHERE code !~ '^[A-Z]{3}$'
            OR NOT public.raw_source_text_contact_safe_v2(code)
        )) OR (nested ? 'status_code' AND nested->>'status_code' !~ '^\d{1,3}$')
        OR (nested ? 'state_code' AND nested->>'state_code' !~ '^[A-Z]{2}$')
      THEN RETURN false; END IF;
    WHEN 'public_web' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'extraction_confidence','number')
        OR jsonb_typeof(attributes->'extraction_evidence_digest')
          IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'source_class') IS DISTINCT FROM 'string'
        OR (attributes ? 'products' AND NOT
          public.raw_source_string_array_type_v2(attributes->'products'))
        OR (attributes ? 'keywords' AND NOT
          public.raw_source_string_array_type_v2(attributes->'keywords'))
      THEN RETURN false; END IF;
    WHEN 'opencorporates' THEN
      IF jsonb_typeof(attributes->'opencorporates') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'opencorporates';
      IF jsonb_typeof(nested->'company_number') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'jurisdiction_code') IS DISTINCT FROM 'string'
        OR NOT public.raw_source_optional_json_type_v2(nested,'status','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'company_type','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'incorporation_date','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'dissolution_date','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'registered_address','string')
      THEN RETURN false; END IF;
    WHEN 'companies_house_registry' THEN
      IF jsonb_typeof(attributes->'ch_registry') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'ch_registry';
      IF jsonb_typeof(nested->'company_number') IS DISTINCT FROM 'string'
        OR NOT public.raw_source_optional_json_type_v2(nested,'company_status','string')
      THEN RETURN false; END IF;
    ELSE RETURN false;
  END CASE;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.raw_source_provider_payload_valid_v2_legacy(p_provider_key text, p_payload jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  allowed_keys TEXT[];
  attributes JSONB;
  provenance JSONB;
  identifier JSONB;
  nested JSONB;
  external_id TEXT;
  company_name TEXT;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
    OR NOT public.raw_source_json_shape_valid_v2(p_payload, 6, 256)
  THEN RETURN false; END IF;

  CASE p_provider_key
    WHEN 'registry' THEN allowed_keys := ARRAY[
      'attributes','country','domain','employeeCount','externalId','identifier',
      'license','name','provenance','revenueUsd'
    ];
    WHEN 'directory' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','name','provenance'
    ];
    WHEN 'wikidata' THEN allowed_keys := ARRAY[
      'attributes','country','domain','employeeCount','externalId','license',
      'name','provenance'
    ];
    WHEN 'openstreetmap' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','license','name','provenance'
    ];
    WHEN 'trade_fair' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','license','monitoredSource',
      'name','provenance'
    ];
    WHEN 'ted' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    WHEN 'openfda' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    WHEN 'public_web' THEN allowed_keys := ARRAY[
      'attributes','country','domain','employeeCount','externalId','license',
      'name','provenance'
    ];
    WHEN 'opencorporates' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    WHEN 'companies_house_registry' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    ELSE RETURN false;
  END CASE;
  IF NOT public.raw_source_json_keys_within_v2(
    p_payload, allowed_keys, ARRAY['attributes','name','provenance']
  ) THEN RETURN false; END IF;

  attributes := p_payload->'attributes';
  provenance := p_payload->'provenance';
  identifier := p_payload->'identifier';
  external_id := p_payload->>'externalId';
  company_name := p_payload->>'name';
  IF jsonb_typeof(attributes) <> 'object'
    OR company_name IS NULL
    OR octet_length(company_name) NOT BETWEEN 1 AND 160
    OR company_name !~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:-]*$'
    OR NOT public.raw_source_text_contact_safe_v2(company_name)
    OR (external_id IS NOT NULL AND (
      octet_length(external_id) NOT BETWEEN 1 AND 256
      OR external_id !~ '^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'
      OR NOT public.raw_source_text_secret_safe_v2(external_id)
      OR (p_provider_key NOT IN ('wikidata','openstreetmap','ted','openfda','opencorporates','companies_house_registry')
        AND NOT public.raw_source_text_contact_safe_v2(external_id))
    ))
    OR (p_payload ? 'domain' AND (
      p_payload->>'domain' <> lower(p_payload->>'domain')
      OR p_payload->>'domain' !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    ))
    OR (p_payload ? 'country' AND p_payload->>'country' !~ '^[A-Z]{2}$')
    OR (p_payload ? 'employeeCount' AND (
      jsonb_typeof(p_payload->'employeeCount') <> 'number'
      OR (p_payload->>'employeeCount')::NUMERIC NOT BETWEEN 0 AND 10000000000
      OR trunc((p_payload->>'employeeCount')::NUMERIC)
        <> (p_payload->>'employeeCount')::NUMERIC
    ))
    OR (p_payload ? 'revenueUsd' AND (
      jsonb_typeof(p_payload->'revenueUsd') <> 'number'
      OR (p_payload->>'revenueUsd')::NUMERIC NOT BETWEEN 0 AND 1000000000000000
    ))
    OR NOT public.raw_source_identifier_valid_v2(p_provider_key, identifier)
  THEN RETURN false; END IF;

  IF NOT public.raw_source_json_keys_within_v2(
    provenance,
    ARRAY['contentHash','fetchedAt','parserVersion','sourceUrl'],
    ARRAY['contentHash','fetchedAt','parserVersion','sourceUrl']
  ) OR provenance->>'contentHash' !~ '^[0-9a-f]{64}$'
    OR provenance->>'fetchedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR provenance->>'parserVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$'
    OR NOT public.raw_source_text_contact_safe_v2(provenance->>'parserVersion')
    OR NOT public.raw_source_safe_https_url_v2(provenance->>'sourceUrl')
  THEN RETURN false; END IF;

  CASE p_provider_key
    WHEN 'registry' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['employee_band','employees','products']
      ) OR (attributes ? 'employee_band' AND
          attributes->>'employee_band' !~ '^\d{1,7}(?:-\d{1,7}|\+)$')
        OR (attributes ? 'employees' AND (
          jsonb_typeof(attributes->'employees') <> 'number'
          OR (attributes->>'employees')::NUMERIC NOT BETWEEN 0 AND 10000000000
          OR trunc((attributes->>'employees')::NUMERIC)
            <> (attributes->>'employees')::NUMERIC
        ))
        OR (attributes ? 'products' AND (
          jsonb_typeof(attributes->'products') <> 'array'
          OR jsonb_array_length(attributes->'products') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(attributes->'products') item
            WHERE jsonb_typeof(item) <> 'string'
              OR NOT public.raw_source_controlled_business_term_v2(item #>> '{}')))
        )
        OR (p_payload ? 'license' AND p_payload->>'license' NOT IN ('public','licensed','byo'))
      THEN RETURN false; END IF;
    WHEN 'directory' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes,
        ARRAY['detail_url','source_class','source_directory','source_kind'],
        ARRAY['source_class','source_directory','source_kind']
      ) OR attributes->>'source_class' <> 'industry_data'
        OR attributes->>'source_kind' <> 'directory'
        OR attributes->>'source_directory' !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
        OR (attributes ? 'detail_url'
          AND NOT public.raw_source_safe_https_url_v2(attributes->>'detail_url'))
        OR (
          p_payload ? 'domain'
          AND external_id IS DISTINCT FROM
            ('directory:' || (p_payload->>'domain'))
        )
        OR (
          NOT (p_payload ? 'domain')
          AND left(
            external_id,
            char_length('directory:' || (attributes->>'source_directory') || ':')
          ) IS DISTINCT FROM
            ('directory:' || (attributes->>'source_directory') || ':')
        )
      THEN RETURN false; END IF;
    WHEN 'wikidata' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['latitude','longitude','source_class','wikidata_qid'],
        ARRAY['source_class','wikidata_qid']
      ) OR attributes->>'wikidata_qid' !~ '^Q[1-9]\d{0,15}$'
        OR external_id IS DISTINCT FROM
          ('wikidata:' || (attributes->>'wikidata_qid'))
        OR attributes->>'source_class' NOT IN ('company_registry','industry_data')
        OR (attributes ? 'latitude' AND (
          jsonb_typeof(attributes->'latitude') <> 'number'
          OR (attributes->>'latitude')::NUMERIC NOT BETWEEN -90 AND 90))
        OR (attributes ? 'longitude' AND (
          jsonb_typeof(attributes->'longitude') <> 'number'
          OR (attributes->>'longitude')::NUMERIC NOT BETWEEN -180 AND 180))
        OR p_payload->>'license' IS DISTINCT FROM 'CC0-1.0'
      THEN RETURN false; END IF;
    WHEN 'openstreetmap' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['latitude','longitude','osm_id','source_class'],
        ARRAY['osm_id','source_class']
      ) OR attributes->>'osm_id' !~ '^(node|way|relation)/\d{1,20}$'
        OR external_id IS DISTINCT FROM ('osm:' || (attributes->>'osm_id'))
        OR attributes->>'source_class' <> 'industry_data'
        OR (attributes ? 'latitude' AND (
          jsonb_typeof(attributes->'latitude') <> 'number'
          OR (attributes->>'latitude')::NUMERIC NOT BETWEEN -90 AND 90))
        OR (attributes ? 'longitude' AND (
          jsonb_typeof(attributes->'longitude') <> 'number'
          OR (attributes->>'longitude')::NUMERIC NOT BETWEEN -180 AND 180))
        OR p_payload->>'license' IS DISTINCT FROM 'ODbL-1.0'
      THEN RETURN false; END IF;
    WHEN 'trade_fair' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes,
        ARRAY['hall','hiring_signal','products','source_class','source_fair',
          'source_kind','stand']
      ) OR (attributes ? 'source_class'
          AND attributes->>'source_class' <> 'industry_data')
        OR (attributes ? 'hall' AND (
          jsonb_typeof(attributes->'hall') <> 'string'
          OR octet_length(attributes->>'hall') > 40
          OR attributes->>'hall' !~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:-]*$'
          OR NOT public.raw_source_text_contact_safe_v2(attributes->>'hall')))
        OR (attributes ? 'stand' AND (
          jsonb_typeof(attributes->'stand') <> 'string'
          OR octet_length(attributes->>'stand') > 40
          OR attributes->>'stand' !~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:-]*$'
          OR NOT public.raw_source_text_contact_safe_v2(attributes->>'stand')))
        OR (attributes ? 'hiring_signal'
          AND jsonb_typeof(attributes->'hiring_signal') <> 'boolean')
        OR (attributes ? 'source_fair' AND (
          jsonb_typeof(attributes->'source_fair') <> 'string'
          OR octet_length(attributes->>'source_fair') > 80
          OR attributes->>'source_fair' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,79}$'
          OR NOT public.raw_source_text_contact_safe_v2(attributes->>'source_fair')))
        OR (attributes ? 'source_kind' AND (
          jsonb_typeof(attributes->'source_kind') <> 'string'
          OR octet_length(attributes->>'source_kind') > 80
          OR attributes->>'source_kind' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,79}$'
          OR NOT public.raw_source_text_contact_safe_v2(attributes->>'source_kind')))
        OR (attributes ? 'products' AND (
          jsonb_typeof(attributes->'products') <> 'array'
          OR jsonb_array_length(attributes->'products') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(attributes->'products') item
            WHERE jsonb_typeof(item) <> 'string'
              OR NOT public.raw_source_controlled_business_term_v2(item #>> '{}')))
        )
        OR (p_payload ? 'license' AND p_payload->>'license'
          NOT IN ('SOURCE_SPECIFIC_RESTRICTED','public'))
      THEN RETURN false; END IF;
      IF p_payload ? 'monitoredSource' AND NOT public.raw_source_json_keys_within_v2(
        p_payload->'monitoredSource',
        ARRAY['originProviderKey','sourceEntityId','sourceExternalId',
          'sourceFetchId','sourceId','sourceKey'],
        ARRAY['originProviderKey','sourceEntityId','sourceExternalId',
          'sourceFetchId','sourceId','sourceKey']
      ) THEN RETURN false; END IF;
      IF p_payload ? 'monitoredSource' THEN
        nested := p_payload->'monitoredSource';
        IF nested->>'sourceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR nested->>'sourceEntityId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR nested->>'sourceFetchId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR nested->>'originProviderKey' NOT IN ('mapyourshow','trade_fair')
          OR NOT public.raw_source_text_contact_safe_v2(nested->>'sourceExternalId')
          OR octet_length(nested->>'sourceKey') > 128
          OR nested->>'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$'
          OR NOT public.raw_source_text_contact_safe_v2(nested->>'sourceKey')
          OR external_id !~ '^monitored:[0-9a-f]{64}$'
        THEN RETURN false; END IF;
      ELSIF NOT (attributes ? 'source_fair'
        AND attributes->>'source_class' = 'industry_data'
        AND left(
          external_id,
          char_length((attributes->>'source_fair') || ':')
        ) = (attributes->>'source_fair') || ':')
      THEN RETURN false;
      END IF;
    WHEN 'ted' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['ted'], ARRAY['ted']
      ) THEN RETURN false; END IF;
      nested := attributes->'ted';
      IF NOT public.raw_source_json_keys_within_v2(
        nested, ARRAY['buyer_countries','cpv','notice_type','publication_date',
          'publication_number','winner_identifier'],
        ARRAY['notice_type','publication_date','publication_number']
      ) OR nested->>'publication_number' !~ '^\d{1,9}(?:-\d{4})?$'
        OR nested->>'publication_date' !~ '^\d{4}-\d{2}-\d{2}$'
        OR to_char((nested->>'publication_date')::DATE,'YYYY-MM-DD')
          <> nested->>'publication_date'
        OR nested->>'notice_type' !~ '^(award|can|cn|pin|veat)(?:-[a-z0-9]+)*$'
        OR p_payload->>'license' IS DISTINCT FROM 'CC BY 4.0'
        OR external_id !~
          ('^ted:' || (nested->>'publication_number') || ':\d+$')
        OR (nested ? 'cpv' AND (
          jsonb_typeof(nested->'cpv') <> 'array'
          OR jsonb_array_length(nested->'cpv') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(nested->'cpv') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^\d{8}$')))
        OR (nested ? 'buyer_countries' AND (
          jsonb_typeof(nested->'buyer_countries') <> 'array'
          OR jsonb_array_length(nested->'buyer_countries') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(nested->'buyer_countries') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^[A-Z]{2,3}$')))
        OR (nested ? 'winner_identifier' AND (
          jsonb_typeof(nested->'winner_identifier') <> 'string'
          OR octet_length(nested->>'winner_identifier') > 80
          OR NOT public.raw_source_text_secret_safe_v2(nested->>'winner_identifier')))
        OR (identifier IS NOT NULL AND identifier->>'value'
          IS DISTINCT FROM nested->>'winner_identifier')
      THEN RETURN false; END IF;
    WHEN 'openfda' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['fda','products'], ARRAY['fda']
      ) THEN RETURN false; END IF;
      nested := attributes->'fda';
      IF NOT public.raw_source_json_keys_within_v2(
        nested, ARRAY['created_date','fei_number','initial_importer',
          'owner_operator_numbers','product_codes','registration_number',
          'state_code','status_code']
      ) OR p_payload->>'license' IS DISTINCT FROM 'CC0-1.0'
        OR NOT (nested ? 'registration_number' OR nested ? 'fei_number'
          OR jsonb_array_length(coalesce(nested->'product_codes','[]'::jsonb)) > 0)
        OR (nested ? 'registration_number'
          AND nested->>'registration_number' !~ '^\d{1,32}$')
        OR (identifier IS NOT NULL AND (
          identifier->>'value' IS DISTINCT FROM nested->>'registration_number'
          OR external_id IS DISTINCT FROM
            ('openfda:' || (identifier->>'value'))
        ))
        OR (nested ? 'registration_number' AND identifier IS NULL)
        OR external_id !~ '^openfda:(\d{1,32}|[0-9a-f]{64})$'
        OR (nested ? 'fei_number' AND nested->>'fei_number' !~ '^\d{1,32}$')
        OR (nested ? 'status_code' AND (
          jsonb_typeof(nested->'status_code') <> 'string'
          OR nested->>'status_code' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,31}$'
          OR NOT public.raw_source_text_contact_safe_v2(nested->>'status_code')))
        OR (nested ? 'state_code' AND nested->>'state_code' !~ '^[A-Z0-9]{2,3}$')
        OR (nested ? 'initial_importer'
          AND jsonb_typeof(nested->'initial_importer') <> 'boolean')
        OR (nested ? 'created_date' AND (
          nested->>'created_date' !~ '^\d{4}-\d{2}-\d{2}$'
          OR to_char((nested->>'created_date')::DATE,'YYYY-MM-DD')
            <> nested->>'created_date'))
        OR (nested ? 'product_codes' AND (
          jsonb_typeof(nested->'product_codes') <> 'array'
          OR jsonb_array_length(nested->'product_codes') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(nested->'product_codes') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^[A-Z0-9]{2,10}$')))
        OR (nested ? 'owner_operator_numbers' AND (
          jsonb_typeof(nested->'owner_operator_numbers') <> 'array'
          OR jsonb_array_length(nested->'owner_operator_numbers') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(nested->'owner_operator_numbers') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^\d{1,32}$')))
        OR (attributes ? 'products' AND (
          jsonb_typeof(attributes->'products') <> 'array'
          OR jsonb_array_length(attributes->'products') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(attributes->'products') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^[A-Z0-9]{2,10}$')))
      THEN RETURN false; END IF;
    WHEN 'public_web' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['extraction_confidence','extraction_evidence_digest',
          'keywords','products','source_class'],
        ARRAY['extraction_confidence','extraction_evidence_digest','keywords',
          'products','source_class']
      ) OR jsonb_typeof(attributes->'extraction_confidence') <> 'number'
        OR (attributes->>'extraction_confidence')::NUMERIC NOT BETWEEN 0 AND 1
        OR attributes->>'extraction_evidence_digest' !~ '^[0-9a-f]{64}$'
        OR attributes->>'source_class' NOT IN ('public_intelligence','industry_data')
        OR external_id IS DISTINCT FROM (p_payload->>'domain')
        OR (p_payload ? 'license' AND p_payload->>'license' NOT IN ('public','licensed','byo'))
        OR jsonb_typeof(attributes->'products') <> 'array'
        OR jsonb_array_length(attributes->'products') > 20
        OR jsonb_typeof(attributes->'keywords') <> 'array'
        OR jsonb_array_length(attributes->'keywords') > 20
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            (attributes->'products') || (attributes->'keywords')
          ) item WHERE jsonb_typeof(item) <> 'string'
            OR NOT public.raw_source_controlled_business_term_v2(item #>> '{}')
        )
      THEN RETURN false; END IF;
    WHEN 'opencorporates' THEN
      IF jsonb_typeof(attributes->'opencorporates') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'opencorporates';
      IF jsonb_typeof(nested->'company_number') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'jurisdiction_code') IS DISTINCT FROM 'string'
        OR NOT public.raw_source_optional_json_type_v2(nested,'status','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'company_type','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'incorporation_date','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'dissolution_date','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'registered_address','string')
        OR (p_payload ? 'license' AND p_payload->>'license' NOT IN ('ODbL-1.0'))
      THEN RETURN false; END IF;
    WHEN 'companies_house_registry' THEN
      IF jsonb_typeof(attributes->'ch_registry') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'ch_registry';
      IF jsonb_typeof(nested->'company_number') IS DISTINCT FROM 'string'
        OR NOT public.raw_source_optional_json_type_v2(nested,'company_status','string')
        OR (p_payload ? 'license' AND p_payload->>'license' NOT IN ('OGL-UK-3.0'))
      THEN RETURN false; END IF;
  END CASE;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION public.write_raw_source_record_v2_legacy(p_command jsonb)
 RETURNS TABLE(raw_record_id uuid, payload_hash text, payload_bytes integer, ingest_status text, inserted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  command_keys TEXT;
  command_workspace_id UUID;
  command_record_id UUID;
  command_run_id UUID;
  command_source_entity_id UUID;
  command_source_policy_id UUID;
  command_provider_key TEXT;
  command_source_class TEXT;
  command_external_id TEXT;
  command_payload JSONB;
  command_source_url TEXT;
  command_fetched_at_text TEXT;
  command_fetched_at TIMESTAMPTZ;
  command_content_hash TEXT;
  command_parser_version TEXT;
  command_ingest_key TEXT;
  command_ingest_status TEXT;
  command_disposition_code TEXT;
  command_retention_days INTEGER;
  command_cost_cents INTEGER;
  derived_hash TEXT;
  derived_bytes INTEGER;
  derived_ingest_key TEXT;
  derived_snapshot JSONB;
  derived_expires_at TIMESTAMPTZ;
  source_host TEXT;
  policy_row RECORD;
  monitored_row RECORD;
  stored_row RECORD;
  inserted_count INTEGER;
  was_inserted BOOLEAN;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_DENIED' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('statement_timeout','5000',true);

  SELECT string_agg(key, ',' ORDER BY key COLLATE "C") INTO command_keys
  FROM jsonb_object_keys(p_command) AS key;
  IF p_command->>'schemaVersion' = 'raw-source-writer/v2' THEN
    IF command_keys IS DISTINCT FROM
      'contentHash,costCents,dispositionCode,externalId,fetchedAt,ingestKey,ingestStatus,parserVersion,payload,providerKey,recordId,retentionDays,runId,schemaVersion,sourceClass,sourceEntityId,sourcePolicyId,sourceUrl,workspaceId'
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023'; END IF;
  ELSIF p_command->>'schemaVersion' = 'raw-source-writer/v1' THEN
    IF command_keys IS DISTINCT FROM
      'contentHash,costCents,dispositionCode,expectedPayloadBytes,expectedPayloadHash,externalId,fetchedAt,ingestKey,ingestStatus,parserVersion,payload,providerKey,recordId,retentionDays,runId,schemaVersion,sourceClass,sourceEntityId,sourcePolicyId,sourceUrl,workspaceId'
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END IF;

  BEGIN
    command_workspace_id := (p_command->>'workspaceId')::UUID;
    command_record_id := (p_command->>'recordId')::UUID;
    command_run_id := NULLIF(p_command->>'runId','')::UUID;
    command_source_entity_id := NULLIF(p_command->>'sourceEntityId','')::UUID;
    command_source_policy_id := NULLIF(p_command->>'sourcePolicyId','')::UUID;
    command_retention_days := (p_command->>'retentionDays')::INTEGER;
    command_cost_cents := (p_command->>'costCents')::INTEGER;
    command_fetched_at_text := p_command->>'fetchedAt';
    command_fetched_at := NULLIF(command_fetched_at_text,'')::TIMESTAMPTZ;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END;
  command_provider_key := p_command->>'providerKey';
  command_source_class := p_command->>'sourceClass';
  command_external_id := p_command->>'externalId';
  command_payload := p_command->'payload';
  command_source_url := p_command->>'sourceUrl';
  command_content_hash := p_command->>'contentHash';
  command_parser_version := p_command->>'parserVersion';
  command_ingest_key := p_command->>'ingestKey';
  command_ingest_status := p_command->>'ingestStatus';
  command_disposition_code := p_command->>'dispositionCode';

  IF command_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_DENIED' USING ERRCODE='42501';
  END IF;
  IF command_record_id IS NULL
    OR ((command_run_id IS NULL) = (command_source_entity_id IS NULL))
    OR jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
    OR char_length(command_provider_key) NOT BETWEEN 1 AND 128
    OR char_length(command_source_class) NOT BETWEEN 1 AND 64
    OR char_length(command_ingest_key) NOT BETWEEN 1 AND 512
    OR command_retention_days NOT BETWEEN 1 AND 3650
    OR command_cost_cents NOT BETWEEN 0 AND 2147483647
    OR command_ingest_status NOT IN ('ACCEPTED','QUARANTINED','REJECTED')
    OR (command_fetched_at_text IS NOT NULL AND command_fetched_at_text !~
      '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
    OR (command_fetched_at IS NOT NULL
      AND command_fetched_at > statement_timestamp() + interval '5 minutes')
    OR (command_ingest_status='ACCEPTED' AND command_disposition_code IS NOT NULL)
    OR (command_ingest_status IN ('QUARANTINED','REJECTED')
      AND char_length(command_disposition_code) NOT BETWEEN 1 AND 128)
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END IF;
  IF pg_column_size(command_payload) > 4 * 1024 * 1024
    OR octet_length(command_payload::text) > 4 * 1024 * 1024
    OR NOT public.raw_source_json_shape_valid_v2(
      command_payload,
      CASE WHEN command_ingest_status='ACCEPTED' THEN 6 ELSE 32 END,
      CASE WHEN command_ingest_status='ACCEPTED' THEN 256 ELSE 1000 END
    )
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_PAYLOAD_BOUNDS' USING ERRCODE='54000';
  END IF;

  derived_hash := public.raw_source_payload_hash_v2(command_payload);
  derived_bytes := public.raw_source_payload_bytes_v2(command_payload);
  IF derived_bytes NOT BETWEEN 1 AND 4 * 1024 * 1024 THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_PAYLOAD_BOUNDS' USING ERRCODE='54000';
  END IF;
  IF command_external_id IS DISTINCT FROM command_payload->>'externalId' THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_EXTERNAL_BINDING_INVALID' USING ERRCODE='23514';
  END IF;
  derived_ingest_key := public.raw_source_ingest_key_v2(command_payload,derived_hash);
  IF command_ingest_key IS DISTINCT FROM derived_ingest_key THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_INGEST_KEY_INVALID' USING ERRCODE='23514';
  END IF;

  PERFORM 1 FROM public.data_provider provider
  WHERE provider."key"=command_provider_key AND provider."status"='ENABLED'
    AND CASE command_provider_key
      WHEN 'registry' THEN command_source_class='company_registry'
      WHEN 'directory' THEN command_source_class='industry_data'
      WHEN 'wikidata' THEN command_source_class IN ('company_registry','industry_data')
      WHEN 'openstreetmap' THEN command_source_class='industry_data'
      WHEN 'trade_fair' THEN command_source_class='industry_data'
      WHEN 'ted' THEN command_source_class='public_intelligence'
      WHEN 'openfda' THEN command_source_class='public_intelligence'
      WHEN 'public_web' THEN command_source_class IN ('public_intelligence','industry_data')
      WHEN 'opencorporates' THEN command_source_class='company_registry'
      WHEN 'companies_house_registry' THEN command_source_class='company_registry'
      ELSE false END
  FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_PROVIDER_BINDING_INVALID'
    USING ERRCODE='23503'; END IF;
  IF command_ingest_status='ACCEPTED'
    AND NOT public.raw_source_provider_payload_valid_v2(
      command_provider_key, command_payload
    )
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID' USING ERRCODE='23514';
  END IF;

  IF command_run_id IS NOT NULL THEN
    PERFORM 1 FROM public.discovery_run run
    WHERE run."workspace_id"=command_workspace_id AND run."id"=command_run_id
    FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_RUN_BINDING_INVALID'
      USING ERRCODE='23503'; END IF;
  ELSE
    SELECT entity."id" entity_id, entity."external_id" entity_external_id,
      entity."content_hash" entity_content_hash,
      entity."last_seen_fetch_id" fetch_id, source."id" source_id,
      source."source_key", source."provider_key" origin_provider_key,
      observed_fetch."finished_at" fetched_at, observed_fetch."parser_version"
    INTO monitored_row
    FROM public.source_entity entity
    JOIN public.monitored_source source ON source."id"=entity."source_id"
    JOIN public.source_fetch observed_fetch
      ON observed_fetch."id"=entity."last_seen_fetch_id"
     AND observed_fetch."source_id"=source."id"
     AND observed_fetch."status" IN ('DONE','PARTIAL')
    WHERE entity."id"=command_source_entity_id
    FOR KEY SHARE OF entity,source,observed_fetch;
    IF NOT FOUND OR command_provider_key IS DISTINCT FROM 'trade_fair'
      OR command_content_hash IS DISTINCT FROM monitored_row.entity_content_hash
      OR command_fetched_at IS DISTINCT FROM monitored_row.fetched_at
      OR command_parser_version IS DISTINCT FROM monitored_row.parser_version
      OR command_payload #>> '{monitoredSource,sourceId}'
        IS DISTINCT FROM monitored_row.source_id::text
      OR command_payload #>> '{monitoredSource,sourceEntityId}'
        IS DISTINCT FROM monitored_row.entity_id::text
      OR command_payload #>> '{monitoredSource,sourceExternalId}'
        IS DISTINCT FROM monitored_row.entity_external_id
      OR command_payload #>> '{monitoredSource,sourceFetchId}'
        IS DISTINCT FROM monitored_row.fetch_id::text
      OR command_payload #>> '{monitoredSource,sourceKey}'
        IS DISTINCT FROM monitored_row.source_key
      OR command_payload #>> '{monitoredSource,originProviderKey}'
        IS DISTINCT FROM monitored_row.origin_provider_key
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_SOURCE_BINDING_INVALID'
      USING ERRCODE='23503'; END IF;
  END IF;

  IF command_source_url IS NOT NULL THEN
    IF NOT public.raw_source_safe_https_url_v2(command_source_url) THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
    source_host := lower(substring(command_source_url FROM '^https://([^/:?#]+)'));
  END IF;
  IF command_ingest_status='ACCEPTED' AND (
    (command_provider_key='directory'
      AND source_host IS DISTINCT FROM command_payload #>> '{attributes,source_directory}')
    OR (command_provider_key='wikidata' AND source_host <> 'www.wikidata.org')
    OR (command_provider_key='openstreetmap' AND source_host <> 'overpass-api.de')
    OR (command_provider_key='ted' AND source_host <> 'api.ted.europa.eu')
    OR (command_provider_key='openfda' AND source_host <> 'api.fda.gov')
    OR (command_provider_key='public_web'
      AND source_host IS DISTINCT FROM command_payload->>'domain')
  ) THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_ORIGIN_BINDING_INVALID'
    USING ERRCODE='23514'; END IF;

  derived_snapshot := public.raw_source_policy_binding_v3(
    command_provider_key,command_ingest_status,source_host,
    command_payload,command_source_policy_id,command_retention_days
  );

  IF command_ingest_status='ACCEPTED' AND (
    command_source_url IS NULL OR command_fetched_at IS NULL
    OR command_content_hash !~ '^[0-9a-f]{64}$'
    OR char_length(command_parser_version) NOT BETWEEN 1 AND 256
    OR command_payload #>> '{provenance,sourceUrl}' IS DISTINCT FROM command_source_url
    OR command_payload #>> '{provenance,fetchedAt}' IS DISTINCT FROM command_fetched_at_text
    OR command_payload #>> '{provenance,contentHash}' IS DISTINCT FROM command_content_hash
    OR command_payload #>> '{provenance,parserVersion}' IS DISTINCT FROM command_parser_version
  ) THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_PROVENANCE_BINDING_INVALID'
    USING ERRCODE='23514'; END IF;

  derived_expires_at := coalesce(command_fetched_at,statement_timestamp())
    + make_interval(days=>command_retention_days);
  INSERT INTO public.raw_source_record(
    "id","workspace_id","run_id","source_entity_id","provider_key",
    "source_class","external_id","payload","source_url","fetched_at",
    "content_hash","parser_version","cost_cents","ingest_key",
    "payload_hash","payload_bytes","ingest_version","ingest_status",
    "disposition_code","retention_days","expires_at","expired_at",
    "source_policy_snapshot","created_at"
  ) VALUES (
    command_record_id,command_workspace_id,command_run_id,
    command_source_entity_id,command_provider_key,command_source_class,
    command_external_id,command_payload,command_source_url,command_fetched_at,
    command_content_hash,command_parser_version,command_cost_cents,
    command_ingest_key,derived_hash,derived_bytes,'raw-source/v2',
    command_ingest_status,command_disposition_code,command_retention_days,
    derived_expires_at,NULL,derived_snapshot,statement_timestamp()
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  was_inserted := inserted_count=1;

  SELECT raw.* INTO stored_row FROM public.raw_source_record raw
  WHERE raw."workspace_id"=command_workspace_id
    AND raw."ingest_version"='raw-source/v2'
    AND raw."ingest_key"=command_ingest_key
    AND ((command_run_id IS NOT NULL AND raw."run_id"=command_run_id
      AND raw."provider_key"=command_provider_key)
      OR (command_source_entity_id IS NOT NULL
        AND raw."source_entity_id"=command_source_entity_id))
  FOR UPDATE;
  IF NOT FOUND
    OR (was_inserted AND stored_row."id" IS DISTINCT FROM command_record_id)
    OR stored_row."provider_key" IS DISTINCT FROM command_provider_key
    OR stored_row."source_class" IS DISTINCT FROM command_source_class
    OR stored_row."external_id" IS DISTINCT FROM command_external_id
    OR stored_row."payload" IS DISTINCT FROM command_payload
    OR stored_row."source_url" IS DISTINCT FROM command_source_url
    OR stored_row."fetched_at" IS DISTINCT FROM command_fetched_at
    OR stored_row."content_hash" IS DISTINCT FROM command_content_hash
    OR stored_row."parser_version" IS DISTINCT FROM command_parser_version
    OR stored_row."cost_cents" IS DISTINCT FROM command_cost_cents
    OR stored_row."payload_hash" IS DISTINCT FROM derived_hash
    OR stored_row."payload_bytes" IS DISTINCT FROM derived_bytes
    OR stored_row."ingest_status" IS DISTINCT FROM command_ingest_status
    OR stored_row."disposition_code" IS DISTINCT FROM command_disposition_code
    OR stored_row."retention_days" IS DISTINCT FROM command_retention_days
    OR stored_row."source_policy_snapshot" IS DISTINCT FROM derived_snapshot
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_DRIFT' USING ERRCODE='23505'; END IF;
  RETURN QUERY SELECT stored_row."id",stored_row."payload_hash"::text,
    stored_row."payload_bytes",stored_row."ingest_status"::text,was_inserted;
END
$function$;

COMMIT;
