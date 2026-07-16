import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function migration(relativePath: string): Buffer {
  return readFileSync(
    fileURLToPath(
      new URL(
        `../../../../packages/db/prisma/migrations/${relativePath}`,
        import.meta.url,
      ),
    ),
  );
}

describe("R2-A3 migration integrity", () => {
  it("restores the idempotency migration to the exact bytes first applied to shared dev", () => {
    expect(
      createHash("sha256")
        .update(
          migration("20260716191000_idempotency_request_hash/migration.sql"),
        )
        .digest("hex"),
    ).toBe("c934c5699988f08f0571edd212657f6705eb08bab699784e6344e3c8217bf64d");
  });

  it("adds one UUID profile CAS token without weakening Site RLS", () => {
    const sql = migration(
      "20260717030000_site_builder_profile_version/migration.sql",
    ).toString("utf8");
    expect(sql).toContain(
      '"profile_version_id" UUID NOT NULL DEFAULT gen_random_uuid()',
    );
    expect(sql).not.toMatch(
      /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i,
    );
  });
});
