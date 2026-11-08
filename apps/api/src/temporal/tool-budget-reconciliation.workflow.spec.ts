import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { toolBudgetReconciliationWorkflow } from './tool-budget-reconciliation.workflow';

const WS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

beforeEach(() => {
  resetActivities();
});

/**
 * B4（审计 F1）：未结预算操作的独立清收 sweep——RESERVED 释放 + RESULT_UNKNOWN 保守结清，
 * 单 workspace 失败不阻塞其余，全失败不静默绿。
 */
describe('toolBudgetReconciliationWorkflow（B4）', () => {
  it('枚举未结 workspace 并逐个执行两种清收，聚合计数', async () => {
    acts.listWorkspacesWithUnresolvedToolBudget.mockResolvedValue({ workspaceIds: WS });
    acts.drainStaleToolBudgetReservations.mockResolvedValue({ released: 3, remaining: false });
    acts.settleUnknownToolBudgetOperations.mockResolvedValue({ settled: 2, remaining: false });

    await expect(toolBudgetReconciliationWorkflow()).resolves.toEqual({
      workspaces: 2,
      released: 6,
      settledUnknown: 4,
      failed: 0,
    });
    expect(acts.listWorkspacesWithUnresolvedToolBudget).toHaveBeenCalledWith({
      olderThanHours: 2,
      limit: 50,
    });
    expect(acts.drainStaleToolBudgetReservations).toHaveBeenCalledTimes(2);
    expect(acts.settleUnknownToolBudgetOperations).toHaveBeenCalledTimes(2);
  });

  it('游标翻页：满页继续、以最后 workspace 为游标、不满页即停（防饿死）', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const page2 = ['ffffffff-ffff-4fff-8fff-ffffffffffff'];
    acts.listWorkspacesWithUnresolvedToolBudget
      .mockResolvedValueOnce({ workspaceIds: page1 })
      .mockResolvedValueOnce({ workspaceIds: page2 });
    acts.drainStaleToolBudgetReservations.mockResolvedValue({ released: 0, remaining: false });
    acts.settleUnknownToolBudgetOperations.mockResolvedValue({ settled: 0, remaining: false });

    await expect(toolBudgetReconciliationWorkflow()).resolves.toMatchObject({ workspaces: 51 });
    expect(acts.listWorkspacesWithUnresolvedToolBudget).toHaveBeenNthCalledWith(1, {
      olderThanHours: 2,
      limit: 50,
    });
    expect(acts.listWorkspacesWithUnresolvedToolBudget).toHaveBeenNthCalledWith(2, {
      olderThanHours: 2,
      limit: 50,
      afterWorkspaceId: page1[49],
    });
  });

  it('阈值是可覆盖的输入（缺省 2 小时）', async () => {
    acts.listWorkspacesWithUnresolvedToolBudget.mockResolvedValue({ workspaceIds: [] });
    await toolBudgetReconciliationWorkflow({ olderThanHours: 6, limit: 5 });
    expect(acts.listWorkspacesWithUnresolvedToolBudget).toHaveBeenCalledWith({
      olderThanHours: 6,
      limit: 5,
    });
  });

  it('单个 workspace 失败不阻塞其余，且释放失败不连带跳过结清', async () => {
    acts.listWorkspacesWithUnresolvedToolBudget.mockResolvedValue({ workspaceIds: [WS[0]] });
    acts.drainStaleToolBudgetReservations.mockRejectedValue(new Error('ledger unavailable'));
    acts.settleUnknownToolBudgetOperations.mockResolvedValue({ settled: 5, remaining: false });

    await expect(toolBudgetReconciliationWorkflow()).resolves.toEqual({
      workspaces: 1,
      released: 0,
      settledUnknown: 5,
      failed: 1,
    });
    // 两个 SINK 相互独立：drain 失败后 settle 仍然执行。
    expect(acts.settleUnknownToolBudgetOperations).toHaveBeenCalledTimes(1);
  });

  it('全部失败以 nonRetryable 暴露（不静默绿）', async () => {
    acts.listWorkspacesWithUnresolvedToolBudget.mockResolvedValue({ workspaceIds: WS });
    acts.drainStaleToolBudgetReservations.mockRejectedValue(new Error('db down'));
    acts.settleUnknownToolBudgetOperations.mockRejectedValue(new Error('db down'));

    await expect(toolBudgetReconciliationWorkflow()).rejects.toMatchObject({
      type: 'TOOL_BUDGET_RECONCILIATION_ALL_FAILED',
    });
  });

  it('没有未结 workspace 时不做任何清收', async () => {
    acts.listWorkspacesWithUnresolvedToolBudget.mockResolvedValue({ workspaceIds: [] });
    await expect(toolBudgetReconciliationWorkflow()).resolves.toEqual({
      workspaces: 0,
      released: 0,
      settledUnknown: 0,
      failed: 0,
    });
    expect(acts.drainStaleToolBudgetReservations).not.toHaveBeenCalled();
  });
});
