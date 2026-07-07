-- CreateTable
CREATE TABLE "monitored_source" (
    "id" UUID NOT NULL,
    "provider_key" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "sector_tags" JSONB,
    "region" TEXT,
    "series_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cadence" JSONB,
    "last_fetch_at" TIMESTAMP(3),
    "next_fetch_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitored_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_fetch" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "added" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "parser_version" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "source_fetch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_entity" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "entity_kind" TEXT NOT NULL DEFAULT 'company',
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "country" TEXT,
    "cleaned" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMP(3),
    "miss_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_entity_change" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "fetch_id" UUID,
    "external_id" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_entity_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monitored_source_source_key_key" ON "monitored_source"("source_key");

-- CreateIndex
CREATE INDEX "monitored_source_provider_key_status_idx" ON "monitored_source"("provider_key", "status");

-- CreateIndex
CREATE INDEX "monitored_source_next_fetch_at_idx" ON "monitored_source"("next_fetch_at");

-- CreateIndex
CREATE INDEX "source_fetch_source_id_idx" ON "source_fetch"("source_id");

-- CreateIndex
CREATE INDEX "source_entity_domain_idx" ON "source_entity"("domain");

-- CreateIndex
CREATE INDEX "source_entity_source_id_withdrawn_at_idx" ON "source_entity"("source_id", "withdrawn_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_entity_source_id_external_id_key" ON "source_entity"("source_id", "external_id");

-- CreateIndex
CREATE INDEX "source_entity_change_source_id_change_type_idx" ON "source_entity_change"("source_id", "change_type");

-- CreateIndex
CREATE INDEX "source_entity_change_created_at_idx" ON "source_entity_change"("created_at");

-- AddForeignKey
ALTER TABLE "source_fetch" ADD CONSTRAINT "source_fetch_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "monitored_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_entity" ADD CONSTRAINT "source_entity_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "monitored_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_entity_change" ADD CONSTRAINT "source_entity_change_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "monitored_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_entity_change" ADD CONSTRAINT "source_entity_change_fetch_id_fkey" FOREIGN KEY ("fetch_id") REFERENCES "source_fetch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
