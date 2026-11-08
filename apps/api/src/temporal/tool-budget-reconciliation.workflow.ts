import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';

import type { ToolBudgetReconciliationActivities } from './tool-budget-reconciliation.activities';

/**
 * B4（审计 F1）：未结预算操作的独立清收 sweep（客户侧 sweep 调度器，默认每小时）。
 *
 * 枚举「含超期 RESERVED/RESULT_UNKNOWN 的 workspace」→ 逐 workspace：
 *   1) 释放「预留后未出网」的 RESERVED；
 *   2) 按预留额保守结清「已出网结果未知」的 RESULT_UNKNOWN。
 * 单 workspace 失败不阻塞其余；全部失败以 nonRetryable 暴露（不静默绿）。
 * 重放安全：每 workspace 只调一次活动（批内循环在活动/数据库函数里），循环次数由活动
 * 返回的列表长度决定，无 workflow 侧数值常量。
 */
const acts = proxyActivities<
  Pick<
    ToolBudgetReconciliationActivities,
    'listWorkspacesWithUnresolvedToolBudget' | 'drainStaleToolBudgetReservations' | 'settleUnknownToolBudgetOperations'
  >
>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});

export interface ToolBudgetReconciliationInput {
  olderThanHours?: number;
  limit?: number;
}

export interface ToolBudgetReconciliationResult {
  workspaces: number;
  released: number;
  settledUnknown: number;
  failed: number;
}

export async function toolBudgetReconciliationWorkflow(
  input: ToolBudgetReconciliationInput = {},
): Promise<ToolBudgetReconciliationResult> {
  const olderThanHours = input.olderThanHours ?? 2;
  const limit = input.limit ?? 50;
  const { workspaceIds } = await acts.listWorkspacesWithUnresolvedToolBudget({
    olderThanHours,
    limit,
  });
  let released = 0;
  let settledUnknown = 0;
  let failed = 0;
  for (const workspaceId of workspaceIds) {
    try {
      const drain = await acts.drainStaleToolBudgetReservations({ workspaceId, olderThanHours });
      released += drain.released;
      const settle = await acts.settleUnknownToolBudgetOperations({ workspaceId, olderThanHours });
      settledUnknown += settle.settled;
    } catch {
      // 单个 workspace 失败不阻塞其余；幂等的清收会在下一周期重试。
      failed += 1;
    }
  }
  if (workspaceIds.length > 0 && failed === workspaceIds.length) {
    throw ApplicationFailure.nonRetryable(
      `TOOL_BUDGET_RECONCILIATION_ALL_FAILED:${failed}`,
      'TOOL_BUDGET_RECONCILIATION_ALL_FAILED',
    );
  }
  return { workspaces: workspaceIds.length, released, settledUnknown, failed };
}
