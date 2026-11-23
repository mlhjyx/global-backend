-- 联系人补强安全首片：两张业务索引表 + 原账本复合外键 + FORCE RLS。
-- 唯一费用事实仍在原 tool_budget_account/tool_budget_operation 及其回执；本迁移不建第二钱包。
-- 迁移 ID 由 Root 正式预约（20261123074206）；字节自首次 git-add 冻结。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE TABLE "contact_enrichment_execution" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "company_id" UUID,
  "entrypoint" VARCHAR(20) NOT NULL,
  "business_run_id" UUID,
  "authority_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "request_sha256" CHAR(64) NOT NULL,
  "admission_request_sha256" CHAR(64) NOT NULL,
  "operation_ref" CHAR(64) NOT NULL,
  "protocol_version" SMALLINT NOT NULL,
  "plan_sha256" CHAR(64) NOT NULL,
  "frozen_limits" JSONB NOT NULL,
  "target_snapshot" JSONB NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "quality_coverage" VARCHAR(30) NOT NULL,
  "result_revision" INTEGER NOT NULL DEFAULT 1,
  "result_snapshot" JSONB,
  "scope_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "finalized_at" TIMESTAMPTZ,
  CONSTRAINT "contact_enrichment_execution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contact_enrichment_execution_entrypoint_check"
    CHECK ("entrypoint" IN ('http', 'discovery_run')),
  CONSTRAINT "contact_enrichment_execution_entrypoint_run_check"
    CHECK (("entrypoint" = 'http') = ("business_run_id" IS NULL)),
  CONSTRAINT "contact_enrichment_execution_generation_check"
    CHECK ("generation" >= 1),
  CONSTRAINT "contact_enrichment_execution_digest_check"
    CHECK ("request_sha256" ~ '^[0-9a-f]{64}$'
      AND "admission_request_sha256" ~ '^[0-9a-f]{64}$'
      AND "operation_ref" ~ '^[0-9a-f]{64}$'
      AND "plan_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contact_enrichment_execution_protocol_check"
    CHECK ("protocol_version" = 1),
  CONSTRAINT "contact_enrichment_execution_quality_check"
    CHECK ("quality_coverage" = 'PREREQUISITE_ONLY'),
  CONSTRAINT "contact_enrichment_execution_status_check"
    CHECK ("status" IN ('PREPARED','RUNNING','RESULT_UNKNOWN','APPLY_PENDING','COMPLETED','FAILED','REDACTED')),
  CONSTRAINT "contact_enrichment_execution_result_revision_check"
    CHECK ("result_revision" >= 1),
  CONSTRAINT "contact_enrichment_execution_json_check"
    CHECK (jsonb_typeof("frozen_limits") = 'object'
      AND jsonb_typeof("target_snapshot") = 'array'
      AND jsonb_array_length("target_snapshot") <= 10
      AND ("result_snapshot" IS NULL OR jsonb_typeof("result_snapshot") = 'object')),
  CONSTRAINT "contact_enrichment_execution_scope_key_check"
    CHECK ("scope_key" = "workspace_id"::text)
);

CREATE UNIQUE INDEX "contact_enrichment_execution_workspace_id_id_key"
  ON "contact_enrichment_execution" ("workspace_id", "id");
CREATE UNIQUE INDEX "contact_enrichment_execution_workspace_operation_ref_key"
  ON "contact_enrichment_execution" ("workspace_id", "operation_ref");
-- HTTP 与 run 各自的明确 nullable 语义：不能用普通 UNIQUE 忽略 NULL。
CREATE UNIQUE INDEX "contact_enrichment_execution_http_identity_key"
  ON "contact_enrichment_execution" ("workspace_id", "company_id", "authority_id", "account_id", "generation", "request_sha256")
  WHERE "entrypoint" = 'http';
CREATE UNIQUE INDEX "contact_enrichment_execution_run_identity_key"
  ON "contact_enrichment_execution" ("workspace_id", "company_id", "authority_id", "account_id", "generation", "request_sha256", "business_run_id")
  WHERE "entrypoint" = 'discovery_run';
CREATE INDEX "contact_enrichment_execution_list_idx"
  ON "contact_enrichment_execution" ("workspace_id", "company_id", "created_at", "id");

ALTER TABLE "contact_enrichment_execution"
  ADD CONSTRAINT "contact_enrichment_execution_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contact_enrichment_execution"
  ADD CONSTRAINT "contact_enrichment_execution_authority_scope_fkey"
  FOREIGN KEY ("scope_key", "authority_id") REFERENCES "execution_budget_authority"("scope_key", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "contact_enrichment_execution"
  ADD CONSTRAINT "contact_enrichment_execution_account_scope_fkey"
  FOREIGN KEY ("scope_key", "account_id") REFERENCES "tool_budget_account"("scope_key", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
-- 复合 SET NULL 只清 company_id，不能清 workspace_id。
ALTER TABLE "contact_enrichment_execution"
  ADD CONSTRAINT "contact_enrichment_execution_company_scope_fkey"
  FOREIGN KEY ("workspace_id", "company_id") REFERENCES "canonical_company"("workspace_id", "id")
  ON DELETE SET NULL ("company_id") ON UPDATE CASCADE;

CREATE TABLE "contact_enrichment_execution_step" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "scope_key" VARCHAR(200) NOT NULL,
  "execution_id" UUID NOT NULL,
  "contact_id" UUID,
  "contact_ordinal" INTEGER NOT NULL,
  "slot_ordinal" INTEGER NOT NULL,
  "slot_key" VARCHAR(256) NOT NULL,
  "phase" VARCHAR(10) NOT NULL,
  "provider" VARCHAR(256) NOT NULL,
  "tool_id" VARCHAR(256) NOT NULL,
  "tool_version" VARCHAR(256) NOT NULL,
  "quote_microusd" BIGINT NOT NULL,
  "pricing_version" VARCHAR(256) NOT NULL,
  "depends_on_slot_key" VARCHAR(256),
  "input_fingerprint" CHAR(64),
  "operation_key" VARCHAR(256),
  "budget_operation_id" UUID,
  "candidate_ref" JSONB,
  "revision" INTEGER NOT NULL,
  "dispatch_phase" VARCHAR(30) NOT NULL,
  "domain_state" VARCHAR(20) NOT NULL,
  "reason" VARCHAR(64),
  "result_digest" CHAR(64),
  "receipt" JSONB,
  "artifact_reference" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "contact_enrichment_execution_step_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contact_enrichment_execution_step_scope_key_check"
    CHECK ("scope_key" = "workspace_id"::text),
  CONSTRAINT "contact_enrichment_execution_step_ordinal_check"
    CHECK ("contact_ordinal" BETWEEN 0 AND 9 AND "slot_ordinal" BETWEEN 0 AND 69),
  -- PostgreSQL regex 重复次数上限为 255；长度上界由 VARCHAR(256) 列类型承担。
  CONSTRAINT "contact_enrichment_execution_step_identifier_check"
    CHECK ("slot_key" ~ '^[A-Za-z0-9._:-]+$'
      AND "provider" ~ '^[A-Za-z0-9._:-]+$'
      AND "tool_id" ~ '^[A-Za-z0-9._:-]+$'
      AND "tool_version" ~ '^[A-Za-z0-9._:-]+$'
      AND "pricing_version" ~ '^[A-Za-z0-9._:-]+$'
      AND ("depends_on_slot_key" IS NULL OR "depends_on_slot_key" ~ '^[A-Za-z0-9._:-]+$')
      AND ("operation_key" IS NULL OR "operation_key" ~ '^[A-Za-z0-9:._/-]{1,200}$')),
  CONSTRAINT "contact_enrichment_execution_step_phase_check"
    CHECK ("phase" IN ('FINDER','VERIFY','SMTP')),
  CONSTRAINT "contact_enrichment_execution_step_quote_check"
    CHECK ("quote_microusd" >= 0),
  CONSTRAINT "contact_enrichment_execution_step_digest_check"
    CHECK (("input_fingerprint" IS NULL OR "input_fingerprint" ~ '^[0-9a-f]{64}$')
      AND ("result_digest" IS NULL OR "result_digest" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "contact_enrichment_execution_step_revision_check"
    CHECK ("revision" >= 1),
  CONSTRAINT "contact_enrichment_execution_step_dispatch_check"
    CHECK ("dispatch_phase" IN ('ADMITTED','RESERVED','RESULT_UNKNOWN','SETTLED_WAITING_APPLY','SETTLED','RELEASED','REDACTED')),
  CONSTRAINT "contact_enrichment_execution_step_domain_check"
    CHECK ("domain_state" IN ('PENDING','APPLIED','SAVE_PENDING','REDACTED')),
  CONSTRAINT "contact_enrichment_execution_step_reason_check"
    CHECK ("reason" IS NULL OR "reason" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT "contact_enrichment_execution_step_json_check"
    CHECK (("candidate_ref" IS NULL OR jsonb_typeof("candidate_ref") = 'object')
      AND ("receipt" IS NULL OR jsonb_typeof("receipt") = 'object')
      AND ("artifact_reference" IS NULL OR jsonb_typeof("artifact_reference") = 'object')),
  -- 插入时三项未封口字段必须为 NULL（仓储固定 INSERT 列表）；绑定后 ADMITTED 允许
  -- 指纹+幂等键已设而预算票未设，RESERVED 起必须有精确原账本 operation。
  -- 受审 DSR 的 REDACTED 行保留 operation 审计但清指纹，故整体豁免封口一致性。
  CONSTRAINT "contact_enrichment_execution_step_seal_check"
    CHECK (
      "domain_state" = 'REDACTED'
      OR (
        ("operation_key" IS NULL OR "input_fingerprint" IS NOT NULL)
        AND ("dispatch_phase" <> 'ADMITTED' OR "budget_operation_id" IS NULL)
        AND ("budget_operation_id" IS NULL
          OR ("input_fingerprint" IS NOT NULL AND "operation_key" IS NOT NULL))
        AND ("dispatch_phase" NOT IN ('RESERVED','RESULT_UNKNOWN','SETTLED_WAITING_APPLY','SETTLED')
          OR "budget_operation_id" IS NOT NULL)
        AND ("dispatch_phase" NOT IN ('SETTLED_WAITING_APPLY','SETTLED')
          OR ("result_digest" IS NOT NULL AND "receipt" IS NOT NULL))
      )
    )
);

CREATE UNIQUE INDEX "contact_enrichment_execution_step_execution_slot_ordinal_key"
  ON "contact_enrichment_execution_step" ("execution_id", "slot_ordinal");
CREATE UNIQUE INDEX "contact_enrichment_execution_step_execution_slot_key_key"
  ON "contact_enrichment_execution_step" ("execution_id", "slot_key");
-- 原 budget operation 只能映射一个 step。
CREATE UNIQUE INDEX "contact_enrichment_execution_step_budget_operation_key"
  ON "contact_enrichment_execution_step" ("scope_key", "budget_operation_id")
  WHERE "budget_operation_id" IS NOT NULL;
-- 非终态 in-flight fence：同 workspace/contact/phase/provider 的未封口或同指纹只许一个在飞。
CREATE UNIQUE INDEX "contact_enrichment_execution_step_inflight_fence_key"
  ON "contact_enrichment_execution_step" ("workspace_id", "contact_id", "phase", "provider", COALESCE("input_fingerprint", ''))
  WHERE "dispatch_phase" IN ('ADMITTED','RESERVED','RESULT_UNKNOWN','SETTLED_WAITING_APPLY')
    AND "contact_id" IS NOT NULL;
CREATE INDEX "contact_enrichment_execution_step_workspace_execution_idx"
  ON "contact_enrichment_execution_step" ("workspace_id", "execution_id");

ALTER TABLE "contact_enrichment_execution_step"
  ADD CONSTRAINT "contact_enrichment_execution_step_execution_fkey"
  FOREIGN KEY ("workspace_id", "execution_id") REFERENCES "contact_enrichment_execution"("workspace_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- 复合 SET NULL 只清 contact_id，不能清 workspace_id。
ALTER TABLE "contact_enrichment_execution_step"
  ADD CONSTRAINT "contact_enrichment_execution_step_contact_scope_fkey"
  FOREIGN KEY ("workspace_id", "contact_id") REFERENCES "canonical_contact"("workspace_id", "id")
  ON DELETE SET NULL ("contact_id") ON UPDATE CASCADE;
ALTER TABLE "contact_enrichment_execution_step"
  ADD CONSTRAINT "contact_enrichment_execution_step_operation_scope_fkey"
  FOREIGN KEY ("scope_key", "budget_operation_id") REFERENCES "tool_budget_operation"("scope_key", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- scope_key 由 workspace_id 派生；列保持普通 VARCHAR 以便 Prisma datamodel 表达，语义由触发器与 CHECK 固定。
CREATE FUNCTION "contact_enrichment_scope_key_v1"() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW."scope_key" := NEW."workspace_id"::text;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "contact_enrichment_scope_key_v1"() FROM PUBLIC, app_user;
CREATE TRIGGER "contact_enrichment_execution_scope_key"
  BEFORE INSERT ON "contact_enrichment_execution"
  FOR EACH ROW EXECUTE FUNCTION "contact_enrichment_scope_key_v1"();
CREATE TRIGGER "contact_enrichment_execution_step_scope_key"
  BEFORE INSERT ON "contact_enrichment_execution_step"
  FOR EACH ROW EXECUTE FUNCTION "contact_enrichment_scope_key_v1"();

-- 冻结列在普通 UPDATE 下不可改；DSR 的受审 redaction 可清个人关联与计划快照。
CREATE FUNCTION "contact_enrichment_execution_frozen_v1"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."scope_key" IS DISTINCT FROM OLD."scope_key"
    OR NEW."entrypoint" IS DISTINCT FROM OLD."entrypoint"
    OR NEW."business_run_id" IS DISTINCT FROM OLD."business_run_id"
    OR NEW."authority_id" IS DISTINCT FROM OLD."authority_id"
    OR NEW."account_id" IS DISTINCT FROM OLD."account_id"
    OR NEW."generation" IS DISTINCT FROM OLD."generation"
    OR NEW."request_sha256" IS DISTINCT FROM OLD."request_sha256"
    OR NEW."admission_request_sha256" IS DISTINCT FROM OLD."admission_request_sha256"
    OR NEW."operation_ref" IS DISTINCT FROM OLD."operation_ref"
    OR NEW."protocol_version" IS DISTINCT FROM OLD."protocol_version"
    OR NEW."plan_sha256" IS DISTINCT FROM OLD."plan_sha256"
    OR NEW."frozen_limits" IS DISTINCT FROM OLD."frozen_limits"
    OR NEW."quality_coverage" IS DISTINCT FROM OLD."quality_coverage"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'CONTACT_ENRICHMENT_FROZEN_COLUMN' USING ERRCODE = '23514';
  END IF;
  -- 公司删除的列级 SET NULL 是合法 live-FK 维护；只允许 non-null → NULL 这一步，
  -- 其它任何 company_id 变化仍属冻结违规；app_user 本来也没有该列的 UPDATE 授权。
  IF NEW."company_id" IS DISTINCT FROM OLD."company_id"
    AND NOT (OLD."company_id" IS NOT NULL AND NEW."company_id" IS NULL)
  THEN
    RAISE EXCEPTION 'CONTACT_ENRICHMENT_FROZEN_COLUMN' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "contact_enrichment_execution_frozen_v1"() FROM PUBLIC, app_user;
CREATE TRIGGER "contact_enrichment_execution_frozen"
  BEFORE UPDATE ON "contact_enrichment_execution"
  FOR EACH ROW EXECUTE FUNCTION "contact_enrichment_execution_frozen_v1"();

CREATE FUNCTION "contact_enrichment_execution_step_frozen_v1"() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."scope_key" IS DISTINCT FROM OLD."scope_key"
    OR NEW."execution_id" IS DISTINCT FROM OLD."execution_id"
    OR NEW."contact_ordinal" IS DISTINCT FROM OLD."contact_ordinal"
    OR NEW."slot_ordinal" IS DISTINCT FROM OLD."slot_ordinal"
    OR NEW."slot_key" IS DISTINCT FROM OLD."slot_key"
    OR NEW."phase" IS DISTINCT FROM OLD."phase"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."tool_id" IS DISTINCT FROM OLD."tool_id"
    OR NEW."tool_version" IS DISTINCT FROM OLD."tool_version"
    OR NEW."quote_microusd" IS DISTINCT FROM OLD."quote_microusd"
    OR NEW."pricing_version" IS DISTINCT FROM OLD."pricing_version"
    OR NEW."depends_on_slot_key" IS DISTINCT FROM OLD."depends_on_slot_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'CONTACT_ENRICHMENT_STEP_FROZEN_COLUMN' USING ERRCODE = '23514';
  END IF;
  IF NEW."domain_state" IS DISTINCT FROM 'REDACTED' THEN
    IF (OLD."input_fingerprint" IS NOT NULL AND NEW."input_fingerprint" IS DISTINCT FROM OLD."input_fingerprint")
      OR (OLD."operation_key" IS NOT NULL AND NEW."operation_key" IS DISTINCT FROM OLD."operation_key")
      OR (OLD."budget_operation_id" IS NOT NULL AND NEW."budget_operation_id" IS DISTINCT FROM OLD."budget_operation_id")
    THEN
      RAISE EXCEPTION 'CONTACT_ENRICHMENT_STEP_SEALED_INPUT' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "contact_enrichment_execution_step_frozen_v1"() FROM PUBLIC, app_user;
CREATE TRIGGER "contact_enrichment_execution_step_frozen"
  BEFORE UPDATE ON "contact_enrichment_execution_step"
  FOR EACH ROW EXECUTE FUNCTION "contact_enrichment_execution_step_frozen_v1"();

-- 原 artifact expected-facts 精确白名单增加新 Hunter schema：六项 HTTP facts 必须全 NULL。
CREATE OR REPLACE FUNCTION generic_operation_artifact_expected_facts_valid_v1(
  p_result_schema TEXT, p_expected_http_status SMALLINT,
  p_expected_http_ok BOOLEAN, p_expected_sanitized_url TEXT,
  p_expected_content_hash TEXT, p_expected_blocked_code TEXT,
  p_expected_robots_blocked BOOLEAN
)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE
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

ALTER TABLE "contact_enrichment_execution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_enrichment_execution" FORCE ROW LEVEL SECURITY;
ALTER TABLE "contact_enrichment_execution_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_enrichment_execution_step" FORCE ROW LEVEL SECURITY;
CREATE POLICY "contact_enrichment_execution_tenant_isolation" ON "contact_enrichment_execution"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
CREATE POLICY "contact_enrichment_execution_step_tenant_isolation" ON "contact_enrichment_execution_step"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "contact_enrichment_execution", "contact_enrichment_execution_step"
  FROM PUBLIC, app_user;
GRANT SELECT, INSERT ON TABLE "contact_enrichment_execution", "contact_enrichment_execution_step" TO app_user;
GRANT UPDATE ("status", "target_snapshot", "result_snapshot", "result_revision")
  ON TABLE "contact_enrichment_execution" TO app_user;
GRANT UPDATE ("contact_id", "input_fingerprint", "operation_key", "budget_operation_id",
              "candidate_ref", "revision", "dispatch_phase", "domain_state", "reason",
              "result_digest", "receipt", "artifact_reference")
  ON TABLE "contact_enrichment_execution_step" TO app_user;

COMMIT;
