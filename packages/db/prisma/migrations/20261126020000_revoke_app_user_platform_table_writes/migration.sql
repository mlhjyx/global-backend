-- M4 Deliverable B: revoke app_user write/delete privileges on 16 un-RLS'd
-- platform tables, expand execution_budget_platform_writer for platform/admin
-- writers, and provide 4 narrow SECURITY DEFINER RPCs for tenant-triggered ops.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

-- ---------------------------------------------------------------------------
-- 1) Revoke INSERT/UPDATE/DELETE from app_user & ensure SELECT on 16 tables
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON TABLE
  "monitored_source",
  "outreach_global_suppression",
  "patent_inventor_cache",
  "patent_inventor_tombstone",
  "patent_lookup_request",
  "signal_ingest",
  "source_channel",
  "source_channel_health_event",
  "source_channel_probe",
  "source_channel_record",
  "source_channel_run",
  "source_entity",
  "source_entity_change",
  "source_fetch",
  "source_signal",
  "term_alias"
FROM app_user;

GRANT SELECT ON TABLE
  "monitored_source",
  "outreach_global_suppression",
  "patent_inventor_cache",
  "patent_inventor_tombstone",
  "patent_lookup_request",
  "signal_ingest",
  "source_channel",
  "source_channel_health_event",
  "source_channel_probe",
  "source_channel_record",
  "source_channel_run",
  "source_entity",
  "source_entity_change",
  "source_fetch",
  "source_signal",
  "term_alias"
TO app_user;

-- ---------------------------------------------------------------------------
-- 2) Expand execution_budget_platform_writer for platform/admin cutovers
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON TABLE
  "monitored_source",
  "outreach_global_suppression",
  "signal_ingest",
  "source_channel",
  "source_channel_record",
  "source_channel_run",
  "source_fetch",
  "source_signal"
TO execution_budget_platform_writer;

GRANT SELECT, INSERT ON TABLE
  "source_channel_health_event",
  "source_channel_probe"
TO execution_budget_platform_writer;

GRANT SELECT, INSERT, DELETE ON TABLE
  "source_entity_change"
TO execution_budget_platform_writer;

-- ---------------------------------------------------------------------------
-- 3) Narrow SECURITY DEFINER RPCs for app_user-only flows
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.record_patent_inventor_tombstones_v1(
  p_keys TEXT[]
) RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_workspace_id TEXT := NULLIF(btrim(COALESCE(current_setting('app.current_workspace_id', true), '')), '');
  v_keys TEXT[];
  v_inserted INTEGER := 0;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none'
     OR current_user IS NOT DISTINCT FROM session_user
  THEN
    RAISE EXCEPTION 'PATENT_TOMBSTONE_APP_USER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF v_workspace_id IS NULL
     OR v_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'PATENT_TOMBSTONE_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_keys IS NULL OR cardinality(p_keys) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_keys) > 256 THEN
    RAISE EXCEPTION 'PATENT_TOMBSTONE_BATCH_TOO_LARGE' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(p_keys) AS k
    WHERE k IS NULL OR btrim(k) !~ '^bi:v1:[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'PATENT_TOMBSTONE_KEY_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT btrim(k)), ARRAY[]::TEXT[])
  INTO v_keys
  FROM unnest(p_keys) AS k;

  IF cardinality(v_keys) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public."patent_inventor_tombstone" ("id", "inventor_name_key")
  SELECT gen_random_uuid(), k
  FROM unnest(v_keys) AS k
  ON CONFLICT ("inventor_name_key") DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE FUNCTION public.purge_patent_inventor_cache_by_keys_v1(
  p_keys TEXT[]
) RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_workspace_id TEXT := NULLIF(btrim(COALESCE(current_setting('app.current_workspace_id', true), '')), '');
  v_keys TEXT[];
  v_deleted INTEGER := 0;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none'
     OR current_user IS NOT DISTINCT FROM session_user
  THEN
    RAISE EXCEPTION 'PATENT_CACHE_PURGE_APP_USER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF v_workspace_id IS NULL
     OR v_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'PATENT_CACHE_PURGE_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF p_keys IS NULL OR cardinality(p_keys) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_keys) > 256 THEN
    RAISE EXCEPTION 'PATENT_CACHE_PURGE_BATCH_TOO_LARGE' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(p_keys) AS k
    WHERE k IS NULL OR btrim(k) !~ '^bi:v1:[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'PATENT_CACHE_PURGE_KEY_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT btrim(k)), ARRAY[]::TEXT[])
  INTO v_keys
  FROM unnest(p_keys) AS k;

  IF cardinality(v_keys) = 0 THEN
    RETURN 0;
  END IF;

  DELETE FROM public."patent_inventor_cache"
  WHERE "inventor_name_key" = ANY(v_keys);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE FUNCTION public.enqueue_patent_lookup_v1(
  p_assignee_norm TEXT,
  p_country TEXT,
  p_anchor TEXT,
  p_sample_name TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_assignee_norm TEXT := btrim(COALESCE(p_assignee_norm, ''));
  v_country TEXT := btrim(COALESCE(p_country, ''));
  v_anchor TEXT := btrim(COALESCE(p_anchor, ''));
  v_sample_name TEXT := left(btrim(COALESCE(p_sample_name, '')), 200);
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none'
     OR current_user IS NOT DISTINCT FROM session_user
  THEN
    RAISE EXCEPTION 'PATENT_ENQUEUE_APP_USER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_assignee_norm) NOT BETWEEN 1 AND 200
     OR char_length(v_country) > 8
     OR char_length(v_anchor) NOT BETWEEN 1 AND 200
     OR char_length(v_sample_name) NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'PATENT_ENQUEUE_INVALID_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."patent_lookup_request" (
    "id",
    "assignee_norm",
    "country",
    "anchor",
    "sample_name",
    "status",
    "first_requested_at",
    "last_requested_at"
  )
  VALUES (
    gen_random_uuid(),
    v_assignee_norm,
    v_country,
    v_anchor,
    v_sample_name,
    'PENDING',
    statement_timestamp(),
    statement_timestamp()
  )
  ON CONFLICT ("assignee_norm", "country") DO UPDATE
    SET "last_requested_at" = statement_timestamp();

  RETURN TRUE;
END;
$$;

CREATE FUNCTION public.upsert_term_alias_v1(
  p_kind TEXT,
  p_term TEXT,
  p_code TEXT
) RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_workspace_id TEXT := NULLIF(btrim(COALESCE(current_setting('app.current_workspace_id', true), '')), '');
  v_kind TEXT := btrim(COALESCE(p_kind, ''));
  v_term TEXT := btrim(COALESCE(p_term, ''));
  v_code TEXT := btrim(COALESCE(p_code, ''));
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none'
     OR current_user IS NOT DISTINCT FROM session_user
  THEN
    RAISE EXCEPTION 'TAXONOMY_ALIAS_APP_USER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF v_workspace_id IS NULL
     OR v_workspace_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'TAXONOMY_ALIAS_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_kind) NOT BETWEEN 1 AND 64
     OR char_length(v_term) NOT BETWEEN 1 AND 200
     OR char_length(v_code) NOT BETWEEN 1 AND 128
  THEN
    RAISE EXCEPTION 'TAXONOMY_ALIAS_INVALID_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."canonical_taxonomy" ct
    WHERE ct."kind" = v_kind
      AND ct."code" = v_code
  ) THEN
    RAISE EXCEPTION 'TAXONOMY_ALIAS_TARGET_INVALID' USING ERRCODE = '23503';
  END IF;

  INSERT INTO public."term_alias" (
    "id",
    "kind",
    "term",
    "code",
    "source"
  )
  VALUES (
    gen_random_uuid(),
    v_kind,
    v_term,
    v_code,
    'llm'
  )
  ON CONFLICT ("kind", "term") DO UPDATE
    SET "code" = EXCLUDED."code",
        "source" = 'llm'
    WHERE public."term_alias"."source" = 'llm';
END;
$$;

REVOKE ALL ON FUNCTION
  public.record_patent_inventor_tombstones_v1(TEXT[]),
  public.purge_patent_inventor_cache_by_keys_v1(TEXT[]),
  public.enqueue_patent_lookup_v1(TEXT, TEXT, TEXT, TEXT),
  public.upsert_term_alias_v1(TEXT, TEXT, TEXT)
FROM PUBLIC,
     execution_budget_platform_writer,
     runtime_api,
     runtime_worker,
     runtime_outbox_relay,
     runtime_platform_worker,
     runtime_outbox_relay_worker,
     runtime_memory_outbox_reader,
     runtime_customer_worker_ops;

GRANT EXECUTE ON FUNCTION
  public.record_patent_inventor_tombstones_v1(TEXT[]),
  public.purge_patent_inventor_cache_by_keys_v1(TEXT[]),
  public.enqueue_patent_lookup_v1(TEXT, TEXT, TEXT, TEXT),
  public.upsert_term_alias_v1(TEXT, TEXT, TEXT)
TO app_user;

-- ---------------------------------------------------------------------------
-- 4) Migration privilege self-check across all 16 tables
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'public.monitored_source',
    'public.outreach_global_suppression',
    'public.patent_inventor_cache',
    'public.patent_inventor_tombstone',
    'public.patent_lookup_request',
    'public.signal_ingest',
    'public.source_channel',
    'public.source_channel_health_event',
    'public.source_channel_probe',
    'public.source_channel_record',
    'public.source_channel_run',
    'public.source_entity',
    'public.source_entity_change',
    'public.source_fetch',
    'public.source_signal',
    'public.term_alias'
  ]
  LOOP
    IF NOT has_table_privilege('app_user', tbl, 'SELECT') THEN
      RAISE EXCEPTION 'APP_USER_MISSING_SELECT_ON_PLATFORM_TABLE: %', tbl;
    END IF;
    IF has_table_privilege('app_user', tbl, 'INSERT')
       OR has_table_privilege('app_user', tbl, 'UPDATE')
       OR has_table_privilege('app_user', tbl, 'DELETE')
    THEN
      RAISE EXCEPTION 'APP_USER_WRITE_PRIVILEGE_STILL_PRESENT: %', tbl;
    END IF;
  END LOOP;
END $$;

COMMIT;
