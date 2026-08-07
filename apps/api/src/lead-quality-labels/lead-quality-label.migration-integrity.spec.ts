import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  '../../packages/db/prisma/migrations/20260807230000_lead_quality_labels/migration.sql',
);
const schemaPath = resolve(process.cwd(), '../../packages/db/prisma/schema.prisma');

describe('lead_quality_label persistence contract', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  const schema = readFileSync(schemaPath, 'utf8');

  it('creates a workspace-scoped append-only table with source-event idempotency', () => {
    expect(sql).toMatch(/CREATE TABLE "lead_quality_label"/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "lead_quality_label_workspace_id_source_system_source_event_id_key"[\s\S]+"workspace_id", "source_system", "source_event_id"/,
    );
    expect(sql).toMatch(/ALTER TABLE "lead_quality_label" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "lead_quality_label" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /CREATE POLICY "lead_quality_label_tenant_isolation"[\s\S]+USING \("workspace_id" = current_workspace_id\(\)\)[\s\S]+WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(sql).toMatch(/REVOKE UPDATE, DELETE[\s\S]+"lead_quality_label"[\s\S]+FROM app_user/);
    expect(sql).toMatch(/REVOKE TRUNCATE, REFERENCES, TRIGGER[\s\S]+"lead_quality_label"[\s\S]+FROM app_user/);
  });

  it('uses tenant-consistent restrictive foreign keys for Lead and LeadQualified event provenance', () => {
    expect(sql).toMatch(
      /FOREIGN KEY \("lead_id", "workspace_id"\)[\s\S]+REFERENCES "lead"\("id", "workspace_id"\)[\s\S]+ON DELETE RESTRICT/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("lead_qualified_event_id", "workspace_id"\)[\s\S]+REFERENCES "outbox_event"\("event_id", "workspace_id"\)[\s\S]+ON DELETE RESTRICT/,
    );
  });

  it('closes semantic value combinations and models the table in Prisma', () => {
    expect(sql).toContain('lead_quality_label_semantic_fields_check');
    expect(sql).toContain('lead_quality_label_disposition_check');
    expect(schema).toContain('model LeadQualityLabel');
    expect(schema).toContain('@@unique([workspaceId, sourceSystem, sourceEventId]');
  });
});
