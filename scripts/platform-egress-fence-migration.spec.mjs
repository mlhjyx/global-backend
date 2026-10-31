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
const privilegeHardeningMigration = readFileSync(
  resolve(
    root,
    "packages/db/prisma/migrations/20260907110000_platform_egress_fence_privilege_hardening/migration.sql",
  ),
  "utf8",
);
const readinessMigration = readFileSync(
  resolve(
    root,
    "packages/db/prisma/migrations/20260907120000_platform_egress_fence_readiness/migration.sql",
  ),
  "utf8",
);
const reopenMigration = readFileSync(
  resolve(
    root,
    "packages/db/prisma/migrations/20261101010000_platform_egress_fence_reopen/migration.sql",
  ),
  "utf8",
);

test("platform egress fence migration creates durable generation and attempt state", () => {
  assert.match(migration, /CREATE TABLE "platform_egress_schedule_fence"/u);
  assert.match(migration, /CREATE TABLE "platform_egress_attempt"/u);
  assert.match(
    migration,
    /ALTER TABLE "platform_egress_schedule_fence" ENABLE ROW LEVEL SECURITY/u,
  );
  assert.match(
    migration,
    /ALTER TABLE "platform_egress_schedule_fence" FORCE ROW LEVEL SECURITY/u,
  );
  assert.match(
    migration,
    /ALTER TABLE "platform_egress_attempt" FORCE ROW LEVEL SECURITY/u,
  );
  assert.match(migration, /platform_egress_attempt_authority_operation_key/u);
  assert.match(migration, /platform_egress_attempt_run_operation_key/u);
  assert.match(migration, /"workflow_id" VARCHAR\(200\) NOT NULL/u);
  assert.match(
    migration,
    /authority\.workflow_id IS DISTINCT FROM p_workflow_id/u,
  );
  assert.match(
    migration,
    /attempt\.workflow_id IS DISTINCT FROM p_workflow_id/u,
  );
  assert.match(
    migration,
    /attempt\.operation_key IS DISTINCT FROM p_operation_key/u,
  );
  assert.match(
    migration,
    /generation = platform_egress_schedule_fence\.generation \+ 1/u,
  );
});

test("only the platform writer receives dispatch lifecycle functions", () => {
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION authorize_platform_egress_v1/u,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION[\s\S]*claim_platform_egress_send_v1/u,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION[\s\S]*acknowledge_platform_egress_v1/u,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION[\s\S]*mark_unknown_platform_egress_v1/u,
  );
  assert.match(migration, /TO execution_budget_platform_writer/u);
  assert.doesNotMatch(
    migration,
    /GRANT EXECUTE ON FUNCTION fence_platform_schedule_v1/u,
  );
  assert.match(
    migration,
    /REVOKE ALL ON "platform_egress_schedule_fence", "platform_egress_attempt"[\s\S]*execution_budget_platform_writer/u,
  );
  assert.match(migration, /state = 'UNKNOWN'/u);
  assert.match(migration, /state = 'AUTHORIZED'/u);
  assert.match(migration, /state = 'SENDING'/u);
});

test("fence generation hardening is writer-only and checks the caller principal", () => {
  assert.match(
    privilegeHardeningMigration,
    /PERFORM assert_execution_budget_platform_writer_principal\(\)/u,
  );
  assert.match(
    privilegeHardeningMigration,
    /REVOKE ALL ON FUNCTION fence_platform_schedule_v1\(TEXT, TEXT\)[\s\S]*FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,\s+execution_budget_platform_writer/u,
  );
  assert.match(
    privilegeHardeningMigration,
    /GRANT EXECUTE ON FUNCTION fence_platform_schedule_v1\(TEXT, TEXT\)[\s\S]*TO execution_budget_platform_writer/u,
  );
});

test("fence functions reject stale generations and preserve unknown no-redispatch state", () => {
  assert.match(
    migration,
    /attempt\.generation IS DISTINCT FROM fence\.generation/u,
  );
  assert.match(migration, /attempt\.state <> 'AUTHORIZED'/u);
  assert.match(migration, /state = 'BLOCKED'/u);
  assert.match(migration, /state = 'UNKNOWN'/u);
  assert.match(migration, /existing\.state = 'UNKNOWN'/u);
  assert.match(migration, /existing\.state = 'ACKNOWLEDGED'/u);
  assert.match(migration, /PLATFORM_EGRESS_OUTCOME_CONFLICT/u);
  assert.match(migration, /PLATFORM_EGRESS_OUTCOME_INVALID/u);
});

test("egress fence readiness uses a writer-only read-only capability probe", () => {
  assert.match(
    readinessMigration,
    /CREATE OR REPLACE FUNCTION inspect_platform_egress_fence_v1\(\s*p_schedule_id TEXT\s*\)/u,
  );
  assert.match(readinessMigration, /SECURITY DEFINER/u);
  assert.match(
    readinessMigration,
    /assert_execution_budget_platform_writer_principal\(\)/u,
  );
  assert.match(readinessMigration, /has_function_privilege\(\s*session_user/u);
  assert.match(readinessMigration, /public\.platform_egress_schedule_fence/u);
  assert.match(
    readinessMigration,
    /REVOKE ALL ON FUNCTION inspect_platform_egress_fence_v1\(TEXT\)[\s\S]*FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,/u,
  );
  assert.match(
    readinessMigration,
    /GRANT EXECUTE ON FUNCTION inspect_platform_egress_fence_v1\(TEXT\)[\s\S]*TO execution_budget_platform_writer/u,
  );
});

test("fence reopen is an owner-only operator transition with no runtime grant", () => {
  assert.match(
    reopenMigration,
    /CREATE FUNCTION public\.reopen_platform_egress_fence_v1\(\s*p_schedule_id TEXT,/u,
  );
  assert.match(
    reopenMigration,
    /SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp/u,
  );
  assert.match(reopenMigration, /PLATFORM_EGRESS_REOPEN_PRINCIPAL_INVALID/u);
  assert.match(
    reopenMigration,
    /current_setting\('role', true\) IS DISTINCT FROM 'none'/u,
  );
  assert.match(reopenMigration, /pg_get_userbyid\(p\.proowner\)/u);
  assert.match(
    reopenMigration,
    /REVOKE ALL ON FUNCTION public\.reopen_platform_egress_fence_v1\(TEXT,BIGINT,BIGINT,TEXT,UUID,UUID,TEXT,TEXT\)[\s\S]*FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay,\s+execution_budget_platform_writer, runtime_platform_worker/u,
  );
  assert.doesNotMatch(
    reopenMigration,
    /GRANT EXECUTE ON FUNCTION public\.reopen_platform_egress_fence_v1/u,
  );
});

test("fence reopen pairs the disabled fence to one revocation receipt and advances generation", () => {
  assert.match(reopenMigration, /revocation_receipt_id UUID NOT NULL/u);
  assert.match(
    reopenMigration,
    /FOREIGN KEY \(revocation_receipt_id\) REFERENCES public\.platform_revocation_receipt\(id\)/u,
  );
  assert.match(
    reopenMigration,
    /revocation\.schedule_id IS DISTINCT FROM p_schedule_id/u,
    /revocation\.fence_sequence IS DISTINCT FROM p_fence_sequence/u,
  );
  assert.match(
    reopenMigration,
    /revocation\.fence_sequence IS DISTINCT FROM fence\.fence_sequence/u,
  );
  assert.match(
    reopenMigration,
    /revocation\.generation IS DISTINCT FROM fence\.generation/u,
  );
  assert.match(
    reopenMigration,
    /fence\.generation IS DISTINCT FROM p_expected_generation/u,
  );
  assert.match(reopenMigration, /PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE/u);
  assert.match(reopenMigration, /PLATFORM_EGRESS_REOPEN_GENERATION_CONFLICT/u);
  assert.match(reopenMigration, /PLATFORM_EGRESS_REOPEN_REASON_MISMATCH/u);
  assert.match(reopenMigration, /fence\.state <> 'DISABLED'/u);
  assert.match(
    reopenMigration,
    /SET generation = f\.generation \+ 1,\s+state = 'ACTIVE'/u,
  );
  assert.doesNotMatch(
    reopenMigration,
    /UPDATE public\.platform_egress_schedule_fence f\s+SET[^;]*fence_sequence/su,
  );
  assert.match(reopenMigration, /REOPEN_GENERATION_ADVANCED/u);
});

test("fence reopen reason codes correspond to the revocation reason", () => {
  assert.match(
    reopenMigration,
    /WHEN 'POLICY_DISABLED' THEN 'POLICY_REENABLED'/u,
  );
  assert.match(
    reopenMigration,
    /WHEN 'SECURITY_RESPONSE' THEN 'SECURITY_CLEARED'/u,
  );
  assert.match(reopenMigration, /WHEN 'OPERATOR_HOLD' THEN 'HOLD_RELEASED'/u);
  assert.doesNotMatch(
    reopenMigration,
    /UPDATE public\.platform_egress_schedule_fence f\s+SET[^;]*(policy_artifact_sha256|execution_envelope_sha256|required_cap_microusd)/su,
  );
});

test("fence reopen audit is append-only, FORCE RLS and privilege self-checked", () => {
  assert.match(
    reopenMigration,
    /CREATE TABLE public\.platform_egress_fence_reopen_receipt/u,
  );
  assert.match(
    reopenMigration,
    /ALTER TABLE public\.platform_egress_fence_reopen_receipt ENABLE ROW LEVEL SECURITY/u,
  );
  assert.match(
    reopenMigration,
    /ALTER TABLE public\.platform_egress_fence_reopen_receipt FORCE ROW LEVEL SECURITY/u,
  );
  assert.match(
    reopenMigration,
    /BEFORE UPDATE OR DELETE ON public\.platform_egress_fence_reopen_receipt/u,
  );
  assert.match(
    reopenMigration,
    /BEFORE TRUNCATE ON public\.platform_egress_fence_reopen_receipt/u,
  );
  assert.match(reopenMigration, /PLATFORM_EGRESS_REOPEN_RECEIPT_IMMUTABLE/u);
  assert.match(reopenMigration, /UNIQUE \(reopen_jti\)/u);
  assert.match(reopenMigration, /UNIQUE \(schedule_id, fence_sequence\)/u);
  assert.match(reopenMigration, /PLATFORM_EGRESS_REOPEN_PRIVILEGE_DRIFT/u);
  assert.match(
    reopenMigration,
    /PLATFORM_EGRESS_REOPEN_TABLE_PRIVILEGE_DRIFT/u,
  );
  assert.match(reopenMigration, /PLATFORM_EGRESS_REOPEN_OWNER_RLS_INVALID/u);
  assert.match(
    reopenMigration,
    /has_function_privilege\(role_name, fn_signature, 'EXECUTE'\)/u,
  );
  assert.match(
    reopenMigration,
    /has_table_privilege\(role_name, 'public\.platform_egress_fence_reopen_receipt',\s+'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'\)/u,
  );
});
