-- CreateIndex
CREATE INDEX "outbox_delivery_workspace_id_sink_id_idx" ON "outbox_delivery"("workspace_id", "sink", "id");
