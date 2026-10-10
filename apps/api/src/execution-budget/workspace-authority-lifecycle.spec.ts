import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '../..');
const migrationsRoot = resolve(repoRoot, 'packages/db/prisma/migrations');
const ATTEST_HEADER = /CREATE (?:OR REPLACE )?FUNCTION attest_authorized_tool_budget_v1\(/;

const postAdmissionCallers = [
  'apps/api/src/temporal/discovery.activities.ts',
  'apps/api/src/temporal/understanding.activities.ts',
  'apps/api/src/discovery/taxonomy-resolver.ts',
  'apps/api/src/icp/icp-budget-execution.ts',
  'apps/api/src/intent/intent-projection.service.ts',
  'apps/api/src/discovery/discovery.service.ts',
] as const;

/** The deployed attest is the definition in the last migration that (re)creates it. */
async function latestAttestDefinition(): Promise<string> {
  const directories = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  let latest: string | undefined;
  for (const directory of directories) {
    const sql = await readFile(resolve(migrationsRoot, directory, 'migration.sql'), 'utf8');
    const start = sql.search(ATTEST_HEADER);
    if (start < 0) continue;
    const end = sql.indexOf('\n$$;', start);
    expect(end, directory).toBeGreaterThan(start);
    latest = sql.slice(start, end);
  }
  if (!latest) throw new Error('attest_authorized_tool_budget_v1 is not defined by any migration');
  return latest;
}

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
    const body = await latestAttestDefinition();

    expect(body).toContain('\nSTABLE\nSECURITY DEFINER\n');
    expect(body).toContain('execution_budget_authority_time_state');
    // Post-admission expiry is the admission lease (discovery runs; ICP design and query
    // planning), else the Grant window.
    expect(body).toContain(
      'COALESCE(authority."admission_lease_expires_at", authority."expires_at")',
    );
    expect(body).toContain("time_state = 'EXPIRED'");
    expect(body).toContain('EXECUTION_BUDGET_AUTHORITY_REVOKED');
    expect(body).toContain('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
    expect(body).toContain('EXECUTION_BUDGET_AUTHORITY_EXHAUSTED');
    expect(body).toContain('account."ref_count" IS DISTINCT FROM 1');
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(body).not.toContain('open_authorized_tool_budget_v1');
  });
});
