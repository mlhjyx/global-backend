-- Admit the approved company shape of the local channel catalog through the
-- native v3 Raw writer. Keep all existing provider and legacy run contracts.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.discovery_v3_channel_catalog_payload_valid(p_payload jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    public.raw_source_json_keys_within_v2(
      p_payload, ARRAY['attributes','country','domain','externalId','license','name','provenance'],
      ARRAY['attributes','externalId','name','provenance']
    )
    AND jsonb_typeof(p_payload->'name') = 'string'
    AND public.raw_source_provider_company_name_valid_v2(p_payload->>'name')
    AND (NOT p_payload ? 'country'
      OR (jsonb_typeof(p_payload->'country') = 'string' AND p_payload->>'country' ~ '^[A-Z]{2}$'))
    AND (NOT p_payload ? 'domain'
      OR (jsonb_typeof(p_payload->'domain') = 'string' AND char_length(p_payload->>'domain') <= 253
        AND p_payload->>'domain' ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
        AND public.raw_source_text_secret_safe_v2(p_payload->>'domain')))
    AND (NOT p_payload ? 'license'
      OR (jsonb_typeof(p_payload->'license') = 'string' AND p_payload->>'license' IN ('public','licensed','byo')))
    AND public.raw_source_json_keys_within_v2(
      p_payload->'attributes', ARRAY['channel_id','record_id','source_class'], ARRAY['channel_id','record_id','source_class']
    )
    AND p_payload #>> '{attributes,source_class}' = 'industry_data'
    AND p_payload #>> '{attributes,channel_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND p_payload #>> '{attributes,record_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(p_payload->'externalId') = 'string'
    AND p_payload->>'externalId' = 'channel_catalog:' || (p_payload #>> '{attributes,channel_id}') || ':' || (p_payload #>> '{attributes,record_id}')
    AND public.raw_source_json_keys_within_v2(
      p_payload->'provenance', ARRAY['contentHash','fetchedAt','parserVersion','sourceUrl'],
      ARRAY['contentHash','fetchedAt','parserVersion','sourceUrl']
    )
    AND p_payload #>> '{provenance,contentHash}' ~ '^[0-9a-f]{64}$'
    AND p_payload #>> '{provenance,fetchedAt}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND p_payload #>> '{provenance,parserVersion}' = 'channel_catalog/v1'
    AND public.raw_source_safe_https_url_v2(p_payload #>> '{provenance,sourceUrl}'),
    false
  )
$$;

CREATE FUNCTION public.enforce_discovery_v3_channel_catalog_raw(p_command jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  command_payload jsonb := p_command->'payload';
  command_accepted boolean := p_command->>'ingestStatus' = 'ACCEPTED';
BEGIN
  IF command_accepted AND NOT public.discovery_v3_channel_catalog_payload_valid(command_payload) THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_command->>'runId' IS NULL OR p_command->>'sourceEntityId' IS NOT NULL
    OR p_command->>'costCents' IS DISTINCT FROM '0'
    OR p_command->>'parserVersion' IS DISTINCT FROM 'channel_catalog/v1'
  THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_CHANNEL_BINDING_INVALID' USING ERRCODE='23503';
  END IF;

  -- A durable local proof can be acknowledged only while its selected row is
  -- still enabled and its exact content version is approved. Lock both rows
  -- so revocation or recrawl cannot race the Raw and link transaction.
  PERFORM 1
  FROM public.discovery_run AS run
  JOIN public.discovery_v3_operation AS operation
    ON (operation.workspace_id, operation.run_id) = (run.workspace_id, run.id)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(operation.result#>'{data,records}') = 'array'
      THEN operation.result#>'{data,records}' ELSE '[]'::jsonb END
  ) AS proof(record)
  JOIN public.source_channel_record AS source
    ON source.id = CASE
      WHEN (proof.record #>> '{attributes,record_id}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (proof.record #>> '{attributes,record_id}')::uuid END
  JOIN public.source_channel AS channel ON channel.id = source.channel_id
  WHERE run.workspace_id = (p_command->>'workspaceId')::uuid AND run.id = (p_command->>'runId')::uuid
    AND run.execution_contract_version = 3 AND run.status = 'RUNNING' AND run.v3_worker_accepted_at IS NOT NULL
    AND (run.v3_source_routes -> CASE
      WHEN operation.step ~ '^query/(0|[1-9][0-9]{0,8})/channel_catalog/local$'
      THEN split_part(operation.step, '/', 2)::integer END) ? 'channel_catalog'
    AND operation.kind = 'TOOL' AND operation.status = 'SUCCEEDED' AND operation.ordinal = 1
    AND operation.provider = 'channel_catalog.query' AND operation.action = 'channel_catalog.query'
    AND operation.method = 'local-query' AND operation.send_authorized_at IS NULL
    AND operation.result->>'schema' = 'discovery-v3-local-companies/v1'
    AND channel.status = 'ENABLED' AND source.review_status = 'APPROVED'
    AND source.content_hash = source.reviewed_content_hash
    AND source.content_hash = p_command->>'contentHash'
    AND source.last_seen_at >= (p_command->>'fetchedAt')::timestamptz
    AND lower(substring(btrim(source.source_url, E' \t\r\n') FROM '(?i)^https://([^/:?#@]+)(?::443)?(?:[/?#]|$)'))
      = substring(p_command->>'sourceUrl' FROM '^https://([^/:?#]+)')
    AND channel.id::text = proof.record #>> '{attributes,channel_id}'
    AND proof.record #>> '{provenance,fetchedAt}' = p_command->>'fetchedAt'
    AND proof.record #>> '{provenance,contentHash}' = source.content_hash
    AND proof.record #>> '{provenance,parserVersion}' = p_command->>'parserVersion'
    AND proof.record #>> '{provenance,sourceUrl}' = p_command->>'sourceUrl'
    AND public.discovery_v3_channel_catalog_payload_valid(proof.record)
    AND (CASE WHEN command_accepted THEN command_payload = proof.record
      ELSE command_payload->>'originalPayloadHash' = public.raw_source_payload_hash_v2(proof.record) END)
  LIMIT 1
  FOR SHARE OF run, operation, source, channel;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_CHANNEL_BINDING_INVALID' USING ERRCODE='23503';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.discovery_v3_channel_catalog_payload_valid(jsonb) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION public.enforce_discovery_v3_channel_catalog_raw(jsonb) FROM PUBLIC, app_user;

-- Patch the exact active writer in place to preserve the original definer,
-- privileges, provider rules, byte checks, and source policy logic.
DO $migration$
DECLARE
  definition text := pg_catalog.pg_get_functiondef('public.write_raw_source_record_v2_legacy(jsonb)'::regprocedure);
  provider_branch text := $prior$WHEN 'model_web_search' THEN command_source_class='public_intelligence'
      ELSE false END$prior$;
  validation_branch text := $prior$IF command_ingest_status='ACCEPTED'
    AND NOT public.raw_source_provider_payload_valid_v2(
      command_provider_key, command_payload
    )$prior$;
BEGIN
  IF length(definition) - length(replace(definition, provider_branch, '')) <> length(provider_branch)
    OR length(definition) - length(replace(definition, validation_branch, '')) <> length(validation_branch)
  THEN
    RAISE EXCEPTION 'RAW_SOURCE_CHANNEL_CATALOG_PATCH_TARGET_MISMATCH';
  END IF;

  definition := replace(definition, provider_branch, $new$WHEN 'model_web_search' THEN command_source_class='public_intelligence'
      WHEN 'channel_catalog' THEN command_source_class='industry_data'
      ELSE false END$new$);
  EXECUTE replace(definition, validation_branch, $new$IF command_provider_key='channel_catalog' THEN
    PERFORM public.enforce_discovery_v3_channel_catalog_raw(p_command);
  END IF;
  IF command_ingest_status='ACCEPTED' AND command_provider_key <> 'channel_catalog'
    AND NOT public.raw_source_provider_payload_valid_v2(
      command_provider_key, command_payload
    )$new$);
END
$migration$;

COMMIT;
