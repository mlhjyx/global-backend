import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const schema = readFileSync(resolve(root, 'packages/db/prisma/schema.prisma'), 'utf8');
const readMigration = (): string =>
  readFileSync(
    resolve(root, 'packages/db/prisma/migrations/20260810010000_suppression_decision_governance/migration.sql'),
    'utf8',
  );

describe('suppression decision governance migration', () => {
  it('keeps suppression facts and decisions as separate models', () => {
    expect(schema).toContain('protectionClass String');
    expect(schema).toContain('model SuppressionDecision');
    expect(schema).toContain('@@unique([workspaceId, requestId])');
  });

  it('makes app suppression deletion and decision mutation impossible at the DB privilege layer', () => {
    const migration = readMigration();
    expect(migration).toMatch(/REVOKE DELETE ON TABLE "suppression_record" FROM app_user/);
    expect(migration).toMatch(/GRANT SELECT, INSERT ON TABLE "suppression_decision" TO app_user/);
    expect(migration).toMatch(/REVOKE UPDATE, DELETE ON TABLE "suppression_decision" FROM app_user/);
  });

  it('forces tenant RLS and prevents cross-workspace decision references', () => {
    const migration = readMigration();
    expect(migration).toContain('ALTER TABLE "suppression_decision" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "suppression_decision" FORCE ROW LEVEL SECURITY');
    expect(migration).toMatch(/FOREIGN KEY \("workspace_id", "suppression_id"\)/);
  });
});
