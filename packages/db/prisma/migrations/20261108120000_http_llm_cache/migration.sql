-- PR-B 缓存层（主计划 §0.2 步 5；设计 docs/superpowers/plans/2026-11-04-http-cache-pr-b.md）：
--   * url_content_cache：HTTP-first 页面缓存（ETag/Last-Modified 条件请求，304 复用正文）。
--   * llm_extraction_cache：结构化任务结果缓存（输入全文 digest + task/model/契约版本为键）。
-- Additive, no backfill。两表均为 FORCE RLS 租户表（workspace_id = current_workspace_id()），
-- 24h TTL 由应用写 expires_at；expires_at 清理双通道：应用写入路径按 workspace 清 + 下列
-- owner 权限的 purge 函数（照 list_due_raw_retention_workspaces_v1 先例：SECURITY DEFINER、
-- 只删过期行、session_user 守卫、REVOKE PUBLIC）。缓存是派生数据，可随时丢弃重建。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "url_content_cache" (
  "workspace_id" UUID NOT NULL,
  "url_hash" VARCHAR(64) NOT NULL,
  "url" TEXT NOT NULL,
  "etag" TEXT,
  "last_modified" TEXT,
  "content_hash" VARCHAR(64) NOT NULL,
  "markdown" TEXT NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "url_content_cache_pkey" PRIMARY KEY ("workspace_id", "url_hash"),
  CONSTRAINT "url_content_cache_url_hash_check" CHECK (char_length("url_hash") = 64),
  CONSTRAINT "url_content_cache_content_hash_check" CHECK (char_length("content_hash") = 64)
);

CREATE INDEX "url_content_cache_workspace_expires_idx"
  ON "url_content_cache"("workspace_id", "expires_at");
-- 跨租户 purge 函数按 expires_at 全局扫（无 workspace 前缀）。
CREATE INDEX "url_content_cache_expires_idx"
  ON "url_content_cache"("expires_at");

CREATE TABLE "llm_extraction_cache" (
  "workspace_id" UUID NOT NULL,
  "cache_key" VARCHAR(64) NOT NULL,
  "task_id" VARCHAR(160) NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "llm_extraction_cache_pkey" PRIMARY KEY ("workspace_id", "cache_key"),
  CONSTRAINT "llm_extraction_cache_key_check" CHECK (char_length("cache_key") = 64),
  CONSTRAINT "llm_extraction_cache_task_check" CHECK (char_length("task_id") BETWEEN 1 AND 160)
);

CREATE INDEX "llm_extraction_cache_workspace_expires_idx"
  ON "llm_extraction_cache"("workspace_id", "expires_at");
CREATE INDEX "llm_extraction_cache_expires_idx"
  ON "llm_extraction_cache"("expires_at");

ALTER TABLE "url_content_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "url_content_cache" FORCE ROW LEVEL SECURITY;
CREATE POLICY "url_content_cache_tenant_isolation" ON "url_content_cache"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "url_content_cache" TO app_user;

ALTER TABLE "llm_extraction_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "llm_extraction_cache" FORCE ROW LEVEL SECURITY;
CREATE POLICY "llm_extraction_cache_tenant_isolation" ON "llm_extraction_cache"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "llm_extraction_cache" TO app_user;

-- 过期清理（跨租户批量；只删 expires_at 已过的行，绝不返回行内容）。
CREATE FUNCTION purge_expired_url_content_cache_v1(p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE deleted INTEGER;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_limit NOT BETWEEN 1 AND 10000
  THEN
    RAISE EXCEPTION 'HTTP_CACHE_PURGE_DENIED' USING ERRCODE = '42501';
  END IF;
  WITH due AS (
    SELECT "workspace_id", "url_hash"
    FROM public."url_content_cache"
    WHERE "expires_at" <= statement_timestamp()
    LIMIT p_limit
  )
  DELETE FROM public."url_content_cache" AS c
  USING due
  WHERE c."workspace_id" = due."workspace_id" AND c."url_hash" = due."url_hash";
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

CREATE FUNCTION purge_expired_llm_extraction_cache_v1(p_limit INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE deleted INTEGER;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_setting('role', true) IS DISTINCT FROM 'none'
    OR p_limit NOT BETWEEN 1 AND 10000
  THEN
    RAISE EXCEPTION 'HTTP_CACHE_PURGE_DENIED' USING ERRCODE = '42501';
  END IF;
  WITH due AS (
    SELECT "workspace_id", "cache_key"
    FROM public."llm_extraction_cache"
    WHERE "expires_at" <= statement_timestamp()
    LIMIT p_limit
  )
  DELETE FROM public."llm_extraction_cache" AS c
  USING due
  WHERE c."workspace_id" = due."workspace_id" AND c."cache_key" = due."cache_key";
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION purge_expired_url_content_cache_v1(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_expired_llm_extraction_cache_v1(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_url_content_cache_v1(INTEGER) TO app_user;
GRANT EXECUTE ON FUNCTION purge_expired_llm_extraction_cache_v1(INTEGER) TO app_user;

COMMIT;
