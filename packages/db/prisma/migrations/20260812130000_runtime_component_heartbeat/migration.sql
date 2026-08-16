-- Platform-level, durable runtime leases. These rows prove that independent
-- executors are renewing through PostgreSQL; they do not contain tenant data.
CREATE TABLE "runtime_component_heartbeat" (
  "component" TEXT NOT NULL,
  "instance_id" UUID NOT NULL,
  "state" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "heartbeat_at" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "runtime_component_heartbeat_pkey"
    PRIMARY KEY ("component", "instance_id"),
  CONSTRAINT "runtime_component_heartbeat_component_check"
    CHECK ("component" IN ('WORKER', 'OUTBOX_RELAY')),
  CONSTRAINT "runtime_component_heartbeat_state_check"
    CHECK ("state" IN ('RUNNING', 'STOPPED')),
  CONSTRAINT "runtime_component_heartbeat_time_check"
    CHECK ("heartbeat_at" >= "started_at")
);

CREATE INDEX "runtime_component_heartbeat_component_freshness_idx"
  ON "runtime_component_heartbeat"("component", "heartbeat_at" DESC);

-- Worker and relay use the owner connection to renew. The API app role may
-- inspect leases for /health/ready but cannot forge or erase runtime evidence.
REVOKE INSERT, UPDATE, DELETE ON TABLE "runtime_component_heartbeat" FROM app_user;
GRANT SELECT ON TABLE "runtime_component_heartbeat" TO app_user;
