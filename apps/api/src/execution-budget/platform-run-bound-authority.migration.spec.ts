import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
  '../../../../packages/db/prisma/migrations/20260905193000_platform_execution_run_binding/migration.sql',
  import.meta.url,
);

describe('platform execution run-bound authority migration', () => {
  it('adds nullable immutable run binding columns without fabricating historical values', async () => {
    const sql = await readFile(migration, 'utf8');

    for (const column of [
      'schedule_request_sha256',
      'workflow_id',
      'workflow_run_id',
      'technical_policy_revision',
    ]) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN \\"${column}\\"`, 'i'));
    }
    expect(sql).not.toMatch(/UPDATE\s+"execution_budget_authority"/i);
    expect(sql).not.toMatch(/DEFAULT\s+['"][0-9a-f]/i);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it('creates one successor primitive that ingests and admits the exact signed run atomically', async () => {
    const sql = await readFile(migration, 'utf8');

    expect(sql).toContain(
      'CREATE FUNCTION ingest_and_admit_platform_execution_budget_run_v2',
    );
    expect(sql).toContain(
      'assert_execution_budget_platform_writer_principal()',
    );
    expect(sql).toContain("'execution-budget-jti:'");
    expect(sql).toContain("'platform-workflow-run:'");
    expect(sql).toContain("'authorized-tool-budget:platform:'");
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('attest_authorized_tool_budget_v1');
    expect(sql).toContain('open_authorized_tool_budget_v1');
    expect(sql).toContain('cannot increase either runs_consumed or ref_count');
    expect(sql).toContain('p_expected_workflow_id');
    expect(sql).toContain('p_expected_workflow_run_id');
    expect(sql).toContain('p_expected_schedule_request_sha256');
    expect(sql).toContain('p_expected_technical_policy_revision');
    expect(sql).toContain('p_max_runs IS DISTINCT FROM 1');
    expect(sql).toContain(
      'p_campaign_cap_microusd IS DISTINCT FROM p_cap_per_run_microusd',
    );
  });

  it('removes every legacy platform writer path that could create or admit an unbound run', async () => {
    const sql = await readFile(migration, 'utf8');

    for (const signature of [
      'ingest_platform_execution_authority(',
      'admit_platform_execution_budget_run_v1(',
      'open_authorized_tool_budget_v1(',
      'open_tool_budget(',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE EXECUTE ON FUNCTION\\s+${signature.replace('(', '\\(')}`,
          'i',
        ),
      );
    }
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+ingest_and_admit_platform_execution_budget_run_v2[\s\S]*TO execution_budget_platform_writer/i,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION\s+ingest_and_admit_platform_execution_budget_run_v2[\s\S]*TO\s+(?:PUBLIC|app_user|runtime_api|runtime_worker|runtime_outbox_relay)/i,
    );
  });

  it('keeps a fixed SECURITY DEFINER search path and bounded migration locks', async () => {
    const sql = await readFile(migration, 'utf8');

    expect(sql).toMatch(/^--[^]*?\nBEGIN;\n/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s';");
    expect(sql).toMatch(
      /SECURITY DEFINER\s+SET search_path = pg_catalog, public/,
    );
  });
});
