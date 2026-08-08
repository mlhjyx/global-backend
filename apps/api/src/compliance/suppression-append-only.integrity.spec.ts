import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = resolve(__dirname, '../..');
const repoRoot = resolve(apiRoot, '../..');

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('suppression append-only database and writer integrity', () => {
  it('revokes ordinary app UPDATE/DELETE and makes release decisions append-only with RLS', () => {
    const migration = source(
      'packages/db/prisma/migrations/20260807234500_suppression_release_governance/migration.sql',
    );
    expect(migration).toMatch(
      /REVOKE\s+UPDATE\s*,\s*DELETE\s+ON\s+(?:TABLE\s+)?"suppression_record"\s+FROM\s+app_user/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE "suppression_release_decision" ENABLE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE "suppression_release_decision" FORCE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /REVOKE\s+UPDATE\s*,\s*DELETE\s*,\s*TRUNCATE[^;]*"suppression_release_decision"[^;]*app_user/i,
    );
  });

  it('contains no application hard-delete or update/upsert path for suppression records', () => {
    const discovery = source('apps/api/src/discovery/discovery.service.ts');
    const deletion = source('apps/api/src/temporal/deletion.activities.ts');
    expect(discovery).not.toMatch(/suppressionRecord\.delete\s*\(/);
    expect(discovery).not.toMatch(/suppressionRecord\.upsert\s*\(/);
    expect(deletion).not.toMatch(/suppressionRecord\.upsert\s*\(/);
  });
});
