-- 渠道资源池首波（GainOS 深化计划 v3.0 第 6 章，CH-1/CH-2/CH-3/CH-4/CH-7/CH-10 的数据层）：
--   * source_channel 原地扩展：manifest（channel-manifest/v1，canonical JSON + sha256）、
--     连接器种类、baseUrl、auth_ref（密钥只存引用）、rate_limit/quota_policy/pagination/
--     field_mapping、健康物化列（health_state/consecutive_failures/last_success_at/
--     disabled_reason）、probe_required（配置变更后置位，保存即测试的前提）。
--   * source_channel_probe：每次「保存即测试」一行（与 run 分开，probe 不计入 failure streak）。
--   * source_channel_health_event：健康事件流（熔断/预警/自动停用/人工操作/试跑结果），
--     运营台时间线与通知的单一来源。
-- 兼容策略（章节 §6.3.2）：所有新列可空或带默认；17 行历史数据的 config 原值保留，
-- manifest 为 NULL 时读路径走 configToManifest 过渡解析。ENABLED 行回填 probe_required=false
-- （已在线运行的渠道不因新闸门停摆）；其余行保持 true。
-- Additive, no destructive statements.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "source_channel"
  ADD COLUMN "manifest" JSONB,
  ADD COLUMN "manifest_sha256" CHAR(64),
  ADD COLUMN "manifest_version" VARCHAR(32) NOT NULL DEFAULT 'channel-manifest/v1',
  ADD COLUMN "connector_kind" VARCHAR(16) NOT NULL DEFAULT 'manifest',
  ADD COLUMN "adapter_key" VARCHAR(64),
  ADD COLUMN "base_url" VARCHAR(2048),
  ADD COLUMN "auth_ref" JSONB,
  ADD COLUMN "rate_limit" JSONB,
  ADD COLUMN "pagination" JSONB,
  ADD COLUMN "field_mapping" JSONB,
  ADD COLUMN "health_state" JSONB,
  ADD COLUMN "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_success_at" TIMESTAMPTZ(3),
  ADD COLUMN "disabled_reason" VARCHAR(64),
  ADD COLUMN "quota_policy" JSONB,
  ADD COLUMN "probe_required" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "source_channel"
  ADD CONSTRAINT "source_channel_connector_kind_check"
    CHECK ("connector_kind" IN ('manifest', 'adapter')),
  ADD CONSTRAINT "source_channel_adapter_key_check"
    CHECK (("connector_kind" = 'manifest' AND "adapter_key" IS NULL) OR ("connector_kind" = 'adapter' AND "adapter_key" IS NOT NULL)),
  ADD CONSTRAINT "source_channel_base_url_check"
    CHECK ("base_url" IS NULL OR "base_url" LIKE 'https://%'),
  ADD CONSTRAINT "source_channel_consecutive_failures_check"
    CHECK ("consecutive_failures" BETWEEN 0 AND 100000),
  ADD CONSTRAINT "source_channel_disabled_reason_check"
    CHECK ("disabled_reason" IS NULL OR "disabled_reason" IN ('OPERATOR', 'AUTO_STREAK', 'AUTO_FAILURE_RATE', 'GOVERNANCE')),
  ADD CONSTRAINT "source_channel_manifest_shape_check"
    CHECK ("manifest" IS NULL OR (jsonb_typeof("manifest") = 'object' AND char_length("manifest_sha256") = 64));

CREATE INDEX "source_channel_health_idx"
  ON "source_channel" (("health_state"->>'circuit'), "status");
-- 命名按 Prisma datamodel 的默认名（#903 drift 门）：@@index([lastSuccessAt]) → _last_success_at_idx。
CREATE INDEX "source_channel_last_success_at_idx"
  ON "source_channel" ("last_success_at");

-- 已在线运行的渠道不因新闸门停摆（章节 §6.3.2 的回填要求）；其余行保持 probe_required=true。
UPDATE "source_channel" SET "probe_required" = false WHERE "status" = 'ENABLED';

CREATE TABLE "source_channel_probe" (
  "id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "manifest_sha256" CHAR(64) NOT NULL,
  "mode" VARCHAR(8) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "pages_fetched" INTEGER NOT NULL DEFAULT 0,
  "records_found" INTEGER NOT NULL DEFAULT 0,
  "sample" JSONB,
  "field_fill_rates" JSONB,
  "robots_decision" VARCHAR(16),
  "robots_hash" CHAR(64),
  "error_code" VARCHAR(64),
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(3),

  CONSTRAINT "source_channel_probe_pkey" PRIMARY KEY ("id"),
  -- 约束/索引名与 Prisma datamodel 默认命名一致（#903 drift 门）。
  CONSTRAINT "source_channel_probe_channel_id_fkey" FOREIGN KEY ("channel_id")
    REFERENCES "source_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "source_channel_probe_mode_check" CHECK ("mode" IN ('preview', 'probe')),
  CONSTRAINT "source_channel_probe_status_check" CHECK ("status" IN ('SUCCEEDED', 'FAILED')),
  CONSTRAINT "source_channel_probe_counts_check" CHECK (
    "pages_fetched" BETWEEN 0 AND 1000000 AND "records_found" BETWEEN 0 AND 1000000
  ),
  CONSTRAINT "source_channel_probe_robots_check" CHECK (
    "robots_decision" IS NULL OR "robots_decision" IN ('ALLOWS', 'RESTRICTS', 'UNREACHABLE')
  )
);

CREATE INDEX "source_channel_probe_channel_id_started_at_idx"
  ON "source_channel_probe" ("channel_id", "started_at" DESC);

CREATE TABLE "source_channel_health_event" (
  "id" UUID NOT NULL,
  "channel_id" UUID NOT NULL,
  "event" VARCHAR(48) NOT NULL,
  "detail" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "source_channel_health_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_channel_health_event_channel_id_fkey" FOREIGN KEY ("channel_id")
    REFERENCES "source_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "source_channel_health_event_event_check" CHECK ("event" IN (
    'CIRCUIT_OPEN', 'CIRCUIT_HALF_OPEN', 'CIRCUIT_CLOSED',
    'WARNING_20_4D', 'AUTO_DISABLED_30_7D', 'AUTO_DISABLED_FAILURE_RATE',
    'MANUAL_ENABLE', 'MANUAL_DISABLE', 'SECRET_ROTATED',
    'PROBE_PASSED', 'PROBE_FAILED'
  ))
);

CREATE INDEX "source_channel_health_event_channel_id_created_at_idx"
  ON "source_channel_health_event" ("channel_id", "created_at" DESC);

-- 平台表无租户列，沿用 source_channel/source_channel_run 的惯例：不启用 RLS，
-- 由引擎 API 的 ops scope 闸门把关；health_event 是追加流，不授予 UPDATE/DELETE。
GRANT SELECT, INSERT, UPDATE ON TABLE "source_channel_probe" TO app_user;
GRANT SELECT, INSERT ON TABLE "source_channel_health_event" TO app_user;

COMMIT;
