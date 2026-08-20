import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../packages/db/prisma/migrations/20260816220000_production_parity_budget_runtime/migration.sql',
  import.meta.url,
);

describe('production parity budget migration integrity', () => {
  it('is one explicit transaction and checks CREATEROLE before schema mutation', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toMatch(/^--[\s\S]*?\nBEGIN;\n/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    const preflight = sql.indexOf('PRODUCTION_PARITY_MIGRATION_REQUIRES_CREATEROLE');
    const firstMutation = sql.indexOf('CREATE TYPE "runtime_process_role"');
    expect(preflight).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(firstMutation);
  });

  it('supersedes UNKNOWN over-reservation handling with known CAP_VARIANCE facts', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('RENAME TO settle_site_build_spend_legacy_20260719');
    expect(sql).toMatch(
      /p_budget_charge_microusd <= v_reservation[\s\S]*?"status" = p_status[\s\S]*?"budget_charge_microusd" = v_spend\."reservation_microusd"[\s\S]*?"result_json" = p_result_json/,
    );
    expect(sql).toContain("'CAP_VARIANCE'");
    expect(sql).toMatch(
      /INSERT INTO "site_build_spend_reconciliation"[\s\S]*?'CONFLICT'[\s\S]*?'site-build-cap-variance-v1'/,
    );
  });

  it('rejects a mismatched workspace before every SECURITY DEFINER spend lookup', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const wrapper = sql.slice(
      sql.indexOf('CREATE FUNCTION settle_site_build_spend('),
      sql.indexOf('-- Cost classification:'),
    );
    const scopeGuard = wrapper.indexOf(
      "IF p_workspace_id IS DISTINCT FROM current_workspace_id() THEN",
    );
    const firstSpendRead = wrapper.indexOf('FROM "site_build_spend"');
    expect(scopeGuard).toBeGreaterThan(0);
    expect(scopeGuard).toBeLessThan(firstSpendRead);
    expect(wrapper).toMatch(
      /FROM "site_build_spend"[\s\S]*?WHERE "workspace_id" = p_workspace_id[\s\S]*?AND "build_run_id" = p_build_run_id/,
    );
    expect(wrapper).toMatch(
      /UPDATE "site_build_spend"[\s\S]*?WHERE "id" = v_spend\."id"[\s\S]*?AND "workspace_id" = p_workspace_id/,
    );
    expect(wrapper).toMatch(
      /UPDATE "site_build_budget"[\s\S]*?WHERE "build_run_id" = p_build_run_id[\s\S]*?AND "workspace_id" = p_workspace_id/,
    );
  });

  it('returns an explicit replay bit from idempotent Tool budget settlement functions', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toMatch(
      /CREATE FUNCTION settle_tool_budget[\s\S]*?RETURNS TABLE\(charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN, status TEXT, replay BOOLEAN\)/,
    );
    expect(sql).toMatch(
      /CREATE FUNCTION release_tool_budget[\s\S]*?RETURNS TABLE\(charged_cents BIGINT, observed_cents BIGINT, cap_variance BOOLEAN, status TEXT, replay BOOLEAN\)/,
    );
  });

  it('keeps an exhausted Tool budget closed to new physical operations while preserving operation replay', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const reserve = sql.slice(
      sql.indexOf('CREATE FUNCTION reserve_tool_budget('),
      sql.indexOf('CREATE FUNCTION settle_tool_budget('),
    );
    const replay = reserve.indexOf("IF o.\"id\" IS NOT NULL THEN RETURN QUERY SELECT 'REPLAY'");
    const exhausted = reserve.indexOf('IF a."exhausted" THEN');
    const insert = reserve.indexOf('INSERT INTO "tool_budget_operation"');
    expect(replay).toBeGreaterThan(-1);
    expect(exhausted).toBeGreaterThan(replay);
    expect(exhausted).toBeLessThan(insert);
    expect(reserve.slice(exhausted, insert)).toContain("'DENIED'");
    expect(reserve.slice(exhausted, insert)).toContain("'EXHAUSTED'");
  });

  it('retains a settled generation across a normal close/reopen so a lost activity ACK cannot re-dispatch providers', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const open = sql.slice(
      sql.indexOf('CREATE FUNCTION open_tool_budget('),
      sql.indexOf('CREATE FUNCTION reserve_tool_budget('),
    );
    const closedAccount = open.slice(
      open.indexOf('ELSIF v."ref_count" = 0 THEN'),
      open.indexOf('ELSIF v."cap_cents" <> p_cap_cents THEN'),
    );
    expect(closedAccount).not.toContain('"generation"=v."generation"+1');
    expect(closedAccount).not.toContain('"charged_cents"=0');
    expect(closedAccount).not.toContain('"exhausted"=false');
    expect(closedAccount).toContain('"ref_count"=1');
  });

  it('locks the Grant database audience to the single product audience', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toMatch(
      /"audience"\s*=\s*'global-backend:site-builder-budget'/,
    );
  });
});
