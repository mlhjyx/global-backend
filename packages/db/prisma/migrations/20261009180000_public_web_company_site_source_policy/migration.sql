-- public_web company-site source policy
-- (docs/superpowers/plans/2026-10-09-public-web-company-site-source-policy.md).
--
-- Raw ingestion picks the source_policy that governs a record
-- (apps/api/src/discovery/raw-source-ingestion.ts, governingPolicy). The writer re-checks the
-- binding and raises on any other, which rolls back the whole discovery query. This migration
-- moves that re-check (the policy block of write_raw_source_record_v2_legacy, 20260826130000
-- L911-947) into raw_source_policy_binding_v3 and makes it apply the same rule:
--   * the reserved row 'public_web:company_site' binds only a public_web record, only when no
--     site policy covers its source host, and an ACCEPTED record only on its own domain;
--   * a site policy binds only when no site policy covering the host is more specific, and an
--     ACCEPTED record only when every equally specific one is APPROVED;
--   * hosts and policy domains are compared as Raw ingestion compares them: ASCII letters
--     folded to lower case, then one leading "www." dropped. A SUSPENDED www.<site> row used to
--     make the writer raise;
--   * APPROVED and the discovery purpose are required of an ACCEPTED record only. A quarantined
--     receipt binds to the SUSPENDED or purpose-less policy it was quarantined under instead of
--     raising, and its snapshot records the purpose actually allowed.
-- The snapshot shape is unchanged, and rows written before this migration replay to the same
-- snapshot. The rest of the legacy body is copied verbatim; only its search_path now lists
-- pg_temp last, as 20261009160000 set it. No table, column, row, owner or grant changes: the
-- company-site row is seeded by the application (DiscoveryProviderRegistry.seed).
-- Forward-only. Static contract: apps/api/src/discovery/raw-source-company-site-policy.migration.spec.ts;
-- PostgreSQL behaviour: raw-source-company-site-policy.postgres.spec.ts beside it.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Called only by the SECURITY DEFINER writer, so it runs with the owner's rights; not callable
-- by app_user. Returns the snapshot the writer stores, or raises the error the replaced block did.
CREATE FUNCTION public.raw_source_policy_binding_v3(
  p_provider_key TEXT,
  p_ingest_status TEXT,
  p_source_host TEXT,
  p_payload JSONB,
  p_policy_id UUID,
  p_retention_days INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  bound_policy RECORD;
  host_key TEXT;
  bound_key TEXT;
  covering_length INTEGER;
  covering_unapproved BOOLEAN;
  purpose_allowed BOOLEAN;
BEGIN
  IF p_policy_id IS NULL THEN
    IF p_ingest_status='ACCEPTED' THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN jsonb_build_object(
      'kind','missing','retentionDays',p_retention_days,
      'allowedPurpose','[]'::jsonb,'minimizedFields','[]'::jsonb
    );
  END IF;

  SELECT policy."id",policy."domain",policy."retention_days",
    policy."review_status",policy."updated_at",policy."allowed_purpose"
  INTO bound_policy FROM public.source_policy policy
  WHERE policy."id"=p_policy_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_source_host IS NULL
    OR p_retention_days IS DISTINCT FROM bound_policy.retention_days
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
    USING ERRCODE='23514'; END IF;

  -- The most specific site policies covering the host: equal to it or a parent domain of it,
  -- both sides with ASCII lower case and without one leading "www.".
  host_key := regexp_replace(p_source_host, '^www\.', '');
  SELECT covering.key_length, covering.unapproved
  INTO covering_length, covering_unapproved
  FROM (
    SELECT char_length(site.site_key) AS key_length,
      bool_or(site.review_status IS DISTINCT FROM 'APPROVED') AS unapproved
    FROM (
      SELECT regexp_replace(translate(candidate."domain",
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), '^www\.', '') AS site_key,
        candidate."review_status" AS review_status
      FROM public.source_policy candidate
      WHERE candidate."domain" <> 'public_web:company_site'
    ) site
    WHERE site.site_key=host_key
      OR right(host_key,char_length(site.site_key)+1)='.' || site.site_key
    GROUP BY char_length(site.site_key)
    ORDER BY char_length(site.site_key) DESC
    LIMIT 1
  ) covering;

  IF bound_policy.domain='public_web:company_site' THEN
    -- The company-site policy: public_web only, never over a site policy, and an ACCEPTED
    -- record only on its own domain (the writer's origin binding requires that too).
    IF p_provider_key IS DISTINCT FROM 'public_web'
      OR covering_length IS NOT NULL
      OR (p_ingest_status='ACCEPTED'
        AND p_source_host IS DISTINCT FROM p_payload->>'domain')
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
      USING ERRCODE='23514'; END IF;
  ELSE
    -- A site policy: one of the most specific covering the host; an ACCEPTED record also
    -- needs every equally specific one APPROVED.
    bound_key := regexp_replace(translate(bound_policy.domain,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), '^www\.', '');
    IF NOT (bound_key=host_key
        OR right(host_key,char_length(bound_key)+1)='.' || bound_key)
      OR char_length(bound_key) IS DISTINCT FROM covering_length
      OR (p_ingest_status='ACCEPTED' AND covering_unapproved)
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
      USING ERRCODE='23514'; END IF;
  END IF;

  purpose_allowed := CASE
    WHEN jsonb_typeof(bound_policy.allowed_purpose) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(bound_policy.allowed_purpose)=0 THEN false
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(bound_policy.allowed_purpose) item
      WHERE jsonb_typeof(item) <> 'string') THEN false
    ELSE bound_policy.allowed_purpose @> '["discovery"]'::jsonb
  END;
  IF p_ingest_status='ACCEPTED' AND (NOT purpose_allowed
    OR bound_policy.review_status IS DISTINCT FROM 'APPROVED')
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
    USING ERRCODE='23514'; END IF;

  RETURN jsonb_build_object(
    'kind','source_policy','id',bound_policy.id,'domain',bound_policy.domain,
    'retentionDays',bound_policy.retention_days,
    'reviewStatus',bound_policy.review_status,
    'allowedPurpose',CASE WHEN purpose_allowed
      THEN '["discovery"]'::jsonb ELSE '[]'::jsonb END,
    'updatedAt',to_char(bound_policy.updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'minimizedFields','[]'::jsonb
  );
END
$$;

CREATE OR REPLACE FUNCTION public.write_raw_source_record_v2_legacy(p_command JSONB)
RETURNS TABLE(
  raw_record_id UUID,
  payload_hash TEXT,
  payload_bytes INTEGER,
  ingest_status TEXT,
  inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.raw_source_policy_binding_v3(TEXT,TEXT,TEXT,JSONB,UUID,INTEGER) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION public.write_raw_source_record_v2_legacy(JSONB) FROM PUBLIC, app_user;

COMMIT;
