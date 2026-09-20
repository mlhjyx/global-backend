import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL(
  "../../../../packages/db/prisma/migrations/20260902020000_unknown_spend_reconciliation/migration.sql",
  import.meta.url,
);

describe("UNKNOWN paid-operation migration contract", () => {
  it("adds a scoped atomic UNKNOWN settlement function and corrects only misclassified history", async () => {
    const sql = await readFile(migration, "utf8");

    expect(sql).toContain("CREATE FUNCTION settle_unknown_site_build_spend");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog, public");
    expect(sql).toContain("SET status = 'UNKNOWN'");
    expect(sql).toContain("cost_basis = 'unknown'");
    expect(sql).toContain("result_json = NULL");
    expect(sql).toContain("paid_calls_enabled = false");
    expect(sql).toContain("disabled_reason = p_disable_reason");
    expect(sql).toContain(
      "WHERE s.status = 'FAILED'\n    AND s.cost_basis = 'unknown'",
    );
    expect(sql).toContain("'{operations,failed}'");
    expect(sql).toContain("'{operations,unknown}'");
    expect(sql).toContain("'{reconciliation,pendingOperations}'");
    expect(sql).toContain("'UNKNOWN_SETTLEMENT_BACKFILL'");
    expect(sql).toContain("'{budget,paidCallsEnabled}'");
    expect(sql).toContain("'{budget,disabledReason}'");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO app_user/);
  });
});
