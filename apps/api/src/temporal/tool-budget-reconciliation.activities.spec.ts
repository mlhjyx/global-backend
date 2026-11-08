import { describe, expect, it, vi } from 'vitest';

import { createToolBudgetReconciliationActivities } from './tool-budget-reconciliation.activities';

const WS = '11111111-1111-4111-8111-111111111111';

/**
 * B4：清收活动的 SQL 形态与循环语义（fake prisma；SQL 本身由 raw-sql 参数类型门与
 * 一次性 PostgreSQL 验证覆盖）。
 */
describe('tool-budget-reconciliation activities（B4）', () => {
  it('listWorkspacesWithUnresolvedToolBudget 只保留 canonical uuid 的枚举结果', async () => {
    const queryRaw = vi.fn(async () => [
      { workspace_id: WS },
      { workspace_id: 'platform' },
      { workspace_id: 'not-a-uuid' },
    ]);
    const activities = createToolBudgetReconciliationActivities({
      prisma: { $queryRaw: queryRaw },
    } as never);

    await expect(
      activities.listWorkspacesWithUnresolvedToolBudget({ olderThanHours: 2, limit: 50 }),
    ).resolves.toEqual({ workspaceIds: [WS] });
  });

  it('非法游标被丢弃（按第一页处理），不回传进 SQL', async () => {
    const queryRaw = vi.fn(async () => []);
    const activities = createToolBudgetReconciliationActivities({
      prisma: { $queryRaw: queryRaw },
    } as never);

    await activities.listWorkspacesWithUnresolvedToolBudget({
      olderThanHours: 2,
      limit: 50,
      afterWorkspaceId: 'not-a-uuid',
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('drainStaleToolBudgetReservations 循环到 has_more=false 并累计 released', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ released: 2, has_more: true }])
      .mockResolvedValueOnce([{ released: 1, has_more: false }]);
    const activities = createToolBudgetReconciliationActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => unknown) =>
          callback({ $queryRaw: queryRaw }),
        ),
      },
    } as never);

    await expect(
      activities.drainStaleToolBudgetReservations({ workspaceId: WS, olderThanHours: 2 }),
    ).resolves.toEqual({ released: 3, remaining: false });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('settleUnknownToolBudgetOperations 循环到 has_more=false 并累计 settled', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ settled: 4, has_more: true }])
      .mockResolvedValueOnce([{ settled: 0, has_more: false }]);
    const activities = createToolBudgetReconciliationActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => unknown) =>
          callback({ $queryRaw: queryRaw }),
        ),
      },
    } as never);

    await expect(
      activities.settleUnknownToolBudgetOperations({ workspaceId: WS, olderThanHours: 2 }),
    ).resolves.toEqual({ settled: 4, remaining: false });
  });

  it('缺回执时报错（函数未返回行是部署缺陷，不静默吞）', async () => {
    const activities = createToolBudgetReconciliationActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => unknown) =>
          callback({ $queryRaw: vi.fn(async () => []) }),
        ),
      },
    } as never);

    await expect(
      activities.settleUnknownToolBudgetOperations({ workspaceId: WS }),
    ).rejects.toThrow('TOOL_BUDGET_UNKNOWN_SETTLE_NO_RECEIPT');
  });

  it('回执类型异常（null/字符串）同样报错，不被 Number() 静默吞成 0', async () => {
    const activities = createToolBudgetReconciliationActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => unknown) =>
          callback({ $queryRaw: vi.fn(async () => [{ released: null, has_more: 'yes' }]) }),
        ),
      },
    } as never);

    await expect(
      activities.drainStaleToolBudgetReservations({ workspaceId: WS }),
    ).rejects.toThrow('TOOL_BUDGET_RECONCILE_NO_RECEIPT');
  });
});
