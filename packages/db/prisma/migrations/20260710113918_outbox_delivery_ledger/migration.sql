-- AlterTable
ALTER TABLE "outbox_event" ADD COLUMN     "parked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "outbox_delivery" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "sink" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "acked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_delivery_workspace_id_sink_status_idx" ON "outbox_delivery"("workspace_id", "sink", "status");

-- CreateIndex
CREATE INDEX "outbox_delivery_sink_status_next_attempt_at_idx" ON "outbox_delivery"("sink", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_delivery_event_id_sink_key" ON "outbox_delivery"("event_id", "sink");

-- AddForeignKey
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "outbox_delivery_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbox_event"("event_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "outbox_delivery_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS（标准三件套，模式同 20260706033625_rls_and_app_role）：workspace 级租户隔离。
-- app_user 的表/序列授权由既有 DEFAULT PRIVILEGES 自动覆盖，无需重复 GRANT。
ALTER TABLE outbox_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_delivery_tenant_isolation ON outbox_delivery
  USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());
