import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../../..");
const migration = readFileSync(
  path.join(
    repo,
    "packages/db/prisma/migrations/20260717060000_site_builder_r3_run_invariants/migration.sql",
  ),
  "utf8",
);
const backfill = readFileSync(
  path.join(
    repo,
    "packages/db/prisma/migrations/20260717061000_site_builder_r3_workflow_identity_backfill/migration.sql",
  ),
  "utf8",
);
const provenanceHardening = readFileSync(
  path.join(
    repo,
    "packages/db/prisma/migrations/20260717062000_site_builder_r3_provenance_no_cascade/migration.sql",
  ),
  "utf8",
);
const schema = readFileSync(
  path.join(repo, "packages/db/prisma/schema.prisma"),
  "utf8",
);

describe("R3-A SiteBuildRun database invariants", () => {
  it("fails closed before applying ownership, state, or single-flight constraints", () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '60s'");
    expect(migration.indexOf('LOCK TABLE "site_build_run"')).toBeLessThan(
      migration.indexOf("DO $$"),
    );
    expect(migration).toMatch(
      /DO \$\$[\s\S]+site_build_run[\s\S]+workspace_id[\s\S]+RAISE EXCEPTION/,
    );
    expect(migration).toMatch(
      /status NOT IN \('queued', 'running', 'succeeded', 'failed', 'cancelled'\)/,
    );
    expect(migration).toMatch(/GROUP BY site_id[\s\S]+HAVING count\(\*\) > 1/);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"site_build_run"/i);
    expect(migration).not.toMatch(
      /UPDATE\s+"site_build_run"\s+SET\s+"workspace_id"/i,
    );
    expect(migration).not.toMatch(
      /UPDATE\s+"site_build_run"\s+SET\s+"status"/i,
    );
  });

  it("binds tenant provenance, legal states, and one active run per site", () => {
    expect(migration).toContain("site_build_run_site_id_workspace_id_fkey");
    expect(migration).toMatch(
      /FOREIGN KEY \("site_id", "workspace_id"\)[\s\S]+"site"\("id", "workspace_id"\)/,
    );
    expect(migration).toMatch(/ON DELETE CASCADE\s+ON UPDATE NO ACTION/);
    expect(provenanceHardening).toMatch(
      /site_build_run_site_id_workspace_id_fkey[\s\S]+ON UPDATE NO ACTION/,
    );
    expect(provenanceHardening).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toMatch(/site_build_run_status_check[\s\S]+NOT VALID/);
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "site_build_run_status_check"',
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "site_build_run_one_active_per_site_idx"[\s\S]+WHERE "status" IN \('queued', 'running'\)/,
    );
  });

  it("adds a nullable workflow identity and deterministic legacy backfill", () => {
    expect(schema).toContain("temporalWorkflowId String?");
    expect(schema).toMatch(
      /site Site @relation\(fields: \[siteId, workspaceId\], references: \[id, workspaceId\][\s\S]+onUpdate: NoAction\)/,
    );
    expect(migration).toContain('ADD COLUMN "temporal_workflow_id" TEXT');
    expect(backfill).toMatch(/kind = 'demo_v0'[\s\S]+site-demo-/);
    expect(backfill).toMatch(/kind = 'refurbish'[\s\S]+site-refurbish-/);
    expect(backfill).not.toMatch(/workspace_id\s*=/);
    expect(backfill).not.toMatch(/status\s*=/);
    expect(migration).not.toMatch(/temporal_workflow_id" TEXT NOT NULL/);
  });
});
