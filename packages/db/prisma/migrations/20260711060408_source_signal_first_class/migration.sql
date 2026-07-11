-- CreateTable
CREATE TABLE "source_signal" (
    "id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "signal_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "subject_name" TEXT NOT NULL,
    "subject_country" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "taxonomy_keys" JSONB NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "license" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_ingest" (
    "id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "query_fingerprint" TEXT NOT NULL,
    "window_key" TEXT NOT NULL,
    "query_spec" JSONB NOT NULL,
    "records_fetched" INTEGER NOT NULL DEFAULT 0,
    "signals_upserted" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "error" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_ingest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_signal_provider_key_signal_type_status_occurred_at_idx" ON "source_signal"("provider_key", "signal_type", "status", "occurred_at");

-- CreateIndex
CREATE INDEX "source_signal_subject_key_idx" ON "source_signal"("subject_key");

-- CreateIndex
CREATE INDEX "source_signal_status_expires_at_idx" ON "source_signal"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_signal_provider_key_external_id_signal_type_subject__key" ON "source_signal"("provider_key", "external_id", "signal_type", "subject_key");

-- CreateIndex
CREATE INDEX "signal_ingest_fetched_at_idx" ON "signal_ingest"("fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "signal_ingest_provider_key_query_fingerprint_window_key_key" ON "signal_ingest"("provider_key", "query_fingerprint", "window_key");

-- 平台级共享表（无 RLS）：app_user 显式授权（基座 DEFAULT PRIVILEGES 已覆盖，此为域迁移惯例的双保险，
-- 防基座迁移在非 global owner 环境执行过导致默认授权不生效）。
GRANT SELECT, INSERT, UPDATE, DELETE ON "source_signal" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "signal_ingest" TO app_user;
