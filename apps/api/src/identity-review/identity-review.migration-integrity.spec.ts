import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../packages/db/prisma/migrations/20260808120000_identity_resolution_decisions/migration.sql",
  ),
  "utf8",
);
const schema = readFileSync(
  resolve(process.cwd(), "../../packages/db/prisma/schema.prisma"),
  "utf8",
);

describe("identity resolution decision migration contract", () => {
  it("creates the closed four-decision append-only model", () => {
    expect(migration).toContain('CREATE TYPE "identity_resolution_decision_kind"');
    for (const decision of [
      "AUTO_LINK",
      "REVIEW_LINK",
      "REJECT_LINK",
      "SPLIT",
    ]) {
      expect(migration).toContain(`'${decision}'`);
    }
    expect(migration).toContain('CREATE TABLE "identity_resolution_decision"');
    expect(schema).toContain("model IdentityResolutionDecision");
    expect(schema).toContain("enum IdentityResolutionDecisionKind");
  });

  it("binds source and optional target canonical IDs to the same workspace without cascade", () => {
    expect(migration).toMatch(
      /FOREIGN KEY \("canonical_company_id", "workspace_id"\)[\s\S]+REFERENCES "canonical_company"\("id", "workspace_id"\)[\s\S]+ON DELETE RESTRICT ON UPDATE NO ACTION/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("linked_canonical_company_id", "workspace_id"\)[\s\S]+REFERENCES "canonical_company"\("id", "workspace_id"\)[\s\S]+ON DELETE RESTRICT ON UPDATE NO ACTION/,
    );
    expect(migration).toContain("identity_resolution_decision_no_self_link_check");
    expect(migration).not.toMatch(
      /identity_resolution_decision[\s\S]+ON DELETE CASCADE/,
    );
    expect(schema).toContain(
      '@@unique([id, workspaceId], map: "canonical_company_id_workspace_key")',
    );
  });

  it("validates rule versions, evidence references, and actor/action combinations in PostgreSQL", () => {
    expect(migration).toContain("identity_resolution_evidence_refs_valid");
    expect(migration).toContain("jsonb_array_elements");
    expect(migration).toContain("identity_resolution_decision_rule_version_check");
    expect(migration).toContain("identity_resolution_decision_actor_check");
    expect(migration).toContain("identity_resolution_decision_link_semantics_check");
    expect(migration).toMatch(/"evidence_refs" JSONB NOT NULL/);
    expect(migration).toMatch(/"actor_id" VARCHAR\(255\) NOT NULL/);
    expect(migration).toMatch(/"decided_at" TIMESTAMP\(3\) NOT NULL/);
  });

  it("forces tenant RLS and gives app_user SELECT/INSERT only", () => {
    expect(migration).toMatch(
      /ALTER TABLE "identity_resolution_decision" ENABLE ROW LEVEL SECURITY/,
    );
    expect(migration).toMatch(
      /ALTER TABLE "identity_resolution_decision" FORCE ROW LEVEL SECURITY/,
    );
    expect(migration).toMatch(
      /USING \("workspace_id" = current_workspace_id\(\)\)[\s\S]+WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE "identity_resolution_decision" TO app_user/,
    );
    expect(migration).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER[\s\S]+FROM app_user/,
    );
  });

  it("rejects UPDATE/DELETE even through an owner path and never rewrites canonical companies", () => {
    expect(migration).toContain("reject_identity_resolution_decision_mutation");
    expect(migration).toMatch(
      /BEFORE UPDATE OR DELETE ON "identity_resolution_decision"/,
    );
    expect(migration).not.toMatch(/UPDATE\s+"canonical_company"/);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"canonical_company"/);
  });
});
