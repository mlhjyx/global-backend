-- Public web retains the exact HTTPS URL of a company detail page. Match its
-- single www alias at the origin gate (the company-site policy already does).
-- Do not alter URL safety, other provider bindings, permissions, or stored rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(
    'public.write_raw_source_record_v2_legacy(jsonb)'::regprocedure);
  prior text := $old$AND source_host IS DISTINCT FROM command_payload->>'domain')$old$;
  replacement text := $new$AND source_host IS DISTINCT FROM command_payload->>'domain'
      AND regexp_replace(source_host, '^www\.', '') IS DISTINCT FROM command_payload->>'domain')$new$;
BEGIN
  IF length(definition) - length(replace(definition, prior, '')) <> length(prior) THEN
    RAISE EXCEPTION 'RAW_SOURCE_PUBLIC_WEB_ORIGIN_PATCH_TARGET_MISMATCH';
  END IF;
  EXECUTE replace(definition, prior, replacement);
END
$migration$;

COMMIT;
