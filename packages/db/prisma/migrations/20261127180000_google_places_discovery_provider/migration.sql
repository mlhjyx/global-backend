-- Google Maps Places API 独立公司发现源（google_places，2026-11-27）：
--  1) source_compliance_matrix 登记 google_places（Google Maps Platform Terms §3.2.3：
--     禁止长期缓存 Places 内容，仅允许长期留存 place_id；只采商家实体不采评论或个人数据；
--     retention_days=1，approved_at 留空，SOURCE_COMPLIANCE_GATE=enforce 下默认 fail-closed）；
--  2) append_discovery_query_lineage_v1 放行 google_places（industry_data，
--     producerId=google_places.discover，consumer=GooglePlacesDiscoveryProvider，
--     resultSchema=google-places-discover/v1）；
--  3) Raw writer 校验函数（raw_source_identifier_valid_v2 / types / legacy / write_raw_source_record_v2_legacy）
--     放行 google_places 并强制来源锚点 places.googleapis.com、google-place-id 标识、
--     GOOGLE_MAPS_PLACE_ID_ONLY 许可及「仅 place_id + source_class」关闭属性形状。
-- 纯 widen 迁移，不改动历史回执哈希与任何既有 provider 规则。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

INSERT INTO "source_compliance_matrix"
  ("id", "source_key", "license_classification", "robots_status", "terms_status",
   "personal_data_class", "retention_days", "owner", "approved_at", "notes", "created_at", "updated_at")
VALUES
  ('c0de0000-0000-4000-8000-000000000010', 'google_places', 'GOOGLE_MAPS_TERMS_3_2_3_PLACE_ID_ONLY',
   'ALLOWS', 'REVIEWED_RESTRICTED', 'COMPANY_ONLY', 1, 'backend-platform', NULL,
   'Google Maps Places API (New) Text Search（工具 google_places.discover，治理域 places.googleapis.com）。遵循 Google Maps Platform Terms §3.2.3：禁止长期缓存/存储名称、地址、电话、评分或评论等 Places 内容，仅允许长期留存 place_id；仅采商家实体并要求有效企业官网，下游 website_profile 抓官网作为公司事实权威来源；Raw 记录 retention_days=1 自动过期。approved_at 留空：运维/法务确认前 enforce 模式下默认 fail-closed。',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("source_key") DO NOTHING;

-- 1) 原地扩展 append_discovery_query_lineage_v1：保留既有 definer、权限与 v1 合同哈希。
DO $migration$
DECLARE
  definition text := pg_catalog.pg_get_functiondef('public.append_discovery_query_lineage_v1(jsonb)'::regprocedure);
  providers_old text := $old$WHERE provider NOT IN ('public_web','directory','trade_fair','wikidata','openstreetmap','ted','openfda','model_web_search','registry_frame','opencorporates','companies_house_registry')$old$;
  industry_old text := $old$OR provider IN ('directory','trade_fair','openstreetmap') AND source_class_value<>'industry_data'$old$;
  attempt_old text := $old$OR attempt_provider_key='companies_house_registry'
          AND source_class_value='company_registry'
          AND attempt_value->>'producerId'='companies_house.search'
          AND attempt_consumer='CompaniesHouseRegistryDiscoveryProvider'
          AND attempt_result_schema='companies-house-search/v1'$old$;
BEGIN
  IF length(definition) - length(replace(definition, providers_old, '')) <> length(providers_old)
    OR length(definition) - length(replace(definition, industry_old, '')) <> length(industry_old)
    OR length(definition) - length(replace(definition, attempt_old, '')) <> length(attempt_old)
  THEN
    RAISE EXCEPTION 'GOOGLE_PLACES_LINEAGE_PATCH_TARGET_MISMATCH';
  END IF;

  definition := replace(
    definition,
    providers_old,
    $new$WHERE provider NOT IN ('public_web','directory','trade_fair','wikidata','openstreetmap','ted','openfda','model_web_search','registry_frame','opencorporates','companies_house_registry','google_places')$new$
  );
  definition := replace(
    definition,
    industry_old,
    $new$OR provider IN ('directory','trade_fair','openstreetmap','google_places') AND source_class_value<>'industry_data'$new$
  );
  definition := replace(
    definition,
    attempt_old,
    attempt_old || E'\n        OR attempt_provider_key=''google_places''\n          AND source_class_value=''industry_data''\n          AND attempt_value->>''producerId''=''google_places.discover''\n          AND attempt_consumer=''GooglePlacesDiscoveryProvider''\n          AND attempt_result_schema=''google-places-discover/v1'''
  );
  EXECUTE definition;
END
$migration$;

-- 2) 扩展 Raw identifier 校验：仅接受 google-place-id 方案与安全 Place ID 字符集。
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
    WHEN 'google_places' THEN
      RETURN identifier_scheme = 'google-place-id'
        AND identifier_value ~ '^[A-Za-z0-9_-]{1,128}$';
    ELSE RETURN false;
  END CASE;
END
$function$;

REVOKE ALL ON FUNCTION public.raw_source_identifier_valid_v2(TEXT,JSONB) FROM PUBLIC, app_user;

-- 3) 扩展 Raw payload 字段类型校验：google_places 仅允许 attributes.google_places.{place_id, source_class}。
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
    WHEN 'model_web_search' THEN
      IF jsonb_typeof(attributes->'evidenceUrls') IS DISTINCT FROM 'array'
        OR jsonb_typeof(attributes->'discoveredBy') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'searchExecutor') IS DISTINCT FROM 'string'
      THEN RETURN false; END IF;
    WHEN 'google_places' THEN
      IF jsonb_typeof(attributes->'google_places') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'google_places';
      IF jsonb_typeof(nested->'place_id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'source_class') IS DISTINCT FROM 'string'
      THEN RETURN false; END IF;
    ELSE RETURN false;
  END CASE;
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION public.raw_source_provider_payload_types_valid_v2(TEXT,JSONB) FROM PUBLIC, app_user;

-- 4) 原地扩展 raw_source_provider_payload_valid_v2_legacy：保留 20261125110000 全部既有分支。
DO $migration$
DECLARE
  definition text := pg_catalog.pg_get_functiondef('public.raw_source_provider_payload_valid_v2_legacy(text,jsonb)'::regprocedure);
  keys_old text := $old$WHEN 'companies_house_registry' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    ELSE RETURN false;$old$;
  extid_old text := $old$OR (p_provider_key NOT IN ('wikidata','openstreetmap','ted','openfda','opencorporates','companies_house_registry')
        AND NOT public.raw_source_text_contact_safe_v2(external_id))$old$;
  case_old text := $old$OR p_payload ? 'identifier'
      THEN RETURN false; END IF;
  END CASE;$old$;
BEGIN
  IF length(definition) - length(replace(definition, keys_old, '')) <> length(keys_old)
    OR length(definition) - length(replace(definition, extid_old, '')) <> length(extid_old)
    OR length(definition) - length(replace(definition, case_old, '')) <> length(case_old)
  THEN
    RAISE EXCEPTION 'GOOGLE_PLACES_LEGACY_PAYLOAD_PATCH_TARGET_MISMATCH';
  END IF;

  definition := replace(
    definition,
    keys_old,
    $new$WHEN 'companies_house_registry' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    WHEN 'google_places' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    ELSE RETURN false;$new$
  );
  definition := replace(
    definition,
    extid_old,
    $new$OR (p_provider_key NOT IN ('wikidata','openstreetmap','ted','openfda','opencorporates','companies_house_registry','google_places')
        AND NOT public.raw_source_text_contact_safe_v2(external_id))$new$
  );
  definition := replace(
    definition,
    case_old,
    $new$OR p_payload ? 'identifier'
      THEN RETURN false; END IF;
    WHEN 'google_places' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['google_places'], ARRAY['google_places']
      ) THEN RETURN false; END IF;
      nested := attributes->'google_places';
      IF NOT public.raw_source_json_keys_within_v2(
        nested, ARRAY['place_id','source_class'], ARRAY['place_id','source_class']
      ) OR nested->>'place_id' !~ '^[A-Za-z0-9_-]{1,128}$'
        OR NOT public.raw_source_text_secret_safe_v2(nested->>'place_id')
        OR nested->>'source_class' IS DISTINCT FROM 'industry_data'
        OR NOT (p_payload ? 'domain')
        OR external_id IS NULL
        OR external_id !~ '^google_places:[0-9a-f]{64}$'
        OR identifier IS NULL
        OR identifier->>'scheme' IS DISTINCT FROM 'google-place-id'
        OR identifier->>'value' IS DISTINCT FROM nested->>'place_id'
        OR p_payload->>'license' IS DISTINCT FROM 'GOOGLE_MAPS_PLACE_ID_ONLY'
      THEN RETURN false; END IF;
  END CASE;$new$
  );
  EXECUTE definition;
END
$migration$;

-- 5) 原地扩展 write_raw_source_record_v2_legacy：保留 20261127091500/20261127155000 既有补丁。
DO $migration$
DECLARE
  definition text := pg_catalog.pg_get_functiondef('public.write_raw_source_record_v2_legacy(jsonb)'::regprocedure);
  provider_old text := $old$WHEN 'channel_catalog' THEN command_source_class='industry_data'
      ELSE false END$old$;
  origin_old text := $old$OR (command_provider_key='openfda' AND source_host <> 'api.fda.gov')$old$;
BEGIN
  IF length(definition) - length(replace(definition, provider_old, '')) <> length(provider_old)
    OR length(definition) - length(replace(definition, origin_old, '')) <> length(origin_old)
  THEN
    RAISE EXCEPTION 'GOOGLE_PLACES_RAW_WRITER_PATCH_TARGET_MISMATCH';
  END IF;

  definition := replace(
    definition,
    provider_old,
    $new$WHEN 'channel_catalog' THEN command_source_class='industry_data'
      WHEN 'google_places' THEN command_source_class='industry_data'
      ELSE false END$new$
  );
  definition := replace(
    definition,
    origin_old,
    $new$OR (command_provider_key='openfda' AND source_host <> 'api.fda.gov')
    OR (command_provider_key='google_places' AND source_host <> 'places.googleapis.com')$new$
  );
  EXECUTE definition;
END
$migration$;

COMMIT;
