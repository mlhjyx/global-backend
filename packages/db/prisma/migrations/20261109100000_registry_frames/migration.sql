-- GainOS v3.0 第 3 章 P2（召回与枚举）：registry frame 地基（T3-01 平台表子集）。
-- 平台级参考数据（无 RLS，与 data_provider/monitored_source 同模式）：app_user 只读，
-- 写入只经平台 ops（owner 连接）。全量原始快照文件不进 PG（MinIO/本地文件），本迁移
-- 只存帧定义、快照元数据（sha256 可回放）、归一实体、append-only 变更事件与跨帧链接。
-- Additive, no backfill.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "registry_frame" (
  "id" UUID NOT NULL,
  "frame_key" VARCHAR(80) NOT NULL,
  "country" CHAR(2) NOT NULL,
  "scheme" VARCHAR(40) NOT NULL,
  "label" VARCHAR(200) NOT NULL,
  "provider_key" VARCHAR(40) NOT NULL,
  "source_url" VARCHAR(2048) NOT NULL,
  "licence" VARCHAR(120) NOT NULL,
  "licence_url" VARCHAR(2048),
  "fetch_mode" VARCHAR(24) NOT NULL,
  "cadence" JSONB,
  "config" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "expected_count" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "registry_frame_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "registry_frame_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "registry_frame_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  CONSTRAINT "registry_frame_fetch_mode_check" CHECK ("fetch_mode" IN ('bulk_file', 'api_paged', 'sftp', 'manual_upload', 'athena'))
);

CREATE UNIQUE INDEX "registry_frame_frame_key_key" ON "registry_frame"("frame_key");
CREATE INDEX "registry_frame_country_status_idx" ON "registry_frame"("country", "status");

CREATE TABLE "registry_snapshot" (
  "id" UUID NOT NULL,
  "frame_id" UUID NOT NULL,
  "object_key" VARCHAR(1024) NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "bytes" BIGINT NOT NULL,
  "row_count" BIGINT NOT NULL,
  "parser_version" VARCHAR(64) NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "published_at" TIMESTAMPTZ(3),
  "status" VARCHAR(16) NOT NULL DEFAULT 'FETCHED',
  "error_code" VARCHAR(64),
  "manifest" JSONB,
  "cost_cents" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "registry_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "registry_snapshot_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "registry_snapshot_status_check" CHECK ("status" IN ('FETCHED', 'PARSED', 'FAILED', 'SUPERSEDED')),
  CONSTRAINT "registry_snapshot_counts_check" CHECK ("bytes" >= 0 AND "row_count" >= 0 AND "cost_cents" >= 0)
);

CREATE UNIQUE INDEX "registry_snapshot_frame_id_sha256_key" ON "registry_snapshot"("frame_id", "sha256");
CREATE INDEX "registry_snapshot_frame_id_fetched_at_idx" ON "registry_snapshot"("frame_id", "fetched_at" DESC);

CREATE TABLE "registry_entity" (
  "id" UUID NOT NULL,
  "scheme" VARCHAR(40) NOT NULL,
  "reg_number" VARCHAR(64) NOT NULL,
  "country" CHAR(2) NOT NULL,
  "name" VARCHAR(500) NOT NULL,
  "name_norm" VARCHAR(500) NOT NULL,
  "legal_form" VARCHAR(80),
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "address_json" JSONB,
  "city" VARCHAR(120),
  "postal_code" VARCHAR(24),
  "region" VARCHAR(120),
  "nace" VARCHAR(16),
  "nace_version" VARCHAR(16),
  "employee_band" VARCHAR(16),
  "vat_id" VARCHAR(32),
  "lei" CHAR(20),
  "website" VARCHAR(2048),
  "identifiers" JSONB,
  "source_frame_id" UUID NOT NULL,
  "last_snapshot_id" UUID NOT NULL,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawn_at" TIMESTAMPTZ(3),
  "miss_count" INTEGER NOT NULL DEFAULT 0,
  "content_hash" CHAR(64) NOT NULL,
  "attributes" JSONB,

  CONSTRAINT "registry_entity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "registry_entity_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "registry_entity_status_check" CHECK ("status" IN ('ACTIVE', 'DISSOLVED', 'INSOLVENT', 'UNKNOWN')),
  CONSTRAINT "registry_entity_employee_band_check" CHECK ("employee_band" IS NULL OR "employee_band" IN ('0', '1-9', '10-49', '50-249', '250+')),
  CONSTRAINT "registry_entity_lei_check" CHECK ("lei" IS NULL OR "lei" ~ '^[A-Z0-9]{20}$'),
  CONSTRAINT "registry_entity_miss_count_check" CHECK ("miss_count" >= 0)
);

CREATE UNIQUE INDEX "registry_entity_scheme_reg_number_key" ON "registry_entity"("scheme", "reg_number");
CREATE INDEX "registry_entity_country_nace_idx" ON "registry_entity"("country", "nace");
CREATE INDEX "registry_entity_country_postal_code_idx" ON "registry_entity"("country", "postal_code");
CREATE INDEX "registry_entity_name_norm_idx" ON "registry_entity"("name_norm");
CREATE INDEX "registry_entity_last_seen_at_idx" ON "registry_entity"("last_seen_at");
CREATE INDEX "registry_entity_lei_idx" ON "registry_entity"("lei");
CREATE INDEX "registry_entity_vat_id_idx" ON "registry_entity"("vat_id");

CREATE TABLE "registry_entity_change" (
  "id" UUID NOT NULL,
  "scheme" VARCHAR(40) NOT NULL,
  "reg_number" VARCHAR(64) NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "change_type" VARCHAR(16) NOT NULL,
  "field_diffs" JSONB,
  "content_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "registry_entity_change_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "registry_entity_change_type_check" CHECK ("change_type" IN ('ADDED', 'UPDATED', 'WITHDRAWN', 'REAPPEARED'))
);

CREATE UNIQUE INDEX "registry_entity_change_identity_key"
  ON "registry_entity_change"("scheme", "reg_number", "snapshot_id", "change_type");
CREATE INDEX "registry_entity_change_snapshot_id_change_type_idx"
  ON "registry_entity_change"("snapshot_id", "change_type");

CREATE TABLE "registry_entity_link" (
  "id" UUID NOT NULL,
  "left_scheme" VARCHAR(40) NOT NULL,
  "left_reg_number" VARCHAR(64) NOT NULL,
  "right_scheme" VARCHAR(40) NOT NULL,
  "right_reg_number" VARCHAR(64) NOT NULL,
  "link_type" VARCHAR(16) NOT NULL,
  "rule" VARCHAR(64) NOT NULL,
  "score" DOUBLE PRECISION,
  "evidence" JSONB,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PROPOSED',
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "registry_entity_link_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "registry_entity_link_type_check" CHECK ("link_type" IN ('SAME', 'PARENT', 'SUBSIDIARY', 'BRANCH', 'UNCERTAIN')),
  CONSTRAINT "registry_entity_link_status_check" CHECK ("status" IN ('PROPOSED', 'CONFIRMED', 'REJECTED')),
  CONSTRAINT "registry_entity_link_rule_check" CHECK (char_length("rule") BETWEEN 1 AND 64),
  CONSTRAINT "registry_entity_link_score_check" CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 1))
);

CREATE UNIQUE INDEX "registry_entity_link_identity_key"
  ON "registry_entity_link"("left_scheme", "left_reg_number", "right_scheme", "right_reg_number", "link_type");
CREATE INDEX "registry_entity_link_status_idx" ON "registry_entity_link"("status");

ALTER TABLE "registry_snapshot" ADD CONSTRAINT "registry_snapshot_frame_id_fkey"
  FOREIGN KEY ("frame_id") REFERENCES "registry_frame"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "registry_entity" ADD CONSTRAINT "registry_entity_source_frame_id_fkey"
  FOREIGN KEY ("source_frame_id") REFERENCES "registry_frame"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "registry_entity" ADD CONSTRAINT "registry_entity_last_snapshot_id_fkey"
  FOREIGN KEY ("last_snapshot_id") REFERENCES "registry_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "registry_entity_change" ADD CONSTRAINT "registry_entity_change_snapshot_id_fkey"
  FOREIGN KEY ("snapshot_id") REFERENCES "registry_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 平台表：app_user 只读（写入只经平台 ops / owner 连接）。
GRANT SELECT ON TABLE "registry_frame" TO app_user;
GRANT SELECT ON TABLE "registry_snapshot" TO app_user;
GRANT SELECT ON TABLE "registry_entity" TO app_user;
GRANT SELECT ON TABLE "registry_entity_change" TO app_user;
GRANT SELECT ON TABLE "registry_entity_link" TO app_user;

COMMIT;
