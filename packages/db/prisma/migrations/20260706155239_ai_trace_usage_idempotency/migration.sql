-- AlterTable
ALTER TABLE "knowledge_source" ADD COLUMN     "ingest_key" TEXT;

-- AlterTable
ALTER TABLE "outbox_event" ADD COLUMN     "producer" TEXT NOT NULL DEFAULT 'global-backend';

-- CreateTable
CREATE TABLE "ai_trace" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error_message" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_trace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "cost_usd" DOUBLE PRECISION,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_trace_workspace_id_idx" ON "ai_trace"("workspace_id");

-- CreateIndex
CREATE INDEX "ai_trace_workspace_id_task_idx" ON "ai_trace"("workspace_id", "task");

-- CreateIndex
CREATE INDEX "usage_ledger_workspace_id_idx" ON "usage_ledger"("workspace_id");

-- CreateIndex
CREATE INDEX "usage_ledger_workspace_id_resource_type_idx" ON "usage_ledger"("workspace_id", "resource_type");

-- CreateIndex
CREATE INDEX "idempotency_key_workspace_id_idx" ON "idempotency_key"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_workspace_id_endpoint_key_key" ON "idempotency_key"("workspace_id", "endpoint", "key");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_source_company_id_ingest_key_key" ON "knowledge_source"("company_id", "ingest_key");


-- ── Row-Level Security (ADR-001) ──
ALTER TABLE "ai_trace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_trace" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_trace_tenant_isolation" ON "ai_trace"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "usage_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_ledger" FORCE ROW LEVEL SECURITY;
CREATE POLICY "usage_ledger_tenant_isolation" ON "usage_ledger"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

ALTER TABLE "idempotency_key" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_key" FORCE ROW LEVEL SECURITY;
CREATE POLICY "idempotency_key_tenant_isolation" ON "idempotency_key"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "ai_trace", "usage_ledger", "idempotency_key" TO app_user;
