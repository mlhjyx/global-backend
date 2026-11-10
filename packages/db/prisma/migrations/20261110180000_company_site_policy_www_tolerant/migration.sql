-- 公司站点绑定 www 容错（2026-11-11）：证据 URL 常见 www.<domain>，而记录域名字段不带
-- www——writer 的 company-site ACCEPTED 检查必须与站策略比较同口径（host_key 已 strip 一层
-- www），否则真实数据（run 103a4b1d：www.3sun.com vs 3sun.com）以
-- RAW_SOURCE_WRITER_POLICY_BINDING_INVALID 拒绝、整条查询提交失败。
-- 仅改这一处比较，其余逐字保留。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE OR REPLACE FUNCTION public.raw_source_policy_binding_v3(p_provider_key text, p_ingest_status text, p_source_host text, p_payload jsonb, p_policy_id uuid, p_retention_days integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
    -- The company-site policy: public_web / model_web_search only, never over a site
    -- policy, and an ACCEPTED
    -- record only on its own domain (the writer's origin binding requires that too).
    IF p_provider_key NOT IN ('public_web','model_web_search')
      OR covering_length IS NOT NULL
      OR (p_ingest_status='ACCEPTED'
        AND regexp_replace(p_source_host,'^www\.','')
          IS DISTINCT FROM p_payload->>'domain')
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
$function$;

COMMIT;
