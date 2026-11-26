-- MT-P2: Allow both legacy bi:v1:<64hex> and Keyring bi:v2:<keyId>:<64hex> blind keys
-- in contact_point.domain_blind_key and M4 patent inventor erasure RPCs.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "contact_point" DROP CONSTRAINT "contact_point_domain_blind_key_check";
ALTER TABLE "contact_point"
  ADD CONSTRAINT "contact_point_domain_blind_key_check"
    CHECK (
      "domain_blind_key" IS NULL
      OR "domain_blind_key" ~ '^(bi:v1:[0-9a-f]{64}|bi:v2:[A-Za-z0-9_-]{1,32}:[0-9a-f]{64})$'
    );

CREATE OR REPLACE FUNCTION public.record_patent_inventor_tombstones_v1(
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
    WHERE k IS NULL OR btrim(k) !~ '^(bi:v1:[0-9a-f]{64}|bi:v2:[A-Za-z0-9_-]{1,32}:[0-9a-f]{64})$'
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

CREATE OR REPLACE FUNCTION public.purge_patent_inventor_cache_by_keys_v1(
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
    WHERE k IS NULL OR btrim(k) !~ '^(bi:v1:[0-9a-f]{64}|bi:v2:[A-Za-z0-9_-]{1,32}:[0-9a-f]{64})$'
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

REVOKE ALL ON FUNCTION public.record_patent_inventor_tombstones_v1(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_patent_inventor_tombstones_v1(TEXT[]) TO app_user;

REVOKE ALL ON FUNCTION public.purge_patent_inventor_cache_by_keys_v1(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_patent_inventor_cache_by_keys_v1(TEXT[]) TO app_user;

COMMIT;
