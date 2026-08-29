-- Close the exact application/database provider-company trim parity gap.
-- This migration is DDL/ACL only. Migrations 0900-1500 remain frozen, and
-- historical correction is isolated in the DML-only 1800 migration.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION raw_source_provider_company_name_valid_v2(
  p_value TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT octet_length(p_value) BETWEEN 1 AND 160
    AND normalize(p_value,NFKC) = p_value
    AND btrim(p_value) = p_value
    AND p_value ~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:-]*$'
    AND cardinality(regexp_split_to_array(trim(p_value),'\s+')) <= 16
    AND p_value !~ '[[:cntrl:]]'
    AND p_value !~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
    AND p_value !~* '(^|[^[:alnum:]])(bearer|basic auth|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|private[_ -]?key|first[_ -]?name|last[_ -]?name|full[_ -]?name|contact[_ -]?name|personal data|jane doe|john doe|john smith)($|[^[:alnum:]])'
    AND p_value !~* '(^|[^[:alnum:]])sk-[a-z0-9_-]{6,}'
    AND p_value !~* '([a-z][a-z0-9+.-]*://|(^|[^[:alnum:]])www\.)'
    AND public.raw_source_decimal_fold_v2(p_value)
      !~ '(^|[^[:alnum:]])([+]?[0-9][ ()\.-]*){7,}($|[^[:alnum:]])'
$$;

REVOKE ALL ON FUNCTION raw_source_provider_company_name_valid_v2(TEXT)
  FROM PUBLIC, app_user;

COMMIT;
