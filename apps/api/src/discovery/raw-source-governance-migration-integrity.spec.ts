import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../packages/db/prisma/migrations/20260814120000_raw_source_governance_disposition/migration.sql",
  ),
  "utf8",
);

describe("permanent Raw governance migration", () => {
  it("is append-only, non-destructive, and exact-key scoped", () => {
    expect(migration).toContain("PERMANENT_RESTRICTION");
    expect(migration).toContain("RESTRICT_PROCESSING");
    expect(migration).toContain("HISTORICAL_USASPENDING_PERSONAL_DATA_FIELDS");
    expect(migration).toContain("#> '{attributes,procurement}'");
    expect(migration).toContain("? 'recipient_name'");
    expect(migration).toContain("? 'description'");
    expect(migration).not.toMatch(
      /(?:UPDATE|DELETE FROM)\s+"?raw_source_record"?/iu,
    );
    expect(migration).not.toContain("->> 'recipient_name'");
    expect(migration).not.toContain("->> 'description'");
    expect(migration).toContain("ON CONFLICT");
  });

  it("restricts application reads and guards every Raw-derived identity table", () => {
    for (const table of [
      "raw_source_record",
      "identity_link",
      "field_evidence",
      "organization_identifier",
      "organization_identity_conflict",
    ]) {
      expect(migration).toContain(`ON "${table}" AS RESTRICTIVE`);
    }
    for (const trigger of [
      "identity_link_restricted_raw_guard",
      "field_evidence_restricted_raw_guard",
      "organization_identifier_restricted_raw_guard",
      "organization_identity_conflict_restricted_raw_guard",
    ]) {
      expect(migration).toContain(trigger);
    }
    expect(migration).toContain(
      "raw source is permanently restricted from downstream processing",
    );
  });

  it("binds immutable decisions to exact Raw provenance", () => {
    for (const marker of [
      "raw_payload_hash",
      "raw_ingest_version",
      "raw_created_at",
      "migration:20260814120000",
      "raw-governance/usaspending-v1",
      "raw source governance dispositions are permanent and append-only",
    ]) {
      expect(migration).toContain(marker);
    }
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain(
      'GRANT SELECT ON TABLE "raw_source_governance_disposition" TO app_user',
    );
  });
});
