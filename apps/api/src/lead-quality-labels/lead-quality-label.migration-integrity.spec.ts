import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "../../packages/db/prisma/migrations/20260807231000_lead_quality_labels/migration.sql",
);
const collidingMigrationPath = resolve(
  process.cwd(),
  "../../packages/db/prisma/migrations/20260807230000_lead_quality_labels/migration.sql",
);
const schemaPath = resolve(
  process.cwd(),
  "../../packages/db/prisma/schema.prisma",
);

describe("lead_quality_label persistence contract", () => {
  const sql = existsSync(migrationPath)
    ? readFileSync(migrationPath, "utf8")
    : "";
  const schema = readFileSync(schemaPath, "utf8");

  it(
    "uses a strictly later migration directory and retires the colliding timestamp",
    () => {
      expect(existsSync(collidingMigrationPath)).toBe(false);
      expect(existsSync(migrationPath)).toBe(true);
    },
  );

  it("creates a workspace-scoped append-only table with source-event idempotency", () => {
    expect(sql).toMatch(/CREATE TABLE "lead_quality_label"/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "lead_quality_label_source_event_key"[\s\S]+"workspace_id", "source_system", "source_event_id"/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "lead_quality_label" ENABLE ROW LEVEL SECURITY/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "lead_quality_label" FORCE ROW LEVEL SECURITY/,
    );
    expect(sql).toMatch(
      /CREATE POLICY "lead_quality_label_tenant_isolation"[\s\S]+USING \("workspace_id" = current_workspace_id\(\)\)[\s\S]+WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(sql).toMatch(
      /REVOKE UPDATE, DELETE[\s\S]+"lead_quality_label"[\s\S]+FROM app_user/,
    );
    expect(sql).toMatch(
      /REVOKE TRUNCATE, REFERENCES, TRIGGER[\s\S]+"lead_quality_label"[\s\S]+FROM app_user/,
    );
  });

  it("uses tenant-consistent restrictive foreign keys for Lead and LeadQualified event provenance", () => {
    expect(sql).toMatch(
      /FOREIGN KEY \("lead_id", "workspace_id"\)[\s\S]+REFERENCES "lead"\("id", "workspace_id"\)[\s\S]+ON DELETE RESTRICT/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("lead_qualified_event_id", "workspace_id"\)[\s\S]+REFERENCES "outbox_event"\("event_id", "workspace_id"\)[\s\S]+ON DELETE RESTRICT/,
    );
    expect(sql).not.toMatch(/lead_quality_label[\s\S]+ON UPDATE CASCADE/);
    expect(schema).toMatch(
      /LeadQualityLabelLead[\s\S]+onDelete: Restrict, onUpdate: NoAction/,
    );
    expect(schema).toMatch(
      /LeadQualityLabelQualifiedEvent[\s\S]+onDelete: Restrict, onUpdate: NoAction/,
    );
  });

  it("enforces exact LeadQualified event type/workspace/aggregate identity against direct app_user inserts", () => {
    expect(sql).toContain("enforce_lead_quality_label_handoff_identity");
    expect(sql).toMatch(
      /event_id" = NEW\."lead_qualified_event_id"[\s\S]+workspace_id" = NEW\."workspace_id"[\s\S]+event_type" = 'LeadQualified'[\s\S]+aggregate_type" = 'Lead'[\s\S]+aggregate_id" = NEW\."lead_id"::text/,
    );
    expect(sql).toMatch(
      /BEFORE INSERT ON "lead_quality_label"[\s\S]+EXECUTE FUNCTION "enforce_lead_quality_label_handoff_identity"/,
    );
    expect(sql).toContain("protect_lead_quality_label_handoff_identity");
    expect(sql).toMatch(/BEFORE UPDATE OF "event_type", "aggregate_type", "aggregate_id"/);
    expect(sql).toMatch(
      /previous_workspace[\s\S]+set_config\('app\.current_workspace_id', NEW\."workspace_id"::text, true\)[\s\S]+set_config\('app\.current_workspace_id', COALESCE\(previous_workspace, ''\), true\)/,
    );
    expect(sql).toMatch(
      /previous_workspace[\s\S]+set_config\('app\.current_workspace_id', OLD\."workspace_id"::text, true\)/,
    );
  });

  it("closes semantic value combinations and models the table in Prisma", () => {
    expect(sql).toContain("lead_quality_label_semantic_fields_check");
    expect(sql).toContain("lead_quality_label_disposition_check");
    expect(sql).toMatch(
      /"ingested_at" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/,
    );
    expect(schema).toContain("model LeadQualityLabel");
    expect(schema).toContain("ingestedAt");
    expect(schema).toContain('@map("ingested_at")');
    expect(schema).toContain(
      "@@unique([workspaceId, sourceSystem, sourceEventId]",
    );
  });
});
