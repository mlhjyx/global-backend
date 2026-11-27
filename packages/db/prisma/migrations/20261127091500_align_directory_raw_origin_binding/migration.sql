-- Directory records retain the observed HTTPS URL and store its normalized
-- host (without the conventional www alias), matching the TypeScript validator.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(
    'public.write_raw_source_record_v2_legacy(jsonb)'::regprocedure);
  prior text := $old$AND source_host IS DISTINCT FROM command_payload #>> '{attributes,source_directory}')$old$;
  replacement text := $new$AND source_host IS DISTINCT FROM command_payload #>> '{attributes,source_directory}'
      AND regexp_replace(source_host, '^www\.', '') IS DISTINCT FROM command_payload #>> '{attributes,source_directory}')$new$;
BEGIN
  IF length(definition) - length(replace(definition, prior, '')) <> length(prior) THEN
    RAISE EXCEPTION 'RAW_SOURCE_DIRECTORY_ORIGIN_PATCH_TARGET_MISMATCH';
  END IF;
  EXECUTE replace(definition, prior, replacement);
END
$migration$;

COMMIT;
