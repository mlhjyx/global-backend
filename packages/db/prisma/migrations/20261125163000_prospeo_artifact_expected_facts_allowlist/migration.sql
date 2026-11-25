-- Batch 1.6.1: add 'contact-email-find-prospeo/v1' to the closed
-- artifact expected-facts schema allowlist (all six HTTP facts must be NULL),
-- matching 'contact-email-find-hunter/v1' and TypeScript artifact-expected-facts.ts.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.generic_operation_artifact_expected_facts_valid_v1(
  p_result_schema TEXT,
  p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN,
  p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT,
  p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(CASE p_result_schema
    WHEN 'sanctions-download/v1' THEN
      p_expected_http_status IS NULL
      AND p_expected_http_ok IS NULL
      AND p_expected_sanitized_url IS NULL
      AND p_expected_content_hash IS NULL
      AND p_expected_blocked_code IS NULL
      AND p_expected_robots_blocked IS NULL
    WHEN 'contact-email-find-hunter/v1' THEN
      p_expected_http_status IS NULL
      AND p_expected_http_ok IS NULL
      AND p_expected_sanitized_url IS NULL
      AND p_expected_content_hash IS NULL
      AND p_expected_blocked_code IS NULL
      AND p_expected_robots_blocked IS NULL
    WHEN 'contact-email-find-prospeo/v1' THEN
      p_expected_http_status IS NULL
      AND p_expected_http_ok IS NULL
      AND p_expected_sanitized_url IS NULL
      AND p_expected_content_hash IS NULL
      AND p_expected_blocked_code IS NULL
      AND p_expected_robots_blocked IS NULL
    WHEN 'http-get/v1' THEN
      p_expected_http_status IS NOT NULL
      AND p_expected_http_ok IS NOT NULL
      AND p_expected_content_hash IS NULL
      AND p_expected_robots_blocked IS NULL
      AND COALESCE((
        p_expected_http_status = 0
        AND p_expected_http_ok = false
        AND p_expected_sanitized_url IS NULL
        AND p_expected_blocked_code ~ '^[a-z][a-z0-9_]{0,79}$'
      ) OR (
        p_expected_http_status BETWEEN 100 AND 599
        AND p_expected_http_ok = (p_expected_http_status BETWEEN 200 AND 299)
        AND p_expected_blocked_code IS NULL
        AND generic_operation_artifact_sanitized_url_valid_v1(
          p_expected_sanitized_url
        )
      ), false)
    WHEN 'crawl4ai-fetch/v1' THEN
      p_expected_http_status IS NULL
      AND p_expected_http_ok IS NULL
      AND p_expected_blocked_code IS NULL
      AND p_expected_robots_blocked IS NULL
      AND generic_operation_artifact_sanitized_url_valid_v1(
        p_expected_sanitized_url
      )
      AND p_expected_content_hash ~ '^[0-9a-f]{24}$'
    WHEN 'crawl4ai-render/v1' THEN
      p_expected_http_status IS NULL
      AND p_expected_http_ok IS NULL
      AND p_expected_content_hash IS NULL
      AND p_expected_blocked_code IS NULL
      AND p_expected_robots_blocked IS NOT NULL
      AND generic_operation_artifact_sanitized_url_valid_v1(
        p_expected_sanitized_url
      )
    ELSE false
  END, false)
$$;

REVOKE ALL ON FUNCTION public.generic_operation_artifact_expected_facts_valid_v1(
  TEXT, SMALLINT, BOOLEAN, TEXT, TEXT, TEXT, BOOLEAN
) FROM PUBLIC, app_user, execution_budget_platform_writer;

COMMIT;
