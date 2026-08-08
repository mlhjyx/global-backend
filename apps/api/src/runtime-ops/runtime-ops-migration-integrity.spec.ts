import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(process.cwd(), "../..");
const schemaPath = path.join(repo, "packages/db/prisma/schema.prisma");
const migrationPath = path.join(
  repo,
  "packages/db/prisma/migrations/20260808010000_runtime_ops_evidence/migration.sql",
);

describe("runtime ops evidence migration", () => {
  it("adds fenced signal leases and the three operational evidence models", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).toContain("model WorkflowRunReceipt");
    expect(schema).toContain("model WorkerHeartbeat");
    expect(schema).toContain("model ScheduleDriftReceipt");
    expect(schema).toMatch(/leaseToken\s+String\?/);
    expect(schema).toMatch(/leaseFence\s+Int\s+@default\(0\)/);
    expect(schema).toMatch(/leaseExpiresAt\s+DateTime\?/);
  });

  it("enforces append-only receipts, workspace RLS and a closed signal ingest state machine", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("CHECK (\"status\" IN ('PENDING', 'OK', 'ERROR'))");
    expect(sql).toContain(
      'ALTER TABLE "workflow_run_receipt" ENABLE ROW LEVEL SECURITY',
    );
    expect(sql).toContain(
      'ALTER TABLE "workflow_run_receipt" FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain("current_workspace_id()");
    for (const table of ["workflow_run_receipt", "schedule_drift_receipt"]) {
      expect(sql).toContain(
        `REVOKE UPDATE, DELETE ON TABLE "${table}" FROM app_user`,
      );
    }
    expect(sql).toContain(
      'REVOKE DELETE ON TABLE "signal_ingest" FROM app_user',
    );
    expect(sql).not.toMatch(
      /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i,
    );
  });
});
