import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");
const MIGRATION = resolve(
  ROOT,
  "packages/db/prisma/migrations/20260904190000_site_build_provider_wire_authority/migration.sql",
);
const SCHEMA = resolve(ROOT, "packages/db/prisma/schema.prisma");

describe("site build provider physical-wire authority migration", () => {
  it("adds a positive-discriminator wire and append-only probe model without backfill", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const schema = readFileSync(SCHEMA, "utf8");

    expect(sql).toContain('CREATE TABLE "site_build_provider_wire_attempt"');
    expect(sql).toContain('CREATE TABLE "site_build_provider_readback_probe"');
    expect(sql).toContain('CREATE TABLE "site_build_provider_wire_receipt"');
    expect(sql).toContain('UNIQUE ("spend_id", "physical_wire_attempt")');
    expect(sql).toContain('UNIQUE ("settlement_request_id")');
    expect(sql).toContain('UNIQUE ("wire_attempt_id", "sequence")');
    expect(sql).toContain('"physical_wire_attempt" IN (1, 2)');
    expect(sql).toContain('"sequence" IN (1, 2)');
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).not.toMatch(
      /INSERT\s+INTO\s+"site_build_provider_wire_attempt"\s+SELECT/iu,
    );
    expect(sql).not.toMatch(/UPDATE\s+"site_build_spend"\s+SET\s+.*wire/isu);
    expect(schema).toContain("model SiteBuildProviderWireAttempt");
    expect(schema).toContain("model SiteBuildProviderReadbackProbe");
  });

  it("routes new model reservations through a successor and denies the legacy model path", () => {
    const sql = readFileSync(MIGRATION, "utf8");

    expect(sql).toContain(
      "ALTER FUNCTION reserve_site_build_spend(UUID, UUID, UUID, UUID, VARCHAR, TEXT, TEXT, TEXT, BIGINT, JSONB)",
    );
    expect(sql).toContain("RENAME TO reserve_site_build_spend_legacy_20260904");
    expect(sql).toContain("CREATE FUNCTION reserve_site_build_model_spend_v1(");
    expect(sql).toContain("IF p_kind = 'model'");
    expect(sql).toContain("MODEL_WIRE_AUTHORITY_REQUIRED");
    expect(sql).toContain("p_actual_max_output_tokens");
    expect(sql).toContain("p_maximum_wire_calls");
    expect(sql).toContain("p_settlement_request_id");
    expect(sql).toContain("p_settlement_nonce_sha256");
    expect(sql).toContain(
      "CREATE FUNCTION allocate_site_build_provider_wire_v1(",
    );
  });

  it("returns persisted wire identity across active-key rotation", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const reserve = sql.slice(
      sql.indexOf("CREATE FUNCTION reserve_site_build_model_spend_v1("),
      sql.indexOf("CREATE FUNCTION allocate_site_build_provider_wire_v1("),
    );
    const allocate = sql.slice(
      sql.indexOf("CREATE FUNCTION allocate_site_build_provider_wire_v1("),
      sql.indexOf("CREATE FUNCTION begin_site_build_provider_wire_v1("),
    );

    for (const column of [
      "wire_derivation_key_id",
      "wire_settlement_request_id",
      "wire_settlement_nonce_sha256",
    ]) {
      expect(reserve).toContain(column);
      expect(allocate).toContain(column);
    }
    expect(reserve).not.toMatch(
      /v_wire\."(?:derivation_key_id|settlement_request_id|settlement_nonce_sha256)"\s+IS DISTINCT FROM\s+p_/u,
    );
    expect(allocate).not.toMatch(
      /v_second\."(?:derivation_key_id|settlement_request_id|settlement_nonce_sha256)"\s+IS DISTINCT FROM\s+p_/u,
    );
    expect(allocate).toContain(
      'p_derivation_key_id IS DISTINCT FROM v_first."derivation_key_id"',
    );
  });

  it("uses worker-only security-definer functions for send CAS, probe claim, and observation", () => {
    const sql = readFileSync(MIGRATION, "utf8");

    for (const name of [
      "reserve_site_build_model_spend_v1",
      "allocate_site_build_provider_wire_v1",
      "begin_site_build_provider_wire_v1",
      "claim_site_build_provider_readback_probe_v1",
      "record_site_build_provider_readback_probe_v1",
      "record_site_build_provider_wire_receipt_v1",
      "finalize_site_build_provider_wire_v1",
      "finalize_site_build_provider_wire_from_receipt_v1",
      "finalize_site_build_provider_wire_not_dispatched_v1",
    ]) {
      expect(sql).toContain(`CREATE FUNCTION ${name}(`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${name}`);
    }
    expect(sql).toMatch(
      /SECURITY DEFINER\s+SET search_path = pg_catalog, public/gu,
    );
    expect(sql).toContain(
      "pg_has_role(session_user, 'runtime_worker', 'member')",
    );
    expect(sql).toContain("SITE_BUILD_PROVIDER_WORKER_PRINCIPAL_INVALID");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reserve_site_build_model_spend_v1",
    );
    expect(sql).toContain("TO runtime_worker");
    expect(sql).toContain(
      "FROM PUBLIC, app_user, runtime_api, runtime_outbox_relay",
    );
  });

  it("freezes request context and bounds lifecycle, cardinality, and closed observations", () => {
    const sql = readFileSync(MIGRATION, "utf8");

    expect(sql).toContain("site-build-provider-transport/v1");
    expect(sql).toContain("ALLOCATED");
    expect(sql).toContain("NOT_DISPATCHED");
    expect(sql).toContain("DISPATCH_STARTED");
    expect(sql).toContain("OBSERVED");
    expect(sql).toContain("UNKNOWN");
    expect(sql).toContain("gateway_log_unavailable");
    expect(sql).toContain("database_ack_unknown");
    expect(sql).toContain("MODEL_SETTLEMENT_UNKNOWN");
    expect(sql).toContain("NEW_MODEL_SETTLEMENT_CODE_REQUIRED");
    expect(sql).toContain("physical wire observation count exceeds call count");
    expect(sql).toContain("provider Spend settlement requires runtime_worker");
    expect(sql).toContain('NEW."meta"::text ~*');
    expect(sql).toContain("request[^a-z0-9]*id");
    expect(sql).toContain(
      "requested_alias\" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'",
    );
    expect(sql).toContain('maximum_quota_points" BETWEEN 1 AND 1000000000');
    expect(sql).toContain(
      'input_price_microunits_per_million" BETWEEN 0 AND 500000000000',
    );
    expect(sql).toContain("readback probe count exceeds two");
    expect(sql).toContain("immutable provider wire context mismatch");
    expect(sql).toContain("provider receipt recovery cannot claim payload");
    expect(sql).toContain(
      "RENAME TO reconcile_site_build_spend_legacy_20260904",
    );
    expect(sql).toContain(
      'NOT EXISTS (\n      SELECT 1 FROM "site_build_provider_wire_attempt"',
    );
  });
});
