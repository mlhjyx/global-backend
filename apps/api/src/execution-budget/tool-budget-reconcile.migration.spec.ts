import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 巡检（2026-11-04）迁移的静态契约：按工作区清收超时 RESERVED 工具预算操作的 SECURITY DEFINER
 * 函数。行为（app_user + workspace 上下文调用、释放后账户额度回补、fresh RESERVED 不受影响）
 * 由一次性库实测与真实 sweep 运行覆盖；这里锁住安全形状。
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261104220000_tool_budget_operation_reconcile';

function topLevelStatements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('tool-budget stale reservation reconcile migration (2026-11-04)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('runs additively in one bounded transaction', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    // 函数体之外不允许出现顶层数据变更（更新只发生在清收函数内部）。
    const outsideFunctions = sql.replace(/\$\$[\s\S]*?\$\$/gu, '');
    expect(outsideFunctions).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
    expect(outsideFunctions).toMatch(/CREATE FUNCTION reconcile_stale_tool_budget_operations_v1/u);
  });

  it('guards the function like the other SECURITY DEFINER sweeps', () => {
    expect(sql).toContain("session_user IS DISTINCT FROM 'app_user'");
    expect(sql).toContain('current_user IS NOT DISTINCT FROM session_user');
    expect(sql).toContain("current_setting('role', true) IS DISTINCT FROM 'none'");
    expect(sql).toContain('p_workspace_id IS DISTINCT FROM current_workspace_id()');
    expect(sql).toContain('p_older_than_hours NOT BETWEEN 1 AND 720');
    expect(sql).toContain('p_limit NOT BETWEEN 1 AND 1000');
    // pg_temp 必须显式排在最后（hardening 迁移 20261009160000 的守卫）。
    expect(sql).toContain('SET search_path = pg_catalog, public, pg_temp');
  });

  it('releases exactly the stale RESERVED rows and hands the reservation back to the account', () => {
    expect(sql).toContain('"status" = \'RELEASED\'');
    expect(sql).toContain('"observed_microusd" = 0');
    expect(sql).toContain('"charged_microusd" = 0');
    expect(sql).toContain('"reserved_microusd" = account."reserved_microusd" - candidate."reserved_microusd"');
    expect(sql).toContain("operation.\"status\" = 'RESERVED'");
    expect(sql).toContain("operation.\"created_at\" < authoritative_now - make_interval(hours => p_older_than_hours)");
    expect(sql).toContain('FOR UPDATE OF operation SKIP LOCKED');
    expect(sql).toContain("'tool-budget-account:' || p_workspace_id::text || ':' || candidate.\"account_key\"");
  });

  it('exposes the function only to app_user', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION reconcile_stale_tool_budget_operations_v1/u);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION reconcile_stale_tool_budget_operations_v1\(\s*UUID, INTEGER, INTEGER\s*\) TO app_user/u);
  });
});
