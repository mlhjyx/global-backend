import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '../..');
const migrationPath = resolve(
  repoRoot,
  'packages/db/prisma/migrations/20260822203000_execution_budget_account_attestation/migration.sql',
);

const postAdmissionCallers = [
  'apps/api/src/temporal/discovery.activities.ts',
  'apps/api/src/temporal/understanding.activities.ts',
  'apps/api/src/discovery/taxonomy-resolver.ts',
  'apps/api/src/icp/icp-budget-execution.ts',
  'apps/api/src/intent/intent-projection.service.ts',
  'apps/api/src/discovery/discovery.service.ts',
] as const;

describe('workspace authority post-admission lifecycle', () => {
  it('attests every post-admission caller and never reopens the holder account', async () => {
    const sources = await Promise.all(
      postAdmissionCallers.map(async (path) => ({
        path,
        source: await readFile(resolve(repoRoot, path), 'utf8'),
      })),
    );

    for (const { path, source } of sources) {
      expect(source, path).toContain('.attestAuthorized(');
      expect(source, path).not.toContain('.openAuthorized(');
    }
  });

  it('keeps attestation read-only while preserving expiry, revocation, scope, exhaustion and single-holder checks', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const body = sql.slice(
      sql.indexOf('CREATE FUNCTION attest_authorized_tool_budget_v1'),
      sql.indexOf('REVOKE ALL ON FUNCTION'),
    );

    expect(body).toContain('execution_budget_authority_time_state');
    expect(body).toContain("time_state = 'EXPIRED'");
    expect(body).toContain('EXECUTION_BUDGET_AUTHORITY_REVOKED');
    expect(body).toContain('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    expect(body).toContain('EXECUTION_BUDGET_AUTHORITY_EXHAUSTED');
    expect(body).toContain('account."ref_count" IS DISTINCT FROM 1');
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(body).not.toContain('open_authorized_tool_budget_v1');
  });
});
