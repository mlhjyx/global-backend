import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(
    root,
    "packages/db/prisma/migrations/20260907100000_platform_egress_fence/migration.sql",
  ),
  "utf8",
);

test("platform egress fence migration creates durable generation and attempt state", () => {
  assert.match(migration, /CREATE TABLE "platform_egress_schedule_fence"/u);
  assert.match(migration, /CREATE TABLE "platform_egress_attempt"/u);
  assert.match(migration, /ALTER TABLE "platform_egress_schedule_fence" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "platform_egress_schedule_fence" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "platform_egress_attempt" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /platform_egress_attempt_authority_operation_key/u);
  assert.match(migration, /platform_egress_attempt_run_operation_key/u);
  assert.match(migration, /"workflow_id" VARCHAR\(200\) NOT NULL/u);
  assert.match(migration, /authority\.workflow_id IS DISTINCT FROM p_workflow_id/u);
  assert.match(migration, /attempt\.workflow_id IS DISTINCT FROM p_workflow_id/u);
  assert.match(migration, /generation = generation \+ 1/u);
});

test("only the platform writer receives dispatch lifecycle functions", () => {
  assert.match(migration, /GRANT EXECUTE ON FUNCTION authorize_platform_egress_v1/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*claim_platform_egress_send_v1/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*acknowledge_platform_egress_v1/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*mark_unknown_platform_egress_v1/u);
  assert.match(migration, /TO execution_budget_platform_writer/u);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION fence_platform_schedule_v1/u);
  assert.match(migration, /REVOKE ALL ON "platform_egress_schedule_fence", "platform_egress_attempt"[\s\S]*execution_budget_platform_writer/u);
  assert.match(migration, /state = 'UNKNOWN'/u);
  assert.match(migration, /state = 'AUTHORIZED'/u);
  assert.match(migration, /state = 'SENDING'/u);
});

test("fence functions reject stale generations and preserve unknown no-redispatch state", () => {
  assert.match(migration, /attempt\.generation IS DISTINCT FROM fence\.generation/u);
  assert.match(migration, /attempt\.state <> 'AUTHORIZED'/u);
  assert.match(migration, /state = 'BLOCKED'/u);
  assert.match(migration, /state = 'UNKNOWN'/u);
  assert.match(migration, /RETURN EXISTS \(SELECT 1 FROM "platform_egress_attempt" WHERE id = p_attempt_id AND state = 'UNKNOWN'\)/u);
  assert.match(migration, /RETURN EXISTS \(SELECT 1 FROM "platform_egress_attempt" WHERE id = p_attempt_id AND state = 'ACKNOWLEDGED'\)/u);
});
