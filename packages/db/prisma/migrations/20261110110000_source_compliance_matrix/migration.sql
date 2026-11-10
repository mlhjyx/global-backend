BEGIN;

-- 获客挖掘 vNext W4（P0 第一切片，2026-11-10）：
--  1) 新平台表 source_compliance_matrix（源合规矩阵）：每个数据源上线前登记许可/robots/ToS/
--     个人数据分级/保留期/责任人。工具 broker 只读引用——声明了 sourceKey 的**新源**工具在
--     SOURCE_COMPLIANCE_GATE=enforce 时要求本表有已批准行（未登记/未批准=fail-closed）；
--     开关默认 off 时行为不变；未声明 sourceKey 的旧源继续只走既有 source_policy 治理。
--     平台级表（无租户数据，无 RLS）：app_user 只读，写入由 owner/运营通道执行。
--  2) discovery query lineage v1 provider allowlist 三次扩：补 opencorporates
--     （producer=opencorporates.search，consumer=OpenCorporatesDiscoveryProvider，
--     resultSchema=opencorporates-search/v1，source_class=company_registry）——code 侧
--     PROVIDER_CONTRACT / DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS 已注册（本 PR），但 SQL
--     白名单与 attempt 三元组是硬编码；不扩则 opencorporates 的治理 run 在 append 阶段被
--     DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID 拒绝。只扩白名单与 attempt 三元组，
--     v1 合同哈希、命令/回执字段与其余校验不变（纯 widen，历史回执不含新源）。

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "source_compliance_matrix" (
  "id" UUID NOT NULL,
  "source_key" TEXT NOT NULL,
  "license_classification" TEXT NOT NULL,
  "robots_status" TEXT NOT NULL,
  "terms_status" TEXT NOT NULL,
  "personal_data_class" TEXT NOT NULL,
  "retention_days" INTEGER NOT NULL,
  "owner" TEXT NOT NULL,
  "approved_at" TIMESTAMP(3),
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "source_compliance_matrix_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_compliance_matrix_robots_status_check"
    CHECK ("robots_status" IN ('ALLOWS', 'RESTRICTS', 'UNREVIEWED')),
  CONSTRAINT "source_compliance_matrix_terms_status_check"
    CHECK ("terms_status" IN ('REVIEWED_OK', 'REVIEWED_RESTRICTED', 'UNREVIEWED')),
  CONSTRAINT "source_compliance_matrix_personal_data_class_check"
    CHECK ("personal_data_class" IN ('NONE', 'COMPANY_ONLY', 'RESTRICTED_POSSIBLE', 'PERSONAL_DATA')),
  CONSTRAINT "source_compliance_matrix_retention_days_check"
    CHECK ("retention_days" BETWEEN 1 AND 3650),
  CONSTRAINT "source_compliance_matrix_source_key_check"
    CHECK (char_length("source_key") BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX "source_compliance_matrix_source_key_key"
  ON "source_compliance_matrix"("source_key");

-- 初始行（只登记已有源与本迁移新增的 opencorporates；逐行的许可/个人数据口径与其
-- source_policy 登记一致）。approved_at 记为本次登记日期；opencorporates 商用需付费
-- 订阅且尚未采购/签署，approved_at 留空 = 未批准（enforce 下 fail-closed，符合预期）。
INSERT INTO "source_compliance_matrix"
  ("id", "source_key", "license_classification", "robots_status", "terms_status",
   "personal_data_class", "retention_days", "owner", "approved_at", "notes", "created_at", "updated_at")
VALUES
  ('c0de0000-0000-4000-8000-000000000001', 'openstreetmap', 'ODbL-1.0', 'ALLOWS', 'REVIEWED_OK',
   'NONE', 365, 'backend-platform', TIMESTAMP '2026-11-10 00:00:00',
   'OSM Overpass API（ODbL，署名+同源共享义务）；工具 osm.overpass；治理域 overpass-api.de 见 source_policy。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c0de0000-0000-4000-8000-000000000002', 'wikidata', 'CC0-1.0', 'ALLOWS', 'REVIEWED_OK',
   'NONE', 365, 'backend-platform', TIMESTAMP '2026-11-10 00:00:00',
   'Wikidata SPARQL/REST（CC0 公共领域）；工具 wikidata.sparql/wikidata.entity；治理域 query.wikidata.org/www.wikidata.org 见 source_policy。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c0de0000-0000-4000-8000-000000000003', 'ted', 'CC-BY-4.0', 'ALLOWS', 'REVIEWED_OK',
   'PERSONAL_DATA', 365, 'backend-platform', TIMESTAMP '2026-11-10 00:00:00',
   'TED v3 官方 Search API（CC BY 4.0 署名义务）；notice 可含具名联系人：绿事实入库、具名个人隔离；工具 ted.search；治理域 api.ted.europa.eu。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c0de0000-0000-4000-8000-000000000004', 'openfda', 'PUBLIC_DOMAIN', 'ALLOWS', 'REVIEWED_OK',
   'PERSONAL_DATA', 365, 'backend-platform', TIMESTAMP '2026-11-10 00:00:00',
   'openFDA 官方开放数据 API（美国政府作品公共领域，署名非义务）；registrationlisting 可含具名 us_agent/contact：结构性剔除不入绿库；工具 openfda.search；治理域 api.fda.gov。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c0de0000-0000-4000-8000-000000000005', 'companies_house', 'OGL-UK-3.0', 'ALLOWS', 'REVIEWED_OK',
   'PERSONAL_DATA', 365, 'backend-platform', TIMESTAMP '2026-11-10 00:00:00',
   'UK Companies House 官方注册处 API（OGL v3.0 © Crown copyright，署名义务）；officers 为具名董事：数据最小化（无 DOB/国籍/住址）、触达前过 lawful-basis 门；工具 companies_house.search；治理域 api.company-information.service.gov.uk。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c0de0000-0000-4000-8000-000000000006', 'inpi_rne', 'LICENCE-OUVERTE-2.0', 'ALLOWS', 'REVIEWED_OK',
   'PERSONAL_DATA', 365, 'backend-platform', TIMESTAMP '2026-11-10 00:00:00',
   'API Recherche d''entreprises（DINUM，Licence Ouverte 2.0/Etalab 署名义务；数据源 INPI RNE + INSEE Sirene）；dirigeants 为具名负责人：数据最小化；工具 inpi_rne.search；治理域 recherche-entreprises.api.gouv.fr。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c0de0000-0000-4000-8000-000000000007', 'gleif', 'CC0-1.0', 'ALLOWS', 'REVIEWED_OK',
   'NONE', 365, 'backend-platform', TIMESTAMP '2026-11-10 00:00:00',
   'GLEIF LEI 官方 API（CC0 公共领域）；法人级字段；工具 gleif.fetch；治理域 api.gleif.org。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c0de0000-0000-4000-8000-000000000008', 'google_patents', 'CC-BY-4.0', 'ALLOWS', 'REVIEWED_OK',
   'PERSONAL_DATA', 365, 'backend-platform', TIMESTAMP '2026-11-10 00:00:00',
   'BigQuery Google Patents Public Data（CC BY 4.0 署名义务）；inventors 为具名个人：数据最小化（只 name）、缓存列级加密；data_provider 默认 DISABLED，翻 ENABLED 须先签 LIA/DPIA；工具 google_patents.search；治理域 bigquery.googleapis.com。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('c0de0000-0000-4000-8000-000000000009', 'opencorporates', 'ODbL-1.0+COMMERCIAL_API', 'ALLOWS', 'REVIEWED_RESTRICTED',
   'RESTRICTED_POSSIBLE', 365, 'backend-platform', NULL,
   'OpenCorporates v0.4 API（聚合各国官方注册库；开放数据为 ODbL 1.0，商用 API 无免费路径，须付费订阅——调研见 docs/research/buyer-intelligence-v3.md）；公司记录可含高管个人数据：映射层只取公司字段（名称/注册号/状态/地址），绝不取高管；工具 opencorporates.search（OPENCORPORATES_PROVIDER=off 默认关、data_provider 默认 DISABLED）；治理域 api.opencorporates.com。approved_at 留空：商用订阅与合规复核签署前不得上线（enforce 下被拒即预期行为）。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 平台治理表：app_user 只读，写由 owner/运营通道执行。
GRANT SELECT ON "source_compliance_matrix" TO app_user;

-- discovery query lineage v1 provider allowlist 三次扩（在 20261110050000 的版本上 +opencorporates）。
-- 上一版注释：v2 合同换哈希后仍把内容校验委托给 append_discovery_query_lineage_v1，而 v1 的
-- 回执 providers 白名单与 attempt 三元组（producerId/consumer/resultSchema）硬编码了旧源集合。
-- 本迁移只扩白名单与 attempt 契约（与 PROVIDER_CONTRACT / DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS
-- 一致）；v1 合同哈希（eb5f6f09…）、命令/回执字段与所有既有校验不变——历史 v1 回执内容里从不含
-- 新源，重放语义不变（纯 widen）。

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
      WHERE provider NOT IN ('public_web','directory','trade_fair','wikidata','openstreetmap','ted','openfda','model_web_search','registry_frame','opencorporates')
        OR provider='public_web' AND source_class_value NOT IN ('public_intelligence','industry_data')
        OR provider IN ('directory','trade_fair','openstreetmap') AND source_class_value<>'industry_data'
        OR provider='wikidata' AND source_class_value NOT IN ('company_registry','industry_data')
        OR provider IN ('ted','openfda') AND source_class_value<>'public_intelligence'
        OR provider='model_web_search' AND source_class_value<>'public_intelligence'
        OR provider IN ('registry_frame','opencorporates') AND source_class_value<>'company_registry')
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

COMMIT;
