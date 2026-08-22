import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
  '../../../../packages/db/prisma/migrations/20260822210000_platform_schedule_authority/migration.sql',
  import.meta.url,
);

describe('platform schedule authority database cutover', () => {
  it('admits or read-only reattests one exact run under the platform writer principal', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain('CREATE FUNCTION admit_platform_execution_budget_run_v1');
    expect(sql).toContain('assert_execution_budget_platform_writer_principal()');
    expect(sql).toContain('attest_authorized_tool_budget_v1');
    expect(sql).toContain('open_authorized_tool_budget_v1');
    expect(sql).toContain('campaign_cap_microusd');
    expect(sql).toContain('max_runs');
    expect(sql).not.toMatch(/GRANT[\s\S]*TO\s+(?:app_user|PUBLIC)/i);
  });

  it('does not persist or accept a compact JWS', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).not.toMatch(/compact.?jws|raw.?jws|authorization/i);
  });
});
