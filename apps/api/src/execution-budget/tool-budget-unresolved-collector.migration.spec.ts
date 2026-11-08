import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B4：清收迁移的静态契约（同 tool-budget-reconcile.migration.spec 的先例）。
 * 资金函数的守卫、授权、锁序与阈值口径在纯单测里看不见——钉住迁移文本，改错即红。
 */
const sql = readFileSync(
  join(
    import.meta.dirname,
    '../../../../packages/db/prisma/migrations/20261108150000_tool_budget_unresolved_collector/migration.sql',
  ),
  'utf8',
);

describe('B4 未结预算清收迁移的静态契约', () => {
  it('新增 unresolved_since 列、回填旧行并由触发器在状态迁移时重置', () => {
    expect(sql).toContain('ADD COLUMN "unresolved_since"');
    expect(sql).toContain('UPDATE public."tool_budget_operation"');
    expect(sql).toContain('touch_tool_budget_operation_unresolved_since_v1');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF "status"');
  });

  it('三个函数都要求 app_user 上下文与参数范围（含 NULL），SECURITY DEFINER + pg_temp 最后', () => {
    for (const name of [
      'list_workspaces_with_unresolved_tool_budget_v1',
      'reconcile_stale_tool_budget_operations_v2',
      'settle_unknown_tool_budget_operations_v1',
    ]) {
      expect(sql).toContain(name);
    }
    expect(sql.split("session_user IS DISTINCT FROM 'app_user'").length - 1).toBe(3);
    expect(sql.split('p_limit IS NULL').length - 1).toBeGreaterThanOrEqual(3);
    expect(sql.split('SET search_path = pg_catalog, public, pg_temp').length - 1).toBe(4);
    expect(sql.split('REVOKE ALL ON FUNCTION').length - 1).toBeGreaterThanOrEqual(4);
  });

  it('只处理 microusd 行（cent 遗留行不得毒化整批）', () => {
    expect(sql.split(`"amount_unit" = 'microusd'`).length - 1).toBeGreaterThanOrEqual(6);
  });

  it('锁序与在线路径一致：先按账户 advisory、后锁 op 行', () => {
    const settle = sql.slice(sql.indexOf('CREATE FUNCTION settle_unknown_tool_budget_operations_v1'));
    const advisoryAt = settle.indexOf('pg_advisory_xact_lock');
    const rowLockAt = settle.indexOf('FOR UPDATE SKIP LOCKED');
    expect(advisoryAt).toBeGreaterThanOrEqual(0);
    expect(rowLockAt).toBeGreaterThan(advisoryAt);
  });

  it('枚举带游标（防饿死）且只收租户 UUID 作用域', () => {
    expect(sql).toContain('p_after_workspace_id UUID DEFAULT NULL');
    expect(sql).toContain('p_after_workspace_id IS NULL OR');
    expect(sql).toContain(`"scope_key" ~ '^[0-9a-f]{8}-`);
  });

  it('RESULT_UNKNOWN 按预留额结清（observed=charged=reserved）并同步账户双列', () => {
    expect(sql).toContain('"observed_microusd" = candidate."reserved_microusd"');
    expect(sql).toContain('"charged_microusd" = candidate."reserved_microusd"');
    expect(sql).toContain('"reserved_microusd" = account."reserved_microusd" - candidate."reserved_microusd"');
    expect(sql).toContain('"charged_microusd" = account."charged_microusd" + candidate."reserved_microusd"');
  });
});
