-- PostgreSQL is the initial Raw v2 provenance authority. Ordinary app
-- sessions lose direct INSERT and receive one bounded, parameterized writer.
-- 0900/1000/1100 remain byte-frozen.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE FUNCTION raw_source_canonical_json_v1(p_value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  rendered TEXT;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(
        to_jsonb(item.key)::text || ':' ||
          public.raw_source_canonical_json_v1(item.value),
        ',' ORDER BY item.key COLLATE "C"
      ), '') || '}'
      INTO rendered
      FROM jsonb_each(p_value) AS item;
      RETURN rendered;
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(
        public.raw_source_canonical_json_v1(item.value),
        ',' ORDER BY item.ordinality
      ), '') || ']'
      INTO rendered
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS item(value, ordinality);
      RETURN rendered;
    ELSE
      RETURN p_value::text;
  END CASE;
END
$$;

CREATE FUNCTION raw_source_payload_hash_v2(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT encode(public.digest(
    public.raw_source_canonical_json_v1(
      p_payload #- ARRAY['provenance', 'fetchedAt']
    ),
    'sha256'
  ), 'hex')
$$;

CREATE FUNCTION raw_source_payload_bytes_v2(p_payload JSONB)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT octet_length(public.raw_source_canonical_json_v1(p_payload))::INTEGER
$$;

CREATE FUNCTION write_raw_source_record_v2(p_command JSONB)
RETURNS TABLE(
  raw_record_id UUID,
  payload_hash TEXT,
  payload_bytes INTEGER,
  ingest_status TEXT,
  inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
  command_expected_hash TEXT;
  command_expected_bytes INTEGER;
  command_ingest_status TEXT;
  command_disposition_code TEXT;
  command_retention_days INTEGER;
  command_cost_cents INTEGER;
  derived_hash TEXT;
  derived_bytes INTEGER;
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
  THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_DENIED' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
  INTO command_keys
  FROM jsonb_object_keys(p_command) AS key;
  IF command_keys IS DISTINCT FROM
    'contentHash,costCents,dispositionCode,expectedPayloadBytes,expectedPayloadHash,externalId,fetchedAt,ingestKey,ingestStatus,parserVersion,payload,providerKey,recordId,retentionDays,runId,schemaVersion,sourceClass,sourceEntityId,sourcePolicyId,sourceUrl,workspaceId'
    OR p_command->>'schemaVersion' IS DISTINCT FROM 'raw-source-writer/v1'
  THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;

  BEGIN
    command_workspace_id := (p_command->>'workspaceId')::UUID;
    command_record_id := (p_command->>'recordId')::UUID;
    command_run_id := NULLIF(p_command->>'runId', '')::UUID;
    command_source_entity_id := NULLIF(p_command->>'sourceEntityId', '')::UUID;
    command_source_policy_id := NULLIF(p_command->>'sourcePolicyId', '')::UUID;
    command_expected_bytes := (p_command->>'expectedPayloadBytes')::INTEGER;
    command_retention_days := (p_command->>'retentionDays')::INTEGER;
    command_cost_cents := (p_command->>'costCents')::INTEGER;
    command_fetched_at_text := p_command->>'fetchedAt';
    command_fetched_at := NULLIF(command_fetched_at_text, '')::TIMESTAMPTZ;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE = '22023';
  END;

  command_provider_key := p_command->>'providerKey';
  command_source_class := p_command->>'sourceClass';
  command_external_id := p_command->>'externalId';
  command_payload := p_command->'payload';
  command_source_url := p_command->>'sourceUrl';
  command_content_hash := p_command->>'contentHash';
  command_parser_version := p_command->>'parserVersion';
  command_ingest_key := p_command->>'ingestKey';
  command_expected_hash := p_command->>'expectedPayloadHash';
  command_ingest_status := p_command->>'ingestStatus';
  command_disposition_code := p_command->>'dispositionCode';

  IF command_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_DENIED' USING ERRCODE = '42501';
  END IF;

  IF command_record_id IS NULL
    OR ((command_run_id IS NULL) = (command_source_entity_id IS NULL))
    OR jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
    OR char_length(command_provider_key) NOT BETWEEN 1 AND 128
    OR char_length(command_source_class) NOT BETWEEN 1 AND 64
    OR (command_external_id IS NOT NULL AND
      char_length(command_external_id) NOT BETWEEN 1 AND 512)
    OR char_length(command_ingest_key) NOT BETWEEN 1 AND 512
    OR command_expected_hash !~ '^[0-9a-f]{64}$'
    OR command_expected_bytes NOT BETWEEN 1 AND 2147483647
    OR command_retention_days NOT BETWEEN 1 AND 3650
    OR command_cost_cents NOT BETWEEN 0 AND 2147483647
    OR command_ingest_status NOT IN ('ACCEPTED', 'QUARANTINED', 'REJECTED')
    OR (command_fetched_at_text IS NOT NULL AND
      command_fetched_at_text !~
        '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
    OR (command_fetched_at IS NOT NULL AND
      command_fetched_at > statement_timestamp() + interval '5 minutes')
    OR (
      command_ingest_status = 'ACCEPTED'
      AND command_disposition_code IS NOT NULL
    )
    OR (
      command_ingest_status IN ('QUARANTINED', 'REJECTED')
      AND char_length(command_disposition_code) NOT BETWEEN 1 AND 128
    )
  THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;

  derived_hash := public.raw_source_payload_hash_v2(command_payload);
  derived_bytes := public.raw_source_payload_bytes_v2(command_payload);
  IF derived_hash IS DISTINCT FROM command_expected_hash THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_HASH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF derived_bytes IS DISTINCT FROM command_expected_bytes THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_BYTES_MISMATCH' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.data_provider AS provider
  WHERE provider."key" = command_provider_key
    AND provider."status" = 'ENABLED'
    AND CASE command_provider_key
      WHEN 'registry' THEN command_source_class = 'company_registry'
      WHEN 'directory' THEN command_source_class = 'industry_data'
      WHEN 'wikidata' THEN command_source_class IN ('company_registry', 'industry_data')
      WHEN 'openstreetmap' THEN command_source_class = 'industry_data'
      WHEN 'trade_fair' THEN command_source_class = 'industry_data'
      WHEN 'ted' THEN command_source_class = 'public_intelligence'
      WHEN 'openfda' THEN command_source_class = 'public_intelligence'
      WHEN 'public_web' THEN command_source_class IN ('public_intelligence', 'industry_data')
      ELSE false
    END
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_PROVIDER_BINDING_INVALID'
      USING ERRCODE = '23503';
  END IF;

  IF command_run_id IS NOT NULL THEN
    PERFORM 1
    FROM public.discovery_run AS run
    WHERE run."workspace_id" = command_workspace_id
      AND run."id" = command_run_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_RUN_BINDING_INVALID'
        USING ERRCODE = '23503';
    END IF;
  ELSE
    SELECT entity."id" AS entity_id,
      entity."external_id" AS entity_external_id,
      entity."content_hash" AS entity_content_hash,
      entity."last_seen_fetch_id" AS fetch_id,
      source."id" AS source_id,
      source."source_key",
      source."provider_key" AS origin_provider_key,
      observed_fetch."finished_at" AS fetched_at,
      observed_fetch."parser_version"
    INTO monitored_row
    FROM public.source_entity AS entity
    JOIN public.monitored_source AS source ON source."id" = entity."source_id"
    JOIN public.source_fetch AS observed_fetch
      ON observed_fetch."id" = entity."last_seen_fetch_id"
     AND observed_fetch."source_id" = source."id"
     AND observed_fetch."status" IN ('DONE', 'PARTIAL')
    WHERE entity."id" = command_source_entity_id
    FOR KEY SHARE OF entity, source, observed_fetch;
    IF NOT FOUND
      OR command_provider_key IS DISTINCT FROM 'trade_fair'
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
    THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_SOURCE_BINDING_INVALID'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF command_source_url IS NOT NULL THEN
    IF char_length(command_source_url) NOT BETWEEN 1 AND 2048
      OR command_source_url !~ '^https://[^/@:?#]+(?::443)?(?:/|$)'
      OR command_source_url ~ '[?#]'
    THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
        USING ERRCODE = '23514';
    END IF;
    source_host := lower(substring(
      command_source_url FROM '^https://([^/:?#]+)'
    ));
  END IF;

  IF command_source_policy_id IS NULL THEN
    IF command_ingest_status = 'ACCEPTED' THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
        USING ERRCODE = '23514';
    END IF;
    derived_snapshot := jsonb_build_object(
      'kind', 'missing',
      'retentionDays', command_retention_days,
      'minimizedFields', '[]'::jsonb
    );
  ELSE
    SELECT policy."id", policy."domain", policy."retention_days",
      policy."review_status", policy."updated_at", policy."allowed_purpose"
    INTO policy_row
    FROM public.source_policy AS policy
    WHERE policy."id" = command_source_policy_id
    FOR KEY SHARE;
    IF NOT FOUND
      OR source_host IS NULL
      OR NOT (
        source_host = lower(policy_row.domain)
        OR right(
          source_host, char_length(policy_row.domain) + 1
        ) = '.' || lower(policy_row.domain)
      )
      OR command_retention_days IS DISTINCT FROM policy_row.retention_days
      OR (
        policy_row.allowed_purpose IS NOT NULL
        AND NOT policy_row.allowed_purpose @> '["discovery"]'::jsonb
      )
      OR (
        command_ingest_status = 'ACCEPTED'
        AND policy_row.review_status IS DISTINCT FROM 'APPROVED'
      )
    THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
        USING ERRCODE = '23514';
    END IF;
    derived_snapshot := jsonb_build_object(
      'kind', 'source_policy',
      'id', policy_row.id,
      'domain', policy_row.domain,
      'retentionDays', policy_row.retention_days,
      'reviewStatus', policy_row.review_status,
      'updatedAt', to_char(
        policy_row.updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'minimizedFields', '[]'::jsonb
    );
  END IF;

  IF command_ingest_status = 'ACCEPTED' AND (
    command_source_url IS NULL
    OR command_fetched_at IS NULL
    OR command_content_hash !~ '^[0-9a-f]{64}$'
    OR char_length(command_parser_version) NOT BETWEEN 1 AND 256
    OR command_payload #>> '{provenance,sourceUrl}'
      IS DISTINCT FROM command_source_url
    OR command_payload #>> '{provenance,fetchedAt}'
      IS DISTINCT FROM command_fetched_at_text
    OR command_payload #>> '{provenance,contentHash}'
      IS DISTINCT FROM command_content_hash
    OR command_payload #>> '{provenance,parserVersion}'
      IS DISTINCT FROM command_parser_version
  ) THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_PROVENANCE_BINDING_INVALID'
      USING ERRCODE = '23514';
  END IF;

  derived_expires_at := coalesce(command_fetched_at, statement_timestamp())
    + make_interval(days => command_retention_days);

  INSERT INTO public.raw_source_record(
    "id", "workspace_id", "run_id", "source_entity_id", "provider_key",
    "source_class", "external_id", "payload", "source_url", "fetched_at",
    "content_hash", "parser_version", "cost_cents", "ingest_key",
    "payload_hash", "payload_bytes", "ingest_version", "ingest_status",
    "disposition_code", "retention_days", "expires_at", "expired_at",
    "source_policy_snapshot", "created_at"
  ) VALUES (
    command_record_id, command_workspace_id, command_run_id,
    command_source_entity_id, command_provider_key, command_source_class,
    command_external_id, command_payload, command_source_url,
    command_fetched_at, command_content_hash, command_parser_version,
    command_cost_cents, command_ingest_key, derived_hash, derived_bytes,
    'raw-source/v2', command_ingest_status, command_disposition_code,
    command_retention_days, derived_expires_at, NULL, derived_snapshot,
    statement_timestamp()
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  was_inserted := inserted_count = 1;

  SELECT raw.* INTO stored_row
  FROM public.raw_source_record AS raw
  WHERE raw."workspace_id" = command_workspace_id
    AND raw."ingest_version" = 'raw-source/v2'
    AND raw."ingest_key" = command_ingest_key
    AND (
      (command_run_id IS NOT NULL
        AND raw."run_id" = command_run_id
        AND raw."provider_key" = command_provider_key)
      OR
      (command_source_entity_id IS NOT NULL
        AND raw."source_entity_id" = command_source_entity_id)
    )
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
    OR stored_row."payload_hash" IS DISTINCT FROM derived_hash
    OR stored_row."payload_bytes" IS DISTINCT FROM derived_bytes
    OR stored_row."ingest_status" IS DISTINCT FROM command_ingest_status
    OR stored_row."disposition_code" IS DISTINCT FROM command_disposition_code
    OR stored_row."retention_days" IS DISTINCT FROM command_retention_days
    OR stored_row."source_policy_snapshot" IS DISTINCT FROM derived_snapshot
  THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_DRIFT' USING ERRCODE = '23505';
  END IF;

  RETURN QUERY SELECT stored_row."id", stored_row."payload_hash"::text,
    stored_row."payload_bytes", stored_row."ingest_status"::text,
    was_inserted;
END
$$;

REVOKE INSERT ON TABLE raw_source_record FROM app_user;
REVOKE ALL ON FUNCTION raw_source_canonical_json_v1(JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_payload_hash_v2(JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_payload_bytes_v2(JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION write_raw_source_record_v2(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION write_raw_source_record_v2(JSONB) TO app_user;

COMMIT;
